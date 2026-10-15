//! Thin JSON-RPC client. Only the methods Pylon needs, over `reqwest`, so the service has no
//! transport-specific dependencies.

use alloy_primitives::{Address, B256, U256};
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct Rpc {
    client: reqwest::Client,
    pub url: String,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct Receipt {
    #[serde(rename = "transactionHash")]
    pub transaction_hash: B256,
    #[serde(rename = "blockNumber")]
    pub block_number: Option<String>,
    pub status: Option<String>,
    #[serde(rename = "gasUsed")]
    pub gas_used: Option<String>,
}

impl Receipt {
    pub fn succeeded(&self) -> bool {
        self.status.as_deref() == Some("0x1")
    }

    pub fn block(&self) -> u64 {
        self.block_number
            .as_deref()
            .and_then(|v| u64::from_str_radix(v.trim_start_matches("0x"), 16).ok())
            .unwrap_or(0)
    }
}

impl Rpc {
    pub fn new(url: impl Into<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("http client");
        Self {
            client,
            url: url.into(),
        }
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let mut last_error = None;
        // Public RPCs drop requests under load; a short retry loop keeps the service honest instead
        // of surfacing transient transport noise as a product error.
        for attempt in 0..4 {
            match self.client.post(&self.url).json(&body).send().await {
                Ok(response) => {
                    let status = response.status();
                    match response.json::<Value>().await {
                        Ok(value) => {
                            if let Some(err) = value.get("error") {
                                let message = err.to_string();
                                // JSON-RPC errors are deterministic: only retry rate limits.
                                if message.contains("rate") || message.contains("429") {
                                    last_error = Some(anyhow!("rpc {method} rate limited"));
                                } else {
                                    return Err(anyhow!("rpc {method} error: {err}"));
                                }
                            } else {
                                return value
                                    .get("result")
                                    .cloned()
                                    .ok_or_else(|| anyhow!("rpc {method}: missing result"));
                            }
                        }
                        Err(e) => {
                            last_error = Some(anyhow!("rpc {method} decode ({status}): {e}"));
                        }
                    }
                }
                Err(e) => last_error = Some(anyhow!("rpc {method} transport: {e}")),
            }
            tokio::time::sleep(std::time::Duration::from_millis(400 * (attempt + 1))).await;
        }
        Err(last_error.unwrap_or_else(|| anyhow!("rpc {method} failed")))
    }

    pub async fn block_number(&self) -> Result<u64> {
        let v = self.request("eth_blockNumber", json!([])).await?;
        parse_hex_u64(v.as_str().unwrap_or("0x0"))
    }

    pub async fn call(&self, to: Address, data: Vec<u8>) -> Result<Vec<u8>> {
        self.call_from(None, to, data).await
    }

    pub async fn call_from(&self, from: Option<Address>, to: Address, data: Vec<u8>) -> Result<Vec<u8>> {
        let mut tx = json!({"to": format!("{to:#x}"), "data": format!("0x{}", hex::encode(&data))});
        if let Some(from) = from {
            tx["from"] = json!(format!("{from:#x}"));
        }
        let v = self.request("eth_call", json!([tx, "latest"])).await?;
        let hex_str = v.as_str().unwrap_or("0x");
        Ok(hex::decode(hex_str.trim_start_matches("0x")).unwrap_or_default())
    }

    /// JSON-RPC batch of `eth_call`s. One round trip for up to hundreds of reads.
    pub async fn batch_call(&self, calls: Vec<(Address, Vec<u8>)>) -> Result<Vec<Vec<u8>>> {
        if calls.is_empty() {
            return Ok(Vec::new());
        }
        let batch: Vec<Value> = calls
            .iter()
            .enumerate()
            .map(|(i, (to, data))| {
                json!({
                    "jsonrpc": "2.0",
                    "id": i,
                    "method": "eth_call",
                    "params": [
                        {"to": format!("{to:#x}"), "data": format!("0x{}", hex::encode(data))},
                        "latest"
                    ]
                })
            })
            .collect();

        let response = self
            .client
            .post(&self.url)
            .json(&batch)
            .send()
            .await
            .context("rpc batch transport")?;
        let mut values: Vec<Value> = response.json().await.context("rpc batch decode")?;
        values.sort_by_key(|v| v.get("id").and_then(|i| i.as_u64()).unwrap_or(0));

        let mut out = Vec::with_capacity(values.len());
        for v in values {
            if let Some(err) = v.get("error") {
                return Err(anyhow!("rpc batch entry error: {err}"));
            }
            let hex_str = v.get("result").and_then(|r| r.as_str()).unwrap_or("0x");
            out.push(hex::decode(hex_str.trim_start_matches("0x")).unwrap_or_default());
        }
        Ok(out)
    }

    /// `eth_call` with a value attached (needed to dry-run payable entrypoints).
    pub async fn call_from_full(
        &self,
        from: Option<Address>,
        to: Address,
        value: U256,
        data: Vec<u8>,
    ) -> Result<Vec<u8>> {
        let mut tx = json!({
            "to": format!("{to:#x}"),
            "data": format!("0x{}", hex::encode(&data)),
            "value": format!("{value:#x}"),
        });
        if let Some(from) = from {
            tx["from"] = json!(format!("{from:#x}"));
        }
        let v = self.request("eth_call", json!([tx, "latest"])).await?;
        Ok(hex::decode(v.as_str().unwrap_or("0x").trim_start_matches("0x")).unwrap_or_default())
    }

    pub async fn balance(&self, address: Address) -> Result<U256> {
        let v = self
            .request("eth_getBalance", json!([format!("{address:#x}"), "latest"]))
            .await?;
        Ok(U256::from_be_slice(
            &hex::decode(v.as_str().unwrap_or("0x0").trim_start_matches("0x")).unwrap_or_default(),
        ))
    }

    pub async fn nonce(&self, address: Address) -> Result<u64> {
        let v = self
            .request("eth_getTransactionCount", json!([format!("{address:#x}"), "pending"]))
            .await?;
        parse_hex_u64(v.as_str().unwrap_or("0x0"))
    }

    pub async fn gas_price(&self) -> Result<U256> {
        let v = self.request("eth_gasPrice", json!([])).await?;
        Ok(U256::from_be_slice(
            &hex::decode(v.as_str().unwrap_or("0x0").trim_start_matches("0x")).unwrap_or_default(),
        ))
    }

    pub async fn estimate_gas(
        &self,
        from: Address,
        to: Address,
        value: U256,
        data: Vec<u8>,
    ) -> Result<u64> {
        let tx = json!({
            "from": format!("{from:#x}"),
            "to": format!("{to:#x}"),
            "value": format!("{value:#x}"),
            "data": format!("0x{}", hex::encode(&data)),
        });
        let v = self.request("eth_estimateGas", json!([tx])).await?;
        parse_hex_u64(v.as_str().unwrap_or("0x0"))
    }

    /// Escape hatch for methods without a typed wrapper.
    pub async fn raw_request(&self, method: &str, params: Value) -> Result<Value> {
        self.request(method, params).await
    }

    /// Decoded logs of a mined transaction.
    pub async fn logs(&self, hash: B256) -> Result<Vec<(Address, Vec<B256>, Vec<u8>)>> {
        let value = self
            .request("eth_getTransactionReceipt", json!([format!("{hash:#x}")]))
            .await?;
        let mut out = Vec::new();
        if let Some(logs) = value.get("logs").and_then(|l| l.as_array()) {
            for log in logs {
                let address = log
                    .get("address")
                    .and_then(|a| a.as_str())
                    .and_then(|a| a.parse().ok())
                    .unwrap_or(Address::ZERO);
                let topics = log
                    .get("topics")
                    .and_then(|t| t.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|t| t.as_str())
                            .filter_map(|t| t.parse().ok())
                            .collect::<Vec<B256>>()
                    })
                    .unwrap_or_default();
                let data = log
                    .get("data")
                    .and_then(|d| d.as_str())
                    .map(|d| hex::decode(d.trim_start_matches("0x")).unwrap_or_default())
                    .unwrap_or_default();
                out.push((address, topics, data));
            }
        }
        Ok(out)
    }

    pub async fn send_raw(&self, raw: &[u8]) -> Result<B256> {
        let v = self
            .request("eth_sendRawTransaction", json!([format!("0x{}", hex::encode(raw))]))
            .await?;
        v.as_str()
            .unwrap_or_default()
            .parse()
            .map_err(|_| anyhow!("bad tx hash from node"))
    }

    pub async fn receipt(&self, hash: B256) -> Result<Option<Receipt>> {
        let v = self
            .request("eth_getTransactionReceipt", json!([format!("{hash:#x}")]))
            .await?;
        if v.is_null() {
            return Ok(None);
        }
        Ok(Some(serde_json::from_value(v).context("receipt shape")?))
    }

    /// Polls until the transaction is mined (or the attempt budget runs out). Transient RPC
    /// failures are retried rather than surfaced: the transaction may still be mined.
    pub async fn wait_for_receipt(&self, hash: B256, attempts: u32) -> Result<Option<Receipt>> {
        for _ in 0..attempts {
            match self.receipt(hash).await {
                Ok(Some(r)) => return Ok(Some(r)),
                Ok(None) => {}
                Err(e) => tracing::debug!(error = %e, "receipt poll failed; retrying"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        Ok(None)
    }
}

pub fn parse_hex_u64(s: &str) -> Result<u64> {
    u64::from_str_radix(s.trim_start_matches("0x"), 16).map_err(|e| anyhow!("bad hex int {s}: {e}"))
}

pub fn encode_u256_word(v: U256) -> Vec<u8> {
    v.to_be_bytes::<32>().to_vec()
}
