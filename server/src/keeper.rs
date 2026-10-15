//! Keepers.
//!
//! Two jobs, both permissionless on-chain:
//!   * refresh the `SortedTroves` index and surface which troves the redemption queue is closing in on;
//!   * defend shielded Pylon positions: when a position's ICR drops below its own configured trigger,
//!     anyone (this keeper, a competing bot, or the owner) can call `defend()`, which pulls MUSD from
//!     the reserve and repays that position's own debt.

use std::time::Duration;

use alloy_primitives::{Address, U256};
use anyhow::Result;
use tracing::{info, warn};

use crate::api::AppState;
use crate::mezo::{fmt_musd, Mezo};

pub async fn run(state: AppState) -> Result<()> {
    let interval = std::env::var("KEEPER_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(45u64);
    let auto_defend = std::env::var("AUTO_DEFEND").map(|v| v == "1").unwrap_or(false);
    let operator = state.config.operator_address();

    info!(
        interval_secs = interval,
        auto_defend, "shield keeper started (defence is permissionless; this key is one caller)"
    );

    let mut ticker = tokio::time::interval(Duration::from_secs(interval));
    loop {
        ticker.tick().await;
        if let Err(e) = cycle(&state, auto_defend, operator).await {
            warn!(error = %e, "keeper cycle failed");
        }
    }
}

async fn cycle(state: &AppState, auto_defend: bool, operator: Option<Address>) -> Result<()> {
    let radar = state.radar.refresh(&state.mezo).await?;
    let nearest = radar.entries.first();
    if let Some(entry) = nearest {
        info!(
            troves = radar.entries.len(),
            tcr = %fmt_wad(&radar.tcr),
            next_in_queue = %entry.address,
            next_icr = %fmt_wad(&U256::from_str_radix(entry.icr_wad.trim(), 10).unwrap_or(U256::ZERO)),
            queue_depth_musd = %fmt_musd(&U256::from_str_radix(&entry.redemption_buffer_musd, 10).unwrap_or(U256::ZERO), 0),
            "radar refreshed"
        );
    }

    if let Some(operator) = operator {
        if let Some(entry) = radar.find(operator) {
            info!(
                rank = entry.rank,
                icr = %fmt_wad(&U256::from_str_radix(entry.icr_wad.trim(), 10).unwrap_or(U256::ZERO)),
                buffer_musd = %fmt_musd(&U256::from_str_radix(&entry.redemption_buffer_musd, 10).unwrap_or(U256::ZERO), 0),
                "operator trove position in the redemption queue"
            );
        }
    }

    let positions = state.store.positions().await;
    for position in positions {
        let health = match state.mezo.position(position, None).await {
            Ok(h) => h,
            Err(e) => {
                warn!(%position, error = %e, "position read failed");
                continue;
            }
        };
        if !health.trove.exists {
            continue;
        }
        let icr = U256::from_str_radix(health.trove.icr_wad.trim(), 10).unwrap_or(U256::ZERO);
        let trigger = U256::from_str_radix(health.trigger_icr_wad.trim(), 10).unwrap_or(U256::ZERO);
        let in_band = health.shield_enabled && icr < trigger;
        info!(
            %position,
            icr = %fmt_wad(&icr),
            trigger = %fmt_wad(&trigger),
            reserve_claim = %health.reserve_debt,
            available = %health.available_from_reserve,
            in_band,
            "position health"
        );

        if in_band && auto_defend {
            let Some(key) = state.config.operator_key.clone() else {
                continue;
            };
            match Mezo::send(
                &state.mezo,
                &key,
                position,
                U256::ZERO,
                state.mezo.defend_calldata(),
            )
            .await
            {
                Ok((hash, receipt)) => {
                    let after = state.mezo.position(position, None).await?;
                    let url = state.config.explorer_tx(&format!("{hash:#x}"));
                    info!(%position, tx = %hash, %url, "shield defence executed");
                    state
                        .store
                        .record(
                            "keeper-defend",
                            hash,
                            url,
                            operator.unwrap_or(Address::ZERO),
                            format!(
                                "keeper defence: ICR {} → {}",
                                fmt_wad(&icr),
                                fmt_wad(&U256::from_str_radix(after.trove.icr_wad.trim(), 10).unwrap_or(U256::ZERO))
                            ),
                            after.reserve_debt.clone(),
                            "0".into(),
                            "0".into(),
                            receipt.block(),
                            receipt.gas_used.clone(),
                        )
                        .await?;
                }
                Err(e) => warn!(%position, error = %e, "defence failed"),
            }
        }
    }

    Ok(())
}

fn fmt_wad(v: &U256) -> String {
    let scale = U256::from(1_000_000_000_000_000_000u128);
    let whole = v / scale;
    let frac = (v % scale) / U256::from(10_000_000_000_000_000u128);
    format!("{whole}.{frac:02}%")
}
