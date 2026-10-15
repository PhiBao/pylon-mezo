//! Configuration: Mezo/Tigris/Pylon addresses per chain, loaded from the deployment record written
//! by the Foundry deploy script, with environment overrides.

use std::path::PathBuf;

use alloy_primitives::Address;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deployment {
    pub chain_id: u64,
    pub pylon_flash_engine: Address,
    pub pylon_reserve: Address,
    pub pylon_position_implementation: Address,
    pub musd: Address,
    pub btc: Address,
    pub flash_pool: Address,
    pub swap_pool: Address,
    pub router: Address,
    pub pool_factory: Address,
    pub borrower_ops: Address,
    pub borrower_ops_signatures: Address,
    pub trove_manager: Address,
    pub sorted_troves: Address,
    pub hint_helpers: Address,
    pub price_feed: Address,
    pub deployer: Address,
}

#[derive(Clone)]
pub struct Config {
    pub chain_id: u64,
    pub rpc_url: String,
    pub explorer: String,
    pub deployment: Deployment,
    /// Operator key used by the keeper and the proof runner. Never logged.
    pub operator_key: Option<String>,
    pub port: u16,
    pub data_dir: PathBuf,
    /// x402 pay-to address for the paid telemetry endpoint.
    pub x402_pay_to: Option<Address>,
    pub x402_facilitator: String,
    pub x402_price: String,
    /// A payment proof is only accepted while the settling block is this fresh, so an old transfer
    /// cannot be recycled as a payment much later.
    pub x402_max_age_secs: u64,
    /// The facilitator `verify` call proves a signature, not a settlement. The path stays off unless
    /// an operator explicitly enables it, and it always settles before serving the resource.
    pub x402_allow_facilitator: bool,
}

/// `Config` holds the operator private key, so `Debug` must never print it. A derived `Debug` would
/// leak the key the first time anyone logged the struct.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("chain_id", &self.chain_id)
            .field("rpc_url", &self.rpc_url)
            .field("explorer", &self.explorer)
            .field("port", &self.port)
            .field("data_dir", &self.data_dir)
            .field("operator_key", &self.operator_key.as_ref().map(|_| "<redacted>"))
            .field("x402_pay_to", &self.x402_pay_to)
            .field("x402_allow_facilitator", &self.x402_allow_facilitator)
            .finish()
    }
}

impl Config {
    pub fn load() -> Result<Self> {
        let chain_id: u64 = std::env::var("CHAIN_ID")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(31611);

        let (default_rpc, default_explorer) = match chain_id {
            31612 => ("https://rpc.mezo.org", "https://explorer.mezo.org"),
            _ => ("https://rpc.test.mezo.org", "https://explorer.test.mezo.org"),
        };

        let deployment_path: PathBuf = std::env::var("DEPLOYMENT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(format!("../contracts/deployments/{chain_id}.json")));
        let raw = std::fs::read_to_string(&deployment_path)
            .with_context(|| format!("reading deployment file {}", deployment_path.display()))?;
        let mut deployment: Deployment =
            serde_json::from_str(&raw).context("parsing deployment record")?;
        deployment.chain_id = chain_id;

        let deployment = apply_env_overrides(deployment)?;

        Ok(Config {
            chain_id,
            rpc_url: std::env::var("RPC_URL").unwrap_or_else(|_| default_rpc.to_string()),
            explorer: std::env::var("EXPLORER").unwrap_or_else(|_| default_explorer.to_string()),
            deployment,
            operator_key: std::env::var("PRIVATE_KEY").ok(),
            port: std::env::var("PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(8787),
            data_dir: std::env::var("DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("./data")),
            x402_pay_to: std::env::var("X402_PAY_TO")
                .ok()
                .and_then(|v| v.parse().ok()),
            x402_facilitator: std::env::var("X402_FACILITATOR")
                .unwrap_or_else(|_| "https://facilitator.vativ.io".to_string()),
            x402_price: std::env::var("X402_PRICE").unwrap_or_else(|_| "$0.001".to_string()),
            x402_max_age_secs: std::env::var("X402_MAX_AGE_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(900),
            x402_allow_facilitator: std::env::var("X402_ALLOW_FACILITATOR")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
        })
    }

    pub fn explorer_tx(&self, hash: &str) -> String {
        format!("{}/tx/{}", self.explorer, hash)
    }

    pub fn explorer_address(&self, address: &str) -> String {
        format!("{}/address/{}", self.explorer, address)
    }

    pub fn is_operator(&self, address: Address) -> bool {
        self.operator_address().is_some_and(|op| op == address)
    }

    /// Address derived from the operator key, if configured.
    pub fn operator_address(&self) -> Option<Address> {
        self.operator_key
            .as_ref()
            .and_then(|k| crate::eip712::address_from_key(k).ok())
    }
}

fn apply_env_overrides(mut d: Deployment) -> Result<Deployment> {
    let get = |name: &str| -> Option<Address> {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse::<Address>().ok())
    };
    if let Some(v) = get("PYLON_FLASH_ENGINE") {
        d.pylon_flash_engine = v;
    }
    if let Some(v) = get("PYLON_RESERVE") {
        d.pylon_reserve = v;
    }
    if let Some(v) = get("PYLON_POSITION_IMPLEMENTATION") {
        d.pylon_position_implementation = v;
    }
    if let Some(v) = get("FLASH_POOL") {
        d.flash_pool = v;
    }
    if let Some(v) = get("SWAP_POOL") {
        d.swap_pool = v;
    }
    Ok(d)
}
