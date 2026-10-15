//! HTTP surface: the radar, the quote engine, the reserve view, the x402 MUSD gateway and the
//! proof ledger used by the Pylon terminal.

use std::sync::Arc;

use alloy_primitives::{Address, U256};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tower_http::cors::{Any, CorsLayer};

use crate::config::Config;
use crate::mezo::{fmt_btc, fmt_musd, Mezo};
use crate::radar::Radar;
use crate::ratelimit::RateLimiter;
use crate::solver::Solver;
use crate::store::Store;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub mezo: Arc<Mezo>,
    pub radar: Arc<Radar>,
    pub store: Arc<Store>,
    /// Paid requests cost two upstream RPC reads each, so they carry their own budget.
    pub paid_limiter: Arc<RateLimiter>,
    /// Read endpoints are cheap to serve but still hit the RPC layer.
    pub read_limiter: Arc<RateLimiter>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/v1/config", get(config_view))
        .route("/api/v1/market", get(market))
        .route("/api/v1/radar", get(radar_view))
        .route("/api/v1/trove/:address", get(trove_view))
        .route("/api/v1/position/:address", get(position_view))
        .route("/api/v1/reserve", get(reserve_view))
        .route("/api/v1/quote/loop", get(quote_loop))
        .route("/api/v1/quote/unwind", get(quote_unwind))
        .route("/api/v1/quote/exit", get(quote_exit))
        .route("/api/v1/hints", get(hints))
        .route("/api/v1/proofs", get(proofs))
        .route("/api/v1/x402/trove-report/:address", get(x402_report).post(x402_report))
        .layer(CorsLayer::new().allow_origin(Any).allow_headers(Any).allow_methods(Any))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    match state.mezo.rpc.block_number().await {
        Ok(block) => Json(serde_json::json!({
            "status": "ok",
            "chainId": state.config.chain_id,
            "block": block,
            "rpc": state.config.rpc_url,
            "radarAgeSecs": state.radar.cached().await.map(|r| r.age().as_secs()),
        }))
        .into_response(),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"status": "degraded", "error": e.to_string()})),
        )
            .into_response(),
    }
}

async fn config_view(State(state): State<AppState>) -> impl IntoResponse {
    let d = &state.config.deployment;
    let c = &state.mezo.c;
    let (gas_comp, min_net_debt, mcr, ccr, pylon_fee_bps) = tokio::join!(
        state.mezo.gas_compensation(),
        state.mezo.min_net_debt(),
        state.mezo.mcr(),
        state.mezo.ccr(),
        state.mezo.flash_fee_bps(),
    );
    Json(serde_json::json!({
        "chainId": state.config.chain_id,
        "engine": c.engine,
        "reserve": c.reserve,
        "positionImplementation": c.position_impl,
        "musd": c.musd,
        "btc": c.btc,
        "flashPool": c.flash_pool,
        "swapPool": c.swap_pool,
        "router": c.router,
        "borrowerOps": c.borrower_ops,
        "borrowerOpsSignatures": c.borrower_ops_signatures,
        "troveManager": c.trove_manager,
        "sortedTroves": c.sorted_troves,
        "hintHelpers": c.hint_helpers,
        "priceFeed": c.price_feed,
        "explorer": state.config.explorer,
        "flashFeeBps": pylon_fee_bps.unwrap_or(0),
        "flashPoolFeeBps": state.mezo.flash_pool_state().await.map(|s| s.2).unwrap_or(0),
        "swapPoolFeeBps": state.mezo.swap_pool_state().await.map(|s| s.2).unwrap_or(0),
        "gasCompensation": gas_comp.map(|v| v.to_string()).unwrap_or_default(),
        "minNetDebt": min_net_debt.map(|v| v.to_string()).unwrap_or_default(),
        "mcrWad": mcr.map(|v| v.to_string()).unwrap_or_default(),
        "ccrWad": ccr.map(|v| v.to_string()).unwrap_or_default(),
        "deployer": d.deployer,
        "x402": {
            "price": state.config.x402_price,
            "payTo": state.config.x402_pay_to.map(|a| format!("{a:#x}")),
            "facilitator": state.config.x402_facilitator,
            "network": format!("eip155:{}", state.config.chain_id),
        },
    }))
}

async fn market(State(state): State<AppState>) -> impl IntoResponse {
    match state.mezo.market().await {
        Ok(mut m) => {
            if let Ok(radar) = state.radar.current(&state.mezo).await {
                m.system_coll = radar.total_coll.to_string();
                m.system_debt = radar.total_debt.to_string();
                m.trove_count = radar.entries.len() as u64;
                return Json(serde_json::json!(m)).into_response();
            }
            Json(serde_json::json!(m)).into_response()
        }
        Err(e) => error_response(e).into_response(),
    }
}

