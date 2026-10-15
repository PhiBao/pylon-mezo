//! Operator phases: every step Pylon claims to support, executed for real on Mezo Testnet.
//!
//! These are the same code paths the interface and the keeper use — the only difference is that the
//! operator key signs, instead of a browser wallet.

use alloy_primitives::U256;
use anyhow::{bail, Context, Result};
use tracing::info;

use crate::api::AppState;
use crate::mezo::{fmt_btc, fmt_musd, parse_addr};

fn env_u256(name: &str, default: u128) -> U256 {
    std::env::var(name)
        .ok()
        .and_then(|v| {
            if let Some(hex) = v.strip_prefix("0x") {
                U256::from_str_radix(hex, 16).ok()
            } else {
                U256::from_str_radix(&v, 10).ok()
            }
        })
        .unwrap_or_else(|| U256::from(default))
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn deadline() -> U256 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    U256::from(now + 1800)
}

fn wad(v: u128) -> U256 {
    U256::from(v)
}

fn simulate() -> bool {
    std::env::var("SIMULATE").map(|v| v == "1").unwrap_or(false)
}

/// Broadcasts a call, or dry-runs it when `SIMULATE=1` is set. Returns the transaction hash (zero
/// for simulations) and the block number.
async fn submit(
    state: &AppState,
    key: &str,
    to: alloy_primitives::Address,
    value: U256,
    data: Vec<u8>,
) -> Result<(alloy_primitives::B256, u64, Option<String>)> {
    let operator = state
        .config
        .operator_address()
        .context("operator key missing")?;
    if std::env::var("PRINT_CALLDATA").map(|v| v == "1").unwrap_or(false) {
        println!("calldata -> {to:#x}: 0x{}", hex::encode(&data));
    }
    if simulate() {
        match state.mezo.simulate(operator, to, value, data).await {
            Ok(out) => {
                println!("simulation ok ({} bytes returned) for call to {to:#x}", out.len());
                Ok((alloy_primitives::B256::ZERO, 0, None))
            }
            Err(e) => {
                println!("simulation REVERTED for call to {to:#x}");
                Err(e)
            }
        }
    } else {
        let (hash, receipt) = state
            .mezo
            .send(key, to, value, data)
            .await?;
        Ok((hash, receipt.block(), receipt.gas_used))
    }
}

