//! Live `SortedTroves` index: queue order, redemption buffer per trove, distribution buckets.
//!
//! Mezo is a Liquity-style CDP: any MUSD holder can redeem 1 MUSD for $1 of BTC against the trove
//! with the *lowest* collateral ratio above the 110% MCR. A borrower at 135% ICR can therefore lose
//! BTC while never being liquidated. Pylon's job is to make that queue visible and to defend against
//! it, so the whole index is built from the live trove set rather than from a fixed list.

use std::sync::Arc;
use std::time::{Duration, Instant};

use alloy_primitives::{Address, U256};
use anyhow::Result;
use serde::Serialize;
use tokio::sync::RwLock;

use crate::mezo::{Mezo, TroveSnapshot};

/// A trove's position in the redemption queue.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub rank: u64,
    pub address: Address,
    pub coll: String,
    pub debt: String,
    pub icr_wad: String,
    pub nicr: String,
    pub redemption_buffer_musd: String,
    pub interest_rate_bps: u16,
    pub liquidatable: bool,
    pub health_label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub bucket: String,
    pub count: u64,
    pub debt: String,
}

#[derive(Clone, Debug)]
pub struct RadarData {
    pub price: U256,
    pub tcr: U256,
    pub mcr: U256,
    pub ccr: U256,
    pub entries: Vec<QueueEntry>,
    pub total_coll: U256,
    pub total_debt: U256,
    pub distribution: Vec<Bucket>,
    pub computed_block: u64,
    pub computed_at: Instant,
}

impl RadarData {
    /// Troves closest to the redemption tail (the ones at risk of being redeemed against).
    pub fn tail(&self, limit: usize) -> Vec<QueueEntry> {
        self.entries.iter().take(limit).cloned().collect()
    }

    /// Troves furthest from the tail, shown for context.
    pub fn head(&self, limit: usize) -> Vec<QueueEntry> {
        let mut v: Vec<QueueEntry> = self.entries.iter().rev().take(limit).cloned().collect();
        v.reverse();
        v
    }

    pub fn find(&self, address: Address) -> Option<&QueueEntry> {
        self.entries
            .iter()
            .find(|e| e.address == address)
    }

    pub fn queue_depth_before(&self, address: Address) -> Option<U256> {
        self.find(address)
            .map(|e| U256::from_str_radix(&e.redemption_buffer_musd, 10).unwrap_or(U256::ZERO))
    }

    pub fn age(&self) -> Duration {
        self.computed_at.elapsed()
    }
}

#[derive(Clone)]
pub struct Radar {
    inner: Arc<RwLock<Option<RadarData>>>,
    max_age: Duration,
}

impl Radar {
    pub fn new(max_age_secs: u64) -> Self {
        Self {
            inner: Arc::new(RwLock::new(None)),
            max_age: Duration::from_secs(max_age_secs),
        }
    }

    pub async fn cached(&self) -> Option<RadarData> {
        self.inner.read().await.clone()
    }

    /// Returns the index, refreshing it when older than `max_age`.
    pub async fn current(&self, mezo: &Mezo) -> Result<RadarData> {
        if let Some(data) = self.cached().await {
            if data.age() < self.max_age {
                return Ok(data);
            }
        }
        self.refresh(mezo).await
    }

    pub async fn refresh(&self, mezo: &Mezo) -> Result<RadarData> {
        let (price, mcr, ccr, tcr, block, owners) = tokio::join!(
            mezo.price(),
            mezo.mcr(),
            mezo.ccr(),
            async {
                let price = mezo.price().await?;
                mezo.tcr(price).await
            },
            mezo.rpc.block_number(),
            mezo.trove_owners(),
        );
        let price = price?;
        let mcr = mcr?;
        let ccr = ccr?;
        let tcr = tcr?;
        let block = block?;
        let owners = owners?;

        let snapshots = mezo.trove_snapshots(&owners, price).await?;
        let data = build(price, tcr, mcr, ccr, snapshots, block);
        *self.inner.write().await = Some(data.clone());
        Ok(data)
    }
}

fn build(
    price: U256,
    tcr: U256,
    mcr: U256,
    ccr: U256,
    mut snapshots: Vec<TroveSnapshot>,
    block: u64,
) -> RadarData {
    // Queue order is ascending nominal collateral ratio.
    snapshots.retain(|s| !s.debt.is_zero());
    snapshots.sort_by(|a, b| a.nicr.cmp(&b.nicr));

    let mut entries = Vec::with_capacity(snapshots.len());
    let mut cumulative = U256::ZERO;
    let mut total_coll = U256::ZERO;
    let mut total_debt = U256::ZERO;

    for (i, s) in snapshots.iter().enumerate() {
        let label = if s.icr < U256::from(115u64) * U256::from(10u64).pow(U256::from(16u64)) {
            "danger"
        } else if s.icr < U256::from(150u64) * U256::from(10u64).pow(U256::from(16u64)) {
            "watch"
        } else {
            "safe"
        };
        entries.push(QueueEntry {
            rank: (i + 1) as u64,
            address: s.address,
            coll: s.coll.to_string(),
            debt: s.debt.to_string(),
            icr_wad: s.icr.to_string(),
            nicr: s.nicr.to_string(),
            redemption_buffer_musd: cumulative.to_string(),
            interest_rate_bps: s.interest_rate_bps,
            liquidatable: s.icr < mcr,
            health_label: label.to_string(),
        });
        cumulative += s.debt;
        total_coll += s.coll;
        total_debt += s.debt;
    }

    RadarData {
        price,
        tcr,
        mcr,
        ccr,
        distribution: distribution(&entries),
        entries,
        total_coll,
        total_debt,
        computed_block: block,
        computed_at: Instant::now(),
    }
}

fn distribution(entries: &[QueueEntry]) -> Vec<Bucket> {
    let scale = U256::from(10u64).pow(U256::from(16u64)); // 1% in wad
    let bands: [(&str, u64, u64); 6] = [
        ("<115% (danger)", 0, 115),
        ("115–125%", 115, 125),
        ("125–150%", 125, 150),
        ("150–200%", 150, 200),
        ("200–300%", 200, 300),
        (">300%", 300, u64::MAX),
    ];
    bands
        .iter()
        .map(|(label, lo, hi)| {
            let lower = U256::from(*lo) * scale;
            let upper = if *hi == u64::MAX {
                None
            } else {
                Some(U256::from(*hi) * scale)
            };
            let matching: Vec<&QueueEntry> = entries
                .iter()
                .filter(|e| {
                    let icr = U256::from_str_radix(e.icr_wad.trim(), 10).unwrap_or(U256::ZERO);
                    icr >= lower && upper.map_or(true, |u| icr < u)
                })
                .collect();
            let debt: U256 = matching
                .iter()
                .map(|e| U256::from_str_radix(e.debt.trim(), 10).unwrap_or(U256::ZERO))
                .sum();
            Bucket {
                bucket: (*label).to_string(),
                count: matching.len() as u64,
                debt: debt.to_string(),
            }
        })
        .collect()
}