#[derive(Deserialize)]
struct RadarQuery {
    limit: Option<usize>,
}

async fn radar_view(State(state): State<AppState>, Query(q): Query<RadarQuery>) -> impl IntoResponse {
    let limit = q.limit.unwrap_or(60).min(200);
    match state.radar.current(&state.mezo).await {
        Ok(radar) => {
            let head_depth = radar
                .entries
                .last()
                .and_then(|e| U256::from_str_radix(&e.redemption_buffer_musd, 10).ok())
                .unwrap_or(U256::ZERO)
                + U256::from_str_radix(
                    radar.entries.last().map(|e| e.debt.as_str()).unwrap_or("0"),
                    10,
                )
                .unwrap_or(U256::ZERO);
            Json(serde_json::json!({
                "tcrWad": radar.tcr.to_string(),
                "mcrWad": radar.mcr.to_string(),
                "ccrWad": radar.ccr.to_string(),
                "btcPriceWad": radar.price.to_string(),
                "totalTroves": radar.entries.len(),
                "totalDebt": radar.total_debt.to_string(),
                "totalColl": radar.total_coll.to_string(),
                "redemptionQueueDepthMusd": head_depth.to_string(),
                "computedBlock": radar.computed_block,
                "ageSecs": radar.age().as_secs(),
                "distribution": radar.distribution,
                "tail": radar.tail(limit),
                "head": radar.head(limit.min(20)),
            }))
            .into_response()
        }
        Err(e) => error_response(e).into_response(),
    }
}

async fn trove_view(State(state): State<AppState>, Path(address): Path<String>) -> impl IntoResponse {
    let Ok(address) = address.parse::<Address>() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid address"})),
        )
            .into_response();
    };

    match state.mezo.trove(address, None).await {
        Ok(mut state_trove) => {
            let radar = state.radar.current(&state.mezo).await.ok();
            let mut hints = None;
            if state_trove.exists {
                if let Some(entry) = radar.as_ref().and_then(|r| r.find(address)) {
                    state_trove.rank = Some(entry.rank);
                    state_trove.redemption_buffer_musd = Some(entry.redemption_buffer_musd.clone());
                    state_trove.health_label = entry.health_label.clone();
                }
                let coll = U256::from_str_radix(state_trove.coll.trim(), 10).unwrap_or(U256::ZERO);
                let debt = U256::from_str_radix(state_trove.debt.trim(), 10).unwrap_or(U256::ZERO);
                hints = state.mezo.hints(coll, debt).await.ok();
            }
            Json(serde_json::json!({
                "trove": state_trove,
                "hints": hints,
                "nextNonce": state.mezo.signature_nonce(address).await.map(|n| n.to_string()).unwrap_or_default(),
                "musdBalance": state.mezo.musd_balance(address).await.map(|b| b.to_string()).unwrap_or_default(),
                "btcBalance": state.mezo.btc_balance(address).await.map(|b| b.to_string()).unwrap_or_default(),
            }))
            .into_response()
        }
        Err(e) => error_response(e).into_response(),
    }
}

async fn position_view(State(state): State<AppState>, Path(address): Path<String>) -> impl IntoResponse {
    let Ok(address) = address.parse::<Address>() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid address"})),
        )
            .into_response();
    };
    match state.mezo.position(address, None).await {
        Ok(position) => Json(serde_json::json!(position)).into_response(),
        Err(e) => error_response(e).into_response(),
    }
}

async fn reserve_view(State(state): State<AppState>) -> impl IntoResponse {
    match state.mezo.reserve_state().await {
        Ok(mut reserve) => {
            let positions = state.store.positions().await;
            for position in positions {
                if let Ok(loan) = state.mezo.reserve_loan(position).await {
                    if loan.is_zero() {
                        continue;
                    }
                    let owner = state
                        .mezo
                        .position(position, None)
                        .await
                        .map(|p| p.owner)
                        .unwrap_or(Address::ZERO);
                    let (icr, trigger, target, enabled) = state
                        .mezo
                        .position(position, None)
                        .await
                        .map(|p| {
                            (
                                p.trove.icr_wad,
                                p.trigger_icr_wad,
                                p.target_icr_wad,
                                p.shield_enabled,
                            )
                        })
                        .unwrap_or_default();
                    reserve.positions.push(crate::mezo::ReserveLoan {
                        position,
                        loan: loan.to_string(),
                        owner,
                        icr_wad: icr,
                        trigger_icr_wad: trigger,
                        target_icr_wad: target,
                        shield_enabled: enabled,
                    });
                }
            }
            Json(serde_json::json!(reserve)).into_response()
        }
        Err(e) => error_response(e).into_response(),
    }
}