pub async fn run_phase(phase: u64, state: &AppState) -> Result<()> {
    let key = state
        .config
        .operator_key
        .clone()
        .context("PRIVATE_KEY must be set for operator phases")?;
    let operator = state
        .config
        .operator_address()
        .context("could not derive operator address")?;
    let mezo = &state.mezo;

    info!(phase, %operator, "running Pylon proof phase");

    match phase {
        1 => {
            let coll = env_u256("COLL", 45_000_000_000_000_000u128);
            let debt = env_u256("DEBT", 1_800_000_000_000_000_000_000u128);
            let fee = mezo.borrowing_fee(debt).await?;
            let gas_comp = mezo.gas_compensation().await?;
            let hints = mezo.hints(coll, debt + fee + gas_comp).await?;
            let data = crate::abi::calldata(
                "openTrove(uint256,address,address)",
                &[
                    crate::abi::Val::u256(debt),
                    crate::abi::Val::addr(parse_addr(&hints.upper)),
                    crate::abi::Val::addr(parse_addr(&hints.lower)),
                ],
            );
            let (hash, block, gas) = submit(state, &key, mezo.c.borrower_ops, coll, data).await?;
            log_tx(state, "open-trove", hash, block, operator, format!("opened trove: {coll} wei BTC collateral, {debt} wei MUSD debt"), fmt_musd(&debt, 2), fmt_btc(&coll, 6), "0").await;
        }
        2 => {
            let amount = env_u256("SEED", 1_000_000_000_000_000_000_000u128);
            let (hash, block, gas1) = submit(
                state,
                &key,
                mezo.c.musd,
                U256::ZERO,
                mezo.approve_calldata(mezo.c.reserve, amount),
            )
            .await?;
            let _ = gas1;
            log_tx(state, "reserve-approve", hash, block, operator, format!("approved {} MUSD to the shield pool", fmt_musd(&amount, 2)), String::from("0"), String::from("0"), String::from("0")).await;

            let (hash, block, _) = submit(
                state,
                &key,
                mezo.c.reserve,
                U256::ZERO,
                mezo.reserve_deposit_calldata(amount, operator),
            )
            .await?;
            log_tx(state, "reserve-deposit", hash, block, operator, format!("seeded the shield pool with {} MUSD", fmt_musd(&amount, 2)), fmt_musd(&amount, 2), String::from("0"), String::from("0")).await;

            let reserve = mezo.reserve_state().await?;
            info!(assets = %reserve.total_assets, idle = %reserve.idle, "reserve capitalised");
        }
        3 => {
            let coll_add = env_u256("COLL_ADD", 5_000_000_000_000_000u128);
            let (debt_delta, pylon_fee) = mezo.preview_loop(coll_add).await?;
            let nonce = mezo.signature_nonce(operator).await?;
            let dl = deadline();
            let signature = mezo.sign_adjust(
                &key,
                operator,
                U256::ZERO,
                debt_delta,
                true,
                coll_add,
                mezo.c.engine,
                nonce,
                dl,
            )?;
            let hints = mezo.hints(
                mezo.trove(operator, None)
                    .await
                    .map(|t| U256::from_str_radix(t.coll.trim(), 10).unwrap_or(U256::ZERO) + coll_add)
                    .unwrap_or(coll_add),
                mezo.trove(operator, None)
                    .await
                    .map(|t| U256::from_str_radix(t.debt.trim(), 10).unwrap_or(U256::ZERO) + debt_delta)
                    .unwrap_or(debt_delta),
            )
            .await
            .unwrap_or(crate::mezo::Hints {
                upper: "0x0000000000000000000000000000000000000000".into(),
                lower: "0x0000000000000000000000000000000000000000".into(),
            });

            let data = mezo.loop_calldata(
                &hints,
                operator,
                debt_delta,
                coll_add,
                operator,
                env_u256("MIN_POST_ICR", 0),
                dl,
                signature,
            );
            let (hash, block, _gas) = submit(state, &key, mezo.c.engine, U256::ZERO, data).await?;
            log_tx(state, "flash-loop", hash, block, operator, format!("flash loop: +{} BTC collateral, +{} MUSD debt, fee {} MUSD", fmt_btc(&coll_add, 6), fmt_musd(&debt_delta, 2), fmt_musd(&pylon_fee, 2)), fmt_musd(&debt_delta, 2), fmt_btc(&coll_add, 6), fmt_musd(&pylon_fee, 2)).await;
        }
        4 => {
            let repay = env_u256("REPAY", 400_000_000_000_000_000_000u128);
            let btc_in = mezo.preview_unwind_btc_in(repay).await?;
            let coll_out = btc_in + btc_in / U256::from(20u64);
            let nonce = mezo.signature_nonce(operator).await?;
            let dl = deadline();
            let signature = mezo.sign_adjust(
                &key,
                operator,
                coll_out,
                repay,
                false,
                U256::ZERO,
                mezo.c.engine,
                nonce,
                dl,
            )?;
            let hints = crate::mezo::Hints {
                upper: "0x0000000000000000000000000000000000000000".into(),
                lower: "0x0000000000000000000000000000000000000000".into(),
            };
            let data = mezo.unwind_calldata(
                &hints,
                operator,
                repay,
                coll_out,
                operator,
                env_u256("MIN_POST_ICR", 0),
                dl,
                signature,
            );
            let wallet_musd = mezo.musd_balance(operator).await?;
            let (hash, block, _gas) = submit(state, &key, mezo.c.engine, U256::ZERO, data).await?;
            log_tx(state, "flash-unwind", hash, block, operator, format!("flash unwind: repaid {} MUSD of debt out of {} BTC of collateral (wallet MUSD at start: {})", fmt_musd(&repay, 2), fmt_btc(&coll_out, 6), fmt_musd(&wallet_musd, 2)), fmt_musd(&repay, 2), fmt_btc(&coll_out, 6), "0").await;
        }
        5 => {
            let nonce = mezo.signature_nonce(operator).await?;
            let dl = deadline();
            // The engine receives the released collateral, so it is the signed recipient.
            let signature = mezo.sign_close(&key, operator, mezo.c.engine, nonce, dl)?;
            let data = mezo.close_calldata(operator, operator, dl, signature);
            let (hash, block, _gas) = submit(state, &key, mezo.c.engine, U256::ZERO, data).await?;
            log_tx(state, "flash-exit", hash, block, operator, "flash exit: trove closed and net BTC returned without any up-front MUSD".into(), String::from("0"), String::from("0"), String::from("0")).await;
        }
        6 => {
            let coll = env_u256("COLL", 30_000_000_000_000_000u128);
            let debt = env_u256("DEBT", 1_800_000_000_000_000_000_000u128);

            let (hash, block, _) = submit(
                state,
                &key,
                mezo.c.engine,
                U256::ZERO,
                mezo.create_position_calldata(operator),
            )
            .await?;
            let created = position_from_logs(&state, hash)
                .await
                .context("could not read the created position from the receipt")?;
            state.store.track_position(created).await;
            log_tx(state, "position-created", hash, block, operator, format!("{created:#x} created Pylon position"), String::from("0"), String::from("0"), String::from("0")).await;

            let (hash, block, _) = submit(
                state,
                &key,
                created,
                coll,
                mezo.open_trove_calldata(debt),
            )
            .await?;
            log_tx(state, "position-open", hash, block, operator, format!("{created:#x} opened its own trove: {} BTC collateral, {} MUSD debt", fmt_btc(&coll, 6), fmt_musd(&debt, 2)), fmt_musd(&debt, 2), fmt_btc(&coll, 6), "0").await;

            let trigger = env_u64("TRIGGER_ICR", 2_100_000_000_000_000_000u64);
            let target = env_u64("TARGET_ICR", 2_500_000_000_000_000_000u64);
            let max_per_call = env_u256("MAX_PER_CALL", 500_000_000_000_000_000_000u128);
            let (hash, block, _) = submit(
                state,
                &key,
                created,
                U256::ZERO,
                mezo.signal_set_shield_calldata(true, trigger, target, max_per_call),
            )
            .await?;
            log_tx(state, "shield-configured", hash, block, operator, format!("{created:#x} shield armed: defend below {:.0}% ICR toward {:.0}%", trigger as f64 / 1e16, target as f64 / 1e16), String::from("0"), String::from("0"), String::from("0")).await;
            println!("POSITION={created:#x}");
        }
        7 => {
            let position: alloy_primitives::Address = std::env::var("POSITION")
                .context("POSITION env var required")?
                .parse()?;
            let before = mezo.position(position, None).await?;
            let data = mezo.defend_calldata();
            let (hash, block, _) = submit(state, &key, position, U256::ZERO, data).await?;
            let after = mezo.position(position, None).await?;
            log_tx(
                state,
                "shield-defend",
                hash,
                block,
                operator,
                format!(
                    "permissionless defence on {position:#x}: ICR {} → {}, reserve claim {} MUSD",
                    ratio(&before.trove.icr_wad),
                    ratio(&after.trove.icr_wad),
                    fmt_musd(&U256::from_str_radix(after.reserve_debt.trim(), 10).unwrap_or(U256::ZERO), 2)
                ),
                after.reserve_debt.clone(),
                String::from("0"),
                String::from("0"),
            )
            .await;
        }
        8 => {
            let position: alloy_primitives::Address = std::env::var("POSITION")
                .context("POSITION env var required")?
                .parse()?;
            let coll_add = env_u256("COLL_ADD", 2_000_000_000_000_000u128);
            let (debt_delta, _) = mezo.preview_loop(coll_add).await?;
            // Solver hints keep the nested call cheap: on-chain resolution costs millions of gas.
            let position_state = mezo.position(position, None).await?;
            let coll = U256::from_str_radix(position_state.trove.coll.trim(), 10).unwrap_or(U256::ZERO);
            let debt = U256::from_str_radix(position_state.trove.debt.trim(), 10).unwrap_or(U256::ZERO);
            let fee = mezo.borrowing_fee(debt_delta).await.unwrap_or(U256::ZERO);
            let hints = mezo
                .hints(coll + coll_add, debt + debt_delta + fee)
                .await
                .unwrap_or(crate::mezo::Hints {
                    upper: "0x0000000000000000000000000000000000000000".into(),
                    lower: "0x0000000000000000000000000000000000000000".into(),
                });
            let data = mezo.loop_position_calldata(
                position,
                debt_delta,
                coll_add,
                &hints,
                env_u256("MIN_POST_ICR", 0),
                deadline(),
            );
            let (hash, block, _gas) = submit(state, &key, mezo.c.engine, U256::ZERO, data).await?;
            log_tx(state, "position-loop", hash, block, operator, format!("flash looped position {position:#x}: +{} BTC, +{} MUSD", fmt_btc(&coll_add, 6), fmt_musd(&debt_delta, 2)), fmt_musd(&debt_delta, 2), fmt_btc(&coll_add, 6), "0").await;
        }
        other => bail!("unknown phase {other}"),
    }

    Ok(())
}

