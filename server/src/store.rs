//! Append-only audit log of everything Pylon has actually executed on Mezo.
//!
//! The proof ledger is a product surface, not just telemetry: every row links to a mined
//! transaction on the Mezo explorer, so any claim in the interface can be checked independently.

use std::path::PathBuf;

use alloy_primitives::{Address, B256};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proof {
    pub id: u64,
    pub kind: String,
    #[serde(rename = "txHash")]
    pub tx_hash: String,
    pub explorer_url: String,
    pub actor: String,
    pub note: String,
    pub musd: String,
    pub btc: String,
    #[serde(rename = "feeMusd")]
    pub fee_musd: String,
    pub block: u64,
    pub timestamp: u64,
    pub gas_used: Option<String>,
}

#[derive(Clone)]
pub struct Store {
    path: PathBuf,
    inner: std::sync::Arc<RwLock<Vec<Proof>>>,
    next_id: std::sync::Arc<std::sync::atomic::AtomicU64>,
    positions: std::sync::Arc<RwLock<Vec<Address>>>,
}

impl Store {
    pub fn open(data_dir: PathBuf) -> Self {
        std::fs::create_dir_all(&data_dir).ok();
        let path = data_dir.join("proofs.jsonl");
        let mut proofs = Vec::new();
        if let Ok(raw) = std::fs::read_to_string(&path) {
            for line in raw.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(p) = serde_json::from_str::<Proof>(line) {
                    proofs.push(p);
                }
            }
        }
        let next_id = proofs.iter().map(|p| p.id + 1).max().unwrap_or(1);
        let mut positions: Vec<Address> = proofs
            .iter()
            .filter(|p| p.kind == "position-created")
            .filter_map(|p| p.note.split_whitespace().next())
            .filter_map(|s| s.parse().ok())
            .collect();
        if let Ok(list) = std::env::var("POSITIONS") {
            for item in list.split(',') {
                if let Ok(addr) = item.trim().parse::<Address>() {
                    if !positions.contains(&addr) {
                        positions.push(addr);
                    }
                }
            }
        }

        Self {
            path,
            inner: std::sync::Arc::new(RwLock::new(proofs)),
            next_id: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(next_id)),
            positions: std::sync::Arc::new(RwLock::new(positions)),
        }
    }

    pub async fn all(&self) -> Vec<Proof> {
        let mut list = self.inner.read().await.clone();
        list.sort_by(|a, b| b.id.cmp(&a.id));
        list
    }

    pub async fn positions(&self) -> Vec<Address> {
        self.positions.read().await.clone()
    }

    pub async fn track_position(&self, address: Address) {
        let mut list = self.positions.write().await;
        if !list.contains(&address) {
            list.push(address);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn record(
        &self,
        kind: &str,
        tx_hash: B256,
        explorer_url: String,
        actor: Address,
        note: String,
        musd: String,
        btc: String,
        fee_musd: String,
        block: u64,
        gas_used: Option<String>,
    ) -> Result<Proof> {
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let proof = Proof {
            id,
            kind: kind.to_string(),
            tx_hash: format!("{tx_hash:#x}"),
            explorer_url,
            actor: format!("{actor:#x}"),
            note,
            musd,
            btc,
            fee_musd,
            block,
            timestamp,
            gas_used,
        };
        {
            let mut list = self.inner.write().await;
            list.push(proof.clone());
        }
        if let Ok(line) = serde_json::to_string(&proof) {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
            {
                writeln!(f, "{line}").ok();
            }
        }
        Ok(proof)
    }
}