#[derive(Deserialize)]
struct LoopQuery {
    #[serde(alias = "collAdd")]
    coll_add: String,
    owner: Option<String>,
}

async fn quote_loop(State(state): State<AppState>, Query(q): Query<LoopQuery>) -> impl IntoResponse {
    let Ok(coll_add) = U256::from_str_radix(q.coll_add.trim_start_matches("0x"), if q.coll_add.starts_with("0x") { 16 } else { 10 }) else {
        return bad_request("coll_add must be a wei integer");
    };
    let owner = q.owner.and_then(|o| o.parse::<Address>().ok());
    let solver = Solver::new(&state.mezo, &state.radar);
    match solver.loop_quote(coll_add, owner).await {
        Ok(quote) => Json(serde_json::json!(quote)).into_response(),
        Err(e) => error_response(e).into_response(),
    }
}

#[derive(Deserialize)]
struct UnwindQuery {
    repay: String,
    address: Option<String>,
    owner: Option<String>,
}

async fn quote_unwind(State(state): State<AppState>, Query(q): Query<UnwindQuery>) -> impl IntoResponse {
    let Ok(repay) = U256::from_str_radix(q.repay.trim_start_matches("0x"), if q.repay.starts_with("0x") { 16 } else { 10 }) else {
        return bad_request("repay must be a wei integer");
    };
    let owner = q
        .address
        .or(q.owner)
        .and_then(|o| o.parse::<Address>().ok());
    let solver = Solver::new(&state.mezo, &state.radar);
    match solver.unwind_quote(repay, owner).await {
        Ok(quote) => Json(serde_json::json!(quote)).into_response(),
        Err(e) => error_response(e).into_response(),
    }
}

#[derive(Deserialize)]
struct ExitQuery {
    address: String,
}

async fn quote_exit(State(state): State<AppState>, Query(q): Query<ExitQuery>) -> impl IntoResponse {
    let Ok(owner) = q.address.parse::<Address>() else {
        return bad_request("invalid address");
    };
    let solver = Solver::new(&state.mezo, &state.radar);
    match solver.exit_quote(owner).await {
        Ok(quote) => Json(serde_json::json!(quote)).into_response(),
        Err(e) => error_response(e).into_response(),
    }
}

#[derive(Deserialize)]
struct HintsQuery {
    coll: String,
    debt: String,
}

async fn hints(State(state): State<AppState>, Query(q): Query<HintsQuery>) -> impl IntoResponse {
    let coll = U256::from_str_radix(q.coll.trim(), 10).unwrap_or(U256::ZERO);
    let debt = U256::from_str_radix(q.debt.trim(), 10).unwrap_or(U256::ZERO);
    match state.mezo.hints(coll, debt).await {
        Ok(h) => Json(serde_json::json!(h)).into_response(),
        Err(e) => error_response(e).into_response(),
    }
}

async fn proofs(State(state): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({ "proofs": state.store.all().await }))
}

// ---------------------------------------------------------------------------
// x402: paid trove telemetry, settled in MUSD on Mezo
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PaymentRequirement {
    scheme: String,
    network: String,
    max_amount_required: String,
    resource: String,
    description: String,
    pay_to: String,
    asset: String,
    extra: serde_json::Value,
}

/// Payment proof, when settled directly on chain rather than signed through a facilitator.
struct SettledPayment {
    payer: Address,
    block_time: u64,
    amount: U256,
}