/// Formats a wad ratio as a percentage (`1_800_000_000_000_000_000` -> `180.0%`).
fn ratio(wad_str: &str) -> String {
    let v = U256::from_str_radix(wad_str.trim(), 10).unwrap_or(U256::ZERO);
    let percent = v * U256::from(100u64);
    let whole = percent / wad(1_000_000_000_000_000_000);
    let frac = (percent % wad(1_000_000_000_000_000_000)) / wad(100_000_000_000_000_000);
    format!("{whole}.{frac:02}%")
}

/// Reads the position address out of the engine's own `PositionCreated(owner, position)` event.
async fn position_from_logs(
    state: &AppState,
    hash: alloy_primitives::B256,
) -> Result<alloy_primitives::Address> {
    let engine = state.mezo.c.engine;
    let topic = crate::abi::selector("PositionCreated(address,address)");
    let logs = state.mezo.rpc.logs(hash).await?;
    for (address, topics, _) in logs {
        if address != engine || topics.len() < 3 {
            continue;
        }
        if topics[0].0[..4] == topic {
            return Ok(alloy_primitives::Address::from_slice(&topics[2].0[12..]));
        }
    }
    bail!("no PositionCreated event from the engine in {hash:#x}")
}

#[allow(clippy::too_many_arguments)]
async fn log_tx(
    state: &AppState,
    kind: &str,
    hash: alloy_primitives::B256,
    block: u64,
    actor: alloy_primitives::Address,
    note: String,
    musd: String,
    btc: String,
    fee: impl Into<String>,
) {
    let fee = fee.into();
    let url = state.config.explorer_tx(&format!("{hash:#x}"));
    info!(kind, tx = %hash, block, %url, "{note}");
    println!("{kind}: {hash:#x}  {url}");
    let _ = state
        .store
        .record(kind, hash, url, actor, note, musd, btc, fee, block, None)
        .await;
}
