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
    payments_path: PathBuf,
    inner: std::sync::Arc<RwLock<Vec<Proof>>>,
    next_id: std::sync::Arc<std::sync::atomic::AtomicU64>,
    positions: std::sync::Arc<RwLock<Vec<Address>>>,
    /// Payment transaction hashes already spent on a paid request. A settled transfer buys exactly
    /// one request: without this set the same proof unlocks the endpoint forever.
    spent_payments: std::sync::Arc<RwLock<std::collections::HashSet<String>>>,
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

        let payments_path = data_dir.join("spent-payments.jsonl");
        let mut spent = std::collections::HashSet::new();
        if let Ok(raw) = std::fs::read_to_string(&payments_path) {
            for line in raw.lines() {
                if let Ok(hash) = serde_json::from_str::<String>(line) {
                    spent.insert(hash);
                }
            }
        }

        Self {
            path,
            payments_path,
            inner: std::sync::Arc::new(RwLock::new(proofs)),
            next_id: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(next_id)),
            positions: std::sync::Arc::new(RwLock::new(positions)),
            spent_payments: std::sync::Arc::new(RwLock::new(spent)),
        }
    }

    /// Atomically claims a payment proof. Returns `false` when the hash was already spent, so a
    /// replayed `X-PAYMENT-TX` is refused instead of unlocking a second request.
    pub async fn claim_payment(&self, tx_hash: &str) -> bool {
        let key = tx_hash.to_ascii_lowercase();
        {
            let mut spent = self.spent_payments.write().await;
            if !spent.insert(key.clone()) {
                return false;
            }
        }
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.payments_path)
        {
            if let Ok(line) = serde_json::to_string(&key) {
                writeln!(f, "{line}").ok();
            }
        }
        true
    }

    #[cfg(test)]
    pub async fn payments_are_spent(&self, tx_hash: &str) -> bool {
        self.spent_payments
            .read()
            .await
            .contains(&tx_hash.to_ascii_lowercase())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_payment_proof_is_spendable_exactly_once() {
        let dir = std::env::temp_dir().join(format!("pylon-store-test-{}", std::process::id()));
        let store = Store::open(dir.clone());
        let hash = "0xabc0000000000000000000000000000000000000000000000000000000000001";

        assert!(store.claim_payment(hash).await, "first claim succeeds");
        assert!(!store.claim_payment(hash).await, "replay is refused");
        assert!(store.payments_are_spent(hash).await);
        assert!(
            store.claim_payment(&hash.to_uppercase()).await == false,
            "case changes do not create a second claim"
        );

        // A fresh store over the same directory remembers the spend, so a restart is not a reset.
        drop(store);
        let reopened = Store::open(dir.clone());
        assert!(!reopened.claim_payment(hash).await, "spend survives a restart");
        let _ = std::fs::remove_dir_all(dir);
    }
}