async fn x402_report(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    Path(address): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !state.paid_limiter.allow(peer.ip()) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({
                "error": "rate limited",
                "detail": "Paid telemetry carries a per-client budget; retry after the window."
            })),
        )
            .into_response();
    }

    let Ok(trove_address) = address.parse::<Address>() else {
        return bad_request("invalid address");
    };
    let Some(pay_to) = state.config.x402_pay_to else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "x402 pay-to address not configured (set X402_PAY_TO)"})),
        )
            .into_response();
    };

    let price_musd = U256::from(1_000_000_000_000_000u64); // 0.001 MUSD (18 decimals)
    let resource = format!("/api/v1/x402/trove-report/{trove_address:#x}");
    let requirement = PaymentRequirement {
        scheme: "exact".into(),
        network: format!("eip155:{}", state.config.chain_id),
        max_amount_required: price_musd.to_string(),
        resource: resource.clone(),
        description: "Pylon trove risk and redemption-queue report".into(),
        pay_to: format!("{pay_to:#x}"),
        asset: format!("{:#x}", state.mezo.c.musd),
        extra: serde_json::json!({"name": "Mezo USD", "version": "1"}),
    };

    let payment_tx = headers
        .get("x-payment-tx")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let payment_signature = headers
        .get("payment-signature")
        .or_else(|| headers.get("x-payment"))
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let mut payer: Option<Address> = None;

    if let Some(tx_hash) = payment_tx {
        // Trustless path: the service verifies the settlement itself against a mined receipt.
        let settled = match verify_onchain_payment(&state, &tx_hash, pay_to, price_musd).await {
            Ok(Some(settled)) => settled,
            Ok(None) => {
                return (
                    StatusCode::PAYMENT_REQUIRED,
                    Json(serde_json::json!({
                        "error": "payment transaction does not transfer the required MUSD to the pay-to address",
                        "accepts": [requirement],
                    })),
                )
                    .into_response();
            }
            Err(e) => return error_response(e).into_response(),
        };

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let age = now.saturating_sub(settled.block_time);
        if age > state.config.x402_max_age_secs {
            return (
                StatusCode::PAYMENT_REQUIRED,
                Json(serde_json::json!({
                    "error": "payment proof is stale",
                    "detail": format!("settled {age}s ago; the window is {}s", state.config.x402_max_age_secs),
                    "accepts": [requirement],
                })),
            )
                .into_response();
        }

        // Single-use: one settled transfer buys one request, so the proof cannot be replayed.
        if !state.store.claim_payment(&tx_hash).await {
            return (
                StatusCode::PAYMENT_REQUIRED,
                Json(serde_json::json!({
                    "error": "payment proof already spent",
                    "detail": "Each settled transfer authorises exactly one request.",
                    "accepts": [requirement],
                })),
            )
                .into_response();
        }

        payer = Some(settled.payer);
    } else if let Some(signature) = payment_signature {
        if !state.config.x402_allow_facilitator {
            return (
                StatusCode::PAYMENT_REQUIRED,
                Json(serde_json::json!({
                    "error": "facilitator settlement is disabled on this deployment",
                    "detail": "Settle MUSD on chain and retry with `X-PAYMENT-TX`.",
                    "accepts": [requirement],
                })),
            )
                .into_response();
        }
        // A verify call proves a signature, not a payment: settle before serving, and only then
        // consume the proof.
        match settle_with_facilitator(&state, &signature, &requirement).await {
            Some(tx_hash) if state.store.claim_payment(&tx_hash).await => {}
            _ => {
                return (
                    StatusCode::PAYMENT_REQUIRED,
                    Json(serde_json::json!({
                        "error": "payment could not be verified and settled by the facilitator",
                        "accepts": [requirement],
                    })),
                )
                    .into_response();
            }
        }
    } else {
        let header_value = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            serde_json::to_vec(&requirement).unwrap_or_default(),
        );
        let mut response = (
            StatusCode::PAYMENT_REQUIRED,
            Json(serde_json::json!({
                "x402Version": 1,
                "error": "Payment Required",
                "accepts": [requirement],
                "instructions": [
                    "Settle 0.001 MUSD to the pay-to address on Mezo and retry with header `X-PAYMENT-TX: <txHash>`,",
                    "or attach a signed x402 payment payload as `PAYMENT-SIGNATURE` where facilitator settlement is enabled."
                ],
            })),
        )
            .into_response();
        response.headers_mut().insert(
            "PAYMENT-REQUIRED",
            header_value.parse().unwrap_or_else(|_| "".parse().unwrap()),
        );
        return response;
    }

    // Paid: produce the report from live state.
    let trove = match state.mezo.trove(trove_address, None).await {
        Ok(t) => t,
        Err(e) => return error_response(e).into_response(),
    };
    let radar = state.radar.current(&state.mezo).await.ok();
    let entry = radar.as_ref().and_then(|r| r.find(trove_address));
    let price = radar.as_ref().map(|r| r.price).unwrap_or_default();
    let coll = U256::from_str_radix(trove.coll.trim(), 10).unwrap_or(U256::ZERO);
    let debt = U256::from_str_radix(trove.debt.trim(), 10).unwrap_or(U256::ZERO);

    Json(serde_json::json!({
        "report": {
            "generatedAtBlock": radar.as_ref().map(|r| r.computed_block).unwrap_or(0),
            "trove": trove,
            "btcPriceWad": price.to_string(),
            "redemptionQueue": entry.map(|e| serde_json::json!({
                "rank": e.rank,
                "bufferAheadMusd": e.redemption_buffer_musd,
                "healthLabel": e.health_label,
            })),
            "collateralValueMusd": fmt_musd(&(coll * price / U256::from(10u64).pow(U256::from(18u64))), 2),
            "debtMusd": fmt_musd(&debt, 2),
            "liquidationPriceWad": if coll.is_zero() { U256::ZERO } else {
                U256::from(11u64) * debt * U256::from(10u64).pow(U256::from(17u64)) / coll
            }.to_string(),
        },
        "payer": payer.map(|p| format!("{p:#x}")),
        "payTo": format!("{pay_to:#x}"),
        "settled": true,
        "note": "Telemetry is generated from live Mezo state at request time; the settlement is verifiable on-chain.",
    }))
    .into_response()
}

