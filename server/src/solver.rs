//! Quote engine.
//!
//! Every quote is derived from the *deployed* Pylon engine's own preview functions plus the live
//! trove state, so what the interface shows is by construction what the contracts will enforce.

use alloy_primitives::{Address, U256};
use anyhow::Result;
use serde::Serialize;

use crate::mezo::{fmt_btc, fmt_musd, Mezo};
use crate::radar::Radar;

const BPS: u64 = 10_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopQuote {
    pub coll_add: String,
    pub coll_add_btc: String,
    pub debt_delta: String,
    pub debt_delta_musd: String,
    pub pylon_fee: String,
    pub flash_fee: String,
    pub venue_fee_bps: u64,
    pub swap_fee_bps: u64,
    pub pylon_fee_bps: u64,
    pub swap_in: String,
    pub btc_out: String,
    pub borrowing_fee: String,
    pub total_cost_musd: String,
    pub total_cost_bps: u64,
    pub effective_btc_price_wad: String,
    pub trove: Option<TroveProjection>,
    pub legs: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnwindQuote {
    pub repay: String,
    pub repay_musd: String,
    pub musd_needed: String,
    pub btc_in_needed: String,
    pub btc_in_needed_btc: String,
    pub suggested_coll_out: String,
    pub suggested_coll_out_btc: String,
    pub pylon_fee: String,
    pub flash_fee: String,
    pub trove: Option<TroveProjection>,
    pub requires_wallet_musd: bool,
    pub legs: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitQuote {
    pub owner: Address,
    pub debt: String,
    pub flash_amount: String,
    pub btc_in_needed: String,
    pub btc_back_to_owner: String,
    pub fee_musd: String,
    pub trove: Option<TroveProjection>,
    pub legs: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TroveProjection {
    pub coll: String,
    pub debt: String,
    pub icr_wad: String,
    pub collateral_delta_btc: String,
    pub leverage: String,
    pub rank: Option<u64>,
    pub redemption_buffer_musd: Option<String>,
}

pub struct Solver<'a> {
    pub mezo: &'a Mezo,
    pub radar: &'a Radar,
}

impl<'a> Solver<'a> {
    pub fn new(mezo: &'a Mezo, radar: &'a Radar) -> Self {
        Self { mezo, radar }
    }

    fn flash_fee(&self, amount: U256, venue_fee_bps: u64) -> U256 {
        if venue_fee_bps == 0 {
            return U256::ZERO;
        }
        let numerator = amount * U256::from(venue_fee_bps);
        let denominator = U256::from(BPS - venue_fee_bps);
        numerator / denominator + U256::from(1u64)
    }

    /// Loop: borrow `debtDelta` MUSD against the trove and convert it into `collAdd` BTC collateral.
    pub async fn loop_quote(&self, coll_add: U256, owner: Option<Address>) -> Result<LoopQuote> {
        let (debt_delta, pylon_fee) = self.mezo.preview_loop(coll_add).await?;
        let (_, _, venue_fee_bps) = self.mezo.flash_pool_state().await?;
        let (_, _, swap_fee_bps) = self.mezo.swap_pool_state().await?;
        let flash_fee = self.flash_fee(debt_delta, venue_fee_bps);
        let pylon_fee_bps = self.mezo.flash_fee_bps().await.unwrap_or(0);

        let swap_in = debt_delta
            .saturating_sub(pylon_fee)
            .saturating_sub(flash_fee);
        let btc_out = self.mezo.preview_btc_out(swap_in).await?;
        let borrowing_fee = self.mezo.borrowing_fee(debt_delta).await?;
        let cost = pylon_fee + flash_fee;
        let total_cost_bps = if debt_delta.is_zero() {
            0
        } else {
            u64::try_from(cost * U256::from(BPS) / debt_delta).unwrap_or(0)
        };
        let effective_price = if coll_add.is_zero() {
            U256::ZERO
        } else {
            swap_in * U256::from(10u64).pow(U256::from(18u64)) / coll_add
        };

        let trove = match owner {
            Some(owner) => self.project_trove(owner, coll_add, debt_delta + borrowing_fee).await?,
            None => None,
        };

        Ok(LoopQuote {
            coll_add: coll_add.to_string(),
            coll_add_btc: fmt_btc(&coll_add, 6),
            debt_delta: debt_delta.to_string(),
            debt_delta_musd: fmt_musd(&debt_delta, 2),
            pylon_fee: pylon_fee.to_string(),
            flash_fee: flash_fee.to_string(),
            venue_fee_bps,
            swap_fee_bps,
            pylon_fee_bps,
            swap_in: swap_in.to_string(),
            btc_out: btc_out.to_string(),
            borrowing_fee: borrowing_fee.to_string(),
            total_cost_musd: fmt_musd(&cost, 2),
            total_cost_bps,
            effective_btc_price_wad: effective_price.to_string(),
            trove,
            legs: vec![
                format!("Flash-borrow {} MUSD from the MUSD/mUSDC pool", fmt_musd(&debt_delta, 2)),
                format!("Swap {} MUSD → BTC on the MUSD/BTC pool", fmt_musd(&swap_in, 2)),
                format!("Add {} BTC collateral and borrow {} MUSD to the trove", fmt_musd(&coll_add, 6), fmt_musd(&debt_delta, 2)),
                format!("Repay the flash ({}) and route {} MUSD to the shield pool", fmt_musd(&(debt_delta + flash_fee), 2), fmt_musd(&pylon_fee, 2)),
            ],
        })
    }

    /// Unwind: repay debt out of the trove's own collateral, with zero MUSD in the wallet.
    pub async fn unwind_quote(&self, repay: U256, owner: Option<Address>) -> Result<UnwindQuote> {
        let (_, _, venue_fee_bps) = self.mezo.flash_pool_state().await?;
        let pylon_fee = self.mezo.preview_flash_fee(repay).await?;
        let flash_fee = self.flash_fee(repay, venue_fee_bps);
        let musd_needed = repay + pylon_fee + flash_fee;
        let btc_in_needed = self.mezo.preview_unwind_btc_in(repay).await?;
        let suggested = btc_in_needed + btc_in_needed / U256::from(20u64); // 5% headroom

        let trove = match owner {
            Some(owner) => {
                let state = self.mezo.trove(owner, None).await?;
                let coll = U256::from_str_radix(state.coll.trim(), 10).unwrap_or(U256::ZERO);
                let debt = U256::from_str_radix(state.debt.trim(), 10).unwrap_or(U256::ZERO);
                Some(self.project_from(state, coll.saturating_sub(suggested), debt.saturating_sub(repay), Some(suggested), true).await?)
            }
            None => None,
        };

        Ok(UnwindQuote {
            repay: repay.to_string(),
            repay_musd: fmt_musd(&repay, 2),
            musd_needed: musd_needed.to_string(),
            btc_in_needed: btc_in_needed.to_string(),
            btc_in_needed_btc: fmt_btc(&btc_in_needed, 8),
            suggested_coll_out: suggested.to_string(),
            suggested_coll_out_btc: fmt_btc(&suggested, 8),
            pylon_fee: pylon_fee.to_string(),
            flash_fee: flash_fee.to_string(),
            trove,
            requires_wallet_musd: false,
            legs: vec![
                format!("Flash-borrow exactly {} MUSD (the signed repayment)", fmt_musd(&repay, 2)),
                "Park it with BorrowerOperationsSignatures, which burns it against your trove".into(),
                format!("Withdraw {} BTC collateral to the engine", fmt_btc(&suggested, 8)),
                format!("Sell {} BTC → MUSD to repay the flash plus fees; the rest returns to you", fmt_btc(&btc_in_needed, 8)),
            ],
        })
    }

    /// Exit: close the trove entirely, funded by its own collateral.
    pub async fn exit_quote(&self, owner: Address) -> Result<ExitQuote> {
        let (btc_in, debt) = self.mezo.preview_close(owner).await?;
        let gas_comp = self.mezo.gas_compensation().await?;
        let flash_amount = debt.saturating_sub(gas_comp);
        let fee = self.mezo.preview_flash_fee(flash_amount).await?;
        let state = self.mezo.trove(owner, None).await?;
        let coll = U256::from_str_radix(state.coll.trim(), 10).unwrap_or(U256::ZERO);
        let btc_back = coll.saturating_sub(btc_in.min(coll));

        Ok(ExitQuote {
            owner,
            debt: debt.to_string(),
            flash_amount: flash_amount.to_string(),
            btc_in_needed: btc_in.to_string(),
            btc_back_to_owner: btc_back.to_string(),
            fee_musd: fee.to_string(),
            trove: Some(self.project_from(state, U256::ZERO, U256::ZERO, None, false).await?),
            legs: vec![
                format!("Flash-borrow exactly {} MUSD (trove debt less the 200 MUSD gas deposit)", fmt_musd(&flash_amount, 2)),
                "Close the trove with one EIP-712 authorisation; all collateral moves to the engine".into(),
                format!("Sell {} BTC → MUSD to repay the flash plus fees", fmt_btc(&btc_in, 8)),
                format!("Return {} BTC to your wallet — no MUSD required at any point", fmt_btc(&btc_back, 8)),
            ],
        })
    }

    async fn project_trove(
        &self,
        owner: Address,
        coll_delta: U256,
        debt_delta: U256,
    ) -> Result<Option<TroveProjection>> {
        let state = match self.mezo.trove(owner, None).await {
            Ok(s) => s,
            Err(_) => return Ok(None),
        };
        if !state.exists {
            return Ok(None);
        }
        let coll = U256::from_str_radix(state.coll.trim(), 10).unwrap_or(U256::ZERO);
        let debt = U256::from_str_radix(state.debt.trim(), 10).unwrap_or(U256::ZERO);
        Ok(Some(
            self.project_from(state, coll + coll_delta, debt + debt_delta, Some(coll_delta), true)
                .await?,
        ))
    }

    async fn project_from(
        &self,
        state: crate::mezo::TroveState,
        coll_after: U256,
        debt_after: U256,
        coll_delta: Option<U256>,
        increasing: bool,
    ) -> Result<TroveProjection> {
        let price = self
            .radar
            .cached()
            .await
            .map(|r| r.price)
            .unwrap_or(self.mezo.price().await?);
        let icr = if debt_after.is_zero() {
            U256::ZERO
        } else {
            coll_after * price / debt_after
        };
        let leverage = if icr.is_zero() {
            U256::ZERO
        } else {
            U256::from(10u64).pow(U256::from(36u64)) / icr
        };
        let rank = self.radar.cached().await.and_then(|r| {
            r.find(state.address).map(|e| e.rank)
        });
        let buffer = self
            .radar
            .cached()
            .await
            .and_then(|r| r.queue_depth_before(state.address).map(|b| b.to_string()));
        let collateral_delta = coll_delta.unwrap_or(U256::ZERO);
        let signed = if increasing {
            fmt_btc(&collateral_delta, 8)
        } else {
            format!("-{}", fmt_btc(&collateral_delta, 8))
        };
        Ok(TroveProjection {
            coll: coll_after.to_string(),
            debt: debt_after.to_string(),
            icr_wad: icr.to_string(),
            collateral_delta_btc: signed,
            leverage: format!(
                "{}.{:02}x",
                leverage / U256::from(10u64).pow(U256::from(18u64)),
                (leverage % U256::from(10u64).pow(U256::from(18u64)))
                    * U256::from(100u64)
                    / U256::from(10u64).pow(U256::from(18u64))
            ),
            rank,
            redemption_buffer_musd: buffer,
        })
    }
}