/// Verifies a settled MUSD transfer directly against a mined receipt: the payer, the block time and
/// the transferred amount come from the chain, never from the caller.
async fn verify_onchain_payment(
    state: &AppState,
    tx_hash: &str,
    pay_to: Address,
    amount: U256,
) -> anyhow::Result<Option<SettledPayment>> {
    let hash: alloy_primitives::B256 = tx_hash
        .trim()
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid tx hash"))?;
    let Some(receipt) = state.mezo.rpc.receipt(hash).await? else {
        return Ok(None);
    };
    if !receipt.succeeded() {
        return Ok(None);
    }
    // Block time bounds replay: an old transfer must not be recycled as a fresh payment.
    let block_time = state.mezo.rpc.block_timestamp(receipt.block()).await.unwrap_or(0);
    // ERC-20 Transfer(from, to, value) log on the MUSD token.
    let logs = state.mezo.rpc.logs(hash).await?;
    let musd = state.mezo.c.musd;
    let transfer_sig = crate::abi::selector("Transfer(address,address,uint256)");
    for (address, topics, data) in logs {
        if address != musd || topics.len() < 3 {
            continue;
        }
        if topics[0].0[..4] != transfer_sig {
            continue;
        }
        let from = Address::from_slice(&topics[1].0[12..]);
        let to = Address::from_slice(&topics[2].0[12..]);
        let value = U256::from_be_slice(&data);
        // A mint emits `Transfer(0x0, to, value)`: it moves value to the address but pays nothing, so
        // it must not count as a settlement.
        if from != Address::ZERO && to == pay_to && value >= amount {
            return Ok(Some(SettledPayment {
                payer: from,
                block_time,
                amount: value,
            }));
        }
    }
    Ok(None)
}

/// Settles through the facilitator and returns the settlement transaction hash.
///
/// `verify` only proves that a payload is well formed and correctly signed; it is not a payment. The
/// resource is served only after `settle` reports success, and the returned hash is consumed like any
/// other proof so it cannot be replayed.
async fn settle_with_facilitator(
    state: &AppState,
    signature: &str,
    requirement: &PaymentRequirement,
) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .ok()?;
    let body = serde_json::json!({
        "x402Version": 1,
        "paymentPayload": signature,
        "paymentRequirements": requirement,
    });
    let base = state.config.x402_facilitator.trim_end_matches('/');

    let verify: serde_json::Value = client
        .post(format!("{base}/verify"))
        .json(&body)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    if verify.get("isValid").and_then(|b| b.as_bool()) != Some(true) {
        return None;
    }

    let settle: serde_json::Value = client
        .post(format!("{base}/settle"))
        .json(&body)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let succeeded = settle
        .get("success")
        .and_then(|b| b.as_bool())
        .or_else(|| settle.get("status").and_then(|s| s.as_str()).map(|s| s == "success"))
        .unwrap_or(false);
    if !succeeded {
        return None;
    }
    settle
        .get("transaction")
        .or_else(|| settle.get("txHash"))
        .and_then(|t| t.as_str())
        .map(|t| t.to_string())
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn error_response(e: anyhow::Error) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::BAD_GATEWAY,
        Json(serde_json::json!({"error": e.to_string()})),
    )
}

fn bad_request(message: &str) -> axum::response::Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error": message})),
    )
        .into_response()
}

/// Formats a wei value for logs.
pub fn describe_btc(v: &U256) -> String {
    format!("{} BTC", fmt_btc(v, 8))
}
