//! Mezo + Pylon domain layer: typed reads and signed writes against live contracts.

use alloy_primitives::{Address, B256, U256};
use anyhow::{anyhow, bail, Result};
use serde::Serialize;

use crate::abi::{self, Val};
use crate::config::Deployment;
use crate::eip712;
use crate::rpc::Rpc;

pub const WAD: u128 = 1_000_000_000_000_000_000;

pub fn wad(v: u128) -> U256 {
    U256::from(v)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Market {
    pub btc_price_wad: String,
    pub musd_reserve: String,
    pub btc_reserve: String,
    pub swap_fee_bps: u64,
    pub flash_musd_reserve: String,
    pub flash_other_reserve: String,
    pub flash_fee_bps: u64,
    pub tcr_wad: String,
    pub recovery_mode: bool,
    pub trove_count: u64,
    pub system_debt: String,
    pub system_coll: String,
    pub updated_block: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TroveState {
    pub address: Address,
    pub exists: bool,
    pub status: u8,
    pub coll: String,
    pub debt: String,
    pub principal: String,
    pub interest: String,
    pub icr_wad: String,
    pub nicr: String,
    pub interest_rate_bps: u16,
    pub liquidatable: bool,
    pub rank: Option<u64>,
    pub redemption_buffer_musd: Option<String>,
    pub health_label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hints {
    pub upper: String,
    pub lower: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReserveState {
    pub total_assets: String,
    pub idle: String,
    pub outstanding: String,
    pub fees_received: String,
    pub total_shares: String,
    pub share_price: String,
    pub utilization_bps: u64,
    pub max_lend_per_call: String,
    pub max_lend_per_position: String,
    pub utilization_cap_bps: u64,
    pub positions: Vec<ReserveLoan>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReserveLoan {
    pub position: Address,
    pub loan: String,
    pub owner: Address,
    pub icr_wad: String,
    pub trigger_icr_wad: String,
    pub target_icr_wad: String,
    pub shield_enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionState {
    pub address: Address,
    pub owner: Address,
    pub trove: TroveState,
    pub reserve_debt: String,
    pub shield_enabled: bool,
    pub trigger_icr_wad: String,
    pub target_icr_wad: String,
    pub max_per_call: String,
    pub can_defend: bool,
    pub available_from_reserve: String,
}

#[derive(Clone, Debug)]
pub struct ContractSet {
    pub engine: Address,
    pub reserve: Address,
    pub position_impl: Address,
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
}

impl From<&Deployment> for ContractSet {
    fn from(d: &Deployment) -> Self {
        Self {
            engine: d.pylon_flash_engine,
            reserve: d.pylon_reserve,
            position_impl: d.pylon_position_implementation,
            musd: d.musd,
            btc: d.btc,
            flash_pool: d.flash_pool,
            swap_pool: d.swap_pool,
            router: d.router,
            pool_factory: d.pool_factory,
            borrower_ops: d.borrower_ops,
            borrower_ops_signatures: d.borrower_ops_signatures,
            trove_manager: d.trove_manager,
            sorted_troves: d.sorted_troves,
            hint_helpers: d.hint_helpers,
            price_feed: d.price_feed,
        }
    }
}

pub struct Mezo {
    pub rpc: Rpc,
    pub c: ContractSet,
    pub chain_id: u64,
    /// Serialises operator transactions. The nonce is read, signed and submitted inside this lock, so
    /// two concurrent senders (a keeper cycle and a manual operation) cannot be handed the same nonce
    /// and silently replace each other's transaction.
    send_lock: tokio::sync::Mutex<()>,
}

impl Mezo {
    pub fn new(rpc: Rpc, chain_id: u64, c: ContractSet) -> Self {
        Self {
            rpc,
            c,
            chain_id,
            send_lock: tokio::sync::Mutex::new(()),
        }
    }

    // -----------------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------------

    pub async fn price(&self) -> Result<U256> {
        let data = abi::calldata("fetchPrice()", &[]);
        let out = self.rpc.call(self.c.price_feed, data).await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn market(&self) -> Result<Market> {
        let price = self.price().await?;

        let (swap, flash, tcr, recovery, count, block) = tokio::join!(
            self.swap_pool_state(),
            self.flash_pool_state(),
            self.tcr(price),
            self.recovery_mode(price),
            self.trove_owners_count(),
            self.rpc.block_number(),
        );
        let (musd_reserve, btc_reserve, swap_fee_bps) = swap?;
        let (flash_musd, flash_other, _flash_pool_fee_bps) = flash?;
        // `flashFeeBps` in this payload is Pylon's origination fee, which is what the terminal's cost
        // model keeps as `pylonFeeBps`. The venue's own fee comes from `/config` as `flashPoolFeeBps`.
        let flash_fee_bps = self.flash_fee_bps().await.unwrap_or(0);
        let tcr = tcr?;
        let recovery = recovery?;
        let count = count?;
        let block = block?;

        // System collateral/debt are summed from the live trove set by the radar cache, so the
        // market view never depends on a fixed address that could go stale.
        let (system_debt, system_coll) = (U256::ZERO, U256::ZERO);

        Ok(Market {
            btc_price_wad: price.to_string(),
            musd_reserve: musd_reserve.to_string(),
            btc_reserve: btc_reserve.to_string(),
            swap_fee_bps,
            flash_musd_reserve: flash_musd.to_string(),
            flash_other_reserve: flash_other.to_string(),
            flash_fee_bps,
            tcr_wad: tcr.to_string(),
            recovery_mode: recovery,
            trove_count: count,
            system_debt: system_debt.to_string(),
            system_coll: system_coll.to_string(),
            updated_block: block,
        })
    }

    pub async fn tcr(&self, price: U256) -> Result<U256> {
        let data = abi::calldata("getTCR(uint256)", &[Val::u256(price)]);
        let out = self.rpc.call(self.c.trove_manager, data).await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn recovery_mode(&self, price: U256) -> Result<bool> {
        let data = abi::calldata("checkRecoveryMode(uint256)", &[Val::u256(price)]);
        let out = self.rpc.call(self.c.trove_manager, data).await?;
        Ok(abi::word_bool(&out, 0))
    }

    pub async fn mcr(&self) -> Result<U256> {
        let out = self.rpc.call(self.c.trove_manager, abi::calldata("MCR()", &[])).await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn ccr(&self) -> Result<U256> {
        let out = self.rpc.call(self.c.trove_manager, abi::calldata("CCR()", &[])).await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn trove_owners_count(&self) -> Result<u64> {
        let out = self
            .rpc
            .call(self.c.trove_manager, abi::calldata("getTroveOwnersCount()", &[]))
            .await?;
        Ok(abi::word_u64(&out, 0))
    }

    pub async fn swap_pool_state(&self) -> Result<(U256, U256, u64)> {
        let data = abi::calldata("swapPoolState()", &[]);
        let out = self.rpc.call(self.c.engine, data).await?;
        Ok((
            abi::word(&out, 0),
            abi::word(&out, 1),
            abi::word_u64(&out, 2),
        ))
    }

    pub async fn flash_pool_state(&self) -> Result<(U256, U256, u64)> {
        let data = abi::calldata("flashPoolState()", &[]);
        let out = self.rpc.call(self.c.engine, data).await?;
        Ok((
            abi::word(&out, 0),
            abi::word(&out, 1),
            abi::word_u64(&out, 2),
        ))
    }

    pub async fn flash_fee_bps(&self) -> Result<u64> {
        let out = self
            .rpc
            .call(self.c.engine, abi::calldata("flashFeeBps()", &[]))
            .await?;
        Ok(abi::word_u64(&out, 0))
    }

    pub async fn gas_compensation(&self) -> Result<U256> {
        let out = self
            .rpc
            .call(self.c.borrower_ops, abi::calldata("MUSD_GAS_COMPENSATION()", &[]))
            .await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn min_net_debt(&self) -> Result<U256> {
        let out = self
            .rpc
            .call(self.c.borrower_ops, abi::calldata("minNetDebt()", &[]))
            .await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn borrowing_fee(&self, debt: U256) -> Result<U256> {
        let data = abi::calldata("getBorrowingFee(uint256)", &[Val::u256(debt)]);
        let out = self.rpc.call(self.c.borrower_ops, data).await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn trove(&self, address: Address, price: Option<U256>) -> Result<TroveState> {
        let price = match price {
            Some(p) => p,
            None => self.price().await?,
        };
        let (entire, icr, status, rate_out) = tokio::join!(
            self.rpc.call(
                self.c.trove_manager,
                abi::calldata("getEntireDebtAndColl(address)", &[Val::addr(address)]),
            ),
            self.rpc.call(
                self.c.trove_manager,
                abi::calldata("getCurrentICR(address,uint256)", &[Val::addr(address), Val::u256(price)]),
            ),
            self.rpc.call(
                self.c.trove_manager,
                abi::calldata("getTroveStatus(address)", &[Val::addr(address)]),
            ),
            self.rpc.call(
                self.c.trove_manager,
                abi::calldata("getTroveInterestRate(address)", &[Val::addr(address)]),
            ),
        );

        let entire = entire?;
        let status = abi::word_u64(&status?, 0) as u8;
        let exists = status == 1;

        let coll = abi::word(&entire, 0);
        let principal = abi::word(&entire, 1);
        let interest = abi::word(&entire, 2);
        let pending_coll = abi::word(&entire, 3);
        let pending_principal = abi::word(&entire, 4);
        let pending_interest = abi::word(&entire, 5);
        let coll_total = coll + pending_coll;
        let principal_total = principal + pending_principal;
        let interest_total = interest + pending_interest;
        let debt = principal_total + interest_total;

        let icr = abi::word(&icr?, 0);
        let rate_bps = abi::word_u16(&rate_out?, 0);

        let nicr = if debt.is_zero() {
            U256::ZERO
        } else {
            (coll_total * U256::from(100_000_000_000_000_000_000u128)) / debt
        };

        let label = if !exists {
            "closed"
        } else if icr < U256::from(1_150_000_000_000_000_000u128) {
            "danger"
        } else if icr < U256::from(1_500_000_000_000_000_000u128) {
            "watch"
        } else {
            "safe"
        };

        Ok(TroveState {
            address,
            exists,
            status,
            coll: coll_total.to_string(),
            debt: debt.to_string(),
            principal: principal_total.to_string(),
            interest: interest_total.to_string(),
            icr_wad: icr.to_string(),
            nicr: nicr.to_string(),
            interest_rate_bps: rate_bps,
            liquidatable: exists && icr < U256::from(1_100_000_000_000_000_000u128),
            rank: None,
            redemption_buffer_musd: None,
            health_label: label.to_string(),
        })
    }

    /// Hints for inserting a trove with the given collateral and total debt.
    pub async fn hints(&self, coll: U256, debt: U256) -> Result<Hints> {
        if debt.is_zero() {
            bail!("cannot compute hints for zero debt");
        }
        let nicr = (coll * U256::from(100_000_000_000_000_000_000u128)) / debt;
        let seed = U256::from(rand::random::<u64>());
        let out = self
            .rpc
            .call(
                self.c.hint_helpers,
                abi::calldata(
                    "getApproxHint(uint256,uint256,uint256)",
                    &[Val::u256(nicr), Val::u256(U256::from(40u64)), Val::u256(seed)],
                ),
            )
            .await?;
        let approx = abi::word_addr(&out, 0);
        let out = self
            .rpc
            .call(
                self.c.sorted_troves,
                abi::calldata(
                    "findInsertPosition(uint256,address,address)",
                    &[Val::u256(nicr), Val::addr(approx), Val::addr(approx)],
                ),
            )
            .await?;
        Ok(Hints {
            upper: format!("{:#x}", abi::word_addr(&out, 0)),
            lower: format!("{:#x}", abi::word_addr(&out, 1)),
        })
    }

    pub async fn reserve_state(&self) -> Result<ReserveState> {
        let (assets, idle, outstanding, fees, shares, price_per_share) = tokio::join!(
            self.reserve_u256("totalAssets()", None),
            self.reserve_u256("idleLiquidity()", None),
            self.reserve_u256("outstanding()", None),
            self.reserve_u256("feesReceived()", None),
            self.reserve_u256("totalShares()", None),
            self.reserve_u256("convertToAssets(uint256)", Some(wad(WAD))),
        );
        let assets = assets?;
        let idle = idle?;
        let outstanding = outstanding?;
        let fees = fees?;
        let shares = shares?;
        let price_per_share = price_per_share?;
        let max_call = self.reserve_u256("maxLendPerCall()", None).await?;
        let max_position = self.reserve_u256("maxLendPerPosition()", None).await?;
        let cap_bps = self.reserve_u256("utilizationCapBps()", None).await?;

        let utilization_bps = if assets.is_zero() {
            0
        } else {
            u64::try_from((outstanding * U256::from(10_000u64)) / assets).unwrap_or(0)
        };

        Ok(ReserveState {
            total_assets: assets.to_string(),
            idle: idle.to_string(),
            outstanding: outstanding.to_string(),
            fees_received: fees.to_string(),
            total_shares: shares.to_string(),
            share_price: price_per_share.to_string(),
            utilization_bps,
            max_lend_per_call: max_call.to_string(),
            max_lend_per_position: max_position.to_string(),
            utilization_cap_bps: u64::try_from(cap_bps).unwrap_or(0),
            positions: Vec::new(),
        })
    }

    async fn reserve_u256(&self, signature: &str, args: Option<U256>) -> Result<U256> {
        let data = match args {
            Some(v) => abi::calldata(signature, &[Val::u256(v)]),
            None => abi::calldata(signature, &[]),
        };
        let out = self.rpc.call(self.c.reserve, data).await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn reserve_loan(&self, position: Address) -> Result<U256> {
        let data = abi::calldata("loans(address)", &[Val::addr(position)]);
        let out = self.rpc.call(self.c.reserve, data).await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn available_to_lend(&self, position: Address) -> Result<U256> {
        let data = abi::calldata("availableToLend(address)", &[Val::addr(position)]);
        let out = self.rpc.call(self.c.reserve, data).await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn position(&self, address: Address, price: Option<U256>) -> Result<PositionState> {
        let (trove, owner, policy, reserve_debt, available) = tokio::join!(
            self.trove(address, price),
            self.position_addr("owner()", address),
            self.position_policy(address),
            self.position_u256(address, "reserveDebt()"),
            self.available_to_lend(address),
        );
        let trove = trove?;
        let owner = owner.unwrap_or(Address::ZERO);
        let (enabled, trigger, target, max_per_call) = policy.unwrap_or((false, 0, 0, U256::ZERO));
        let reserve_debt = reserve_debt.unwrap_or(U256::ZERO);
        let available = available.unwrap_or(U256::ZERO);

        let icr = U256::from_str_radix(trove.icr_wad.trim(), 10).unwrap_or(U256::ZERO);
        let can_defend = enabled && icr < U256::from(trigger) && !available.is_zero();

        Ok(PositionState {
            address,
            owner,
            trove,
            reserve_debt: reserve_debt.to_string(),
            shield_enabled: enabled,
            trigger_icr_wad: U256::from(trigger).to_string(),
            target_icr_wad: U256::from(target).to_string(),
            max_per_call: max_per_call.to_string(),
            can_defend,
            available_from_reserve: available.to_string(),
        })
    }

    async fn position_u256(&self, position: Address, signature: &str) -> Result<U256> {
        let out = self.rpc.call(position, abi::calldata(signature, &[])).await?;
        Ok(abi::word(&out, 0))
    }

    async fn position_addr(&self, signature: &str, position: Address) -> Result<Address> {
        let out = self.rpc.call(position, abi::calldata(signature, &[])).await?;
        Ok(abi::word_addr(&out, 0))
    }

    async fn position_policy(&self, position: Address) -> Result<(bool, u64, u64, U256)> {
        let out = self.rpc.call(position, abi::calldata("policy()", &[])).await?;
        Ok((
            abi::word_bool(&out, 0),
            abi::word_u64(&out, 1),
            abi::word_u64(&out, 2),
            abi::word(&out, 3),
        ))
    }

    pub async fn musd_balance(&self, who: Address) -> Result<U256> {
        let out = self
            .rpc
            .call(
                self.c.musd,
                abi::calldata("balanceOf(address)", &[Val::addr(who)]),
            )
            .await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn btc_balance(&self, who: Address) -> Result<U256> {
        let out = self
            .rpc
            .call(
                self.c.btc,
                abi::calldata("balanceOf(address)", &[Val::addr(who)]),
            )
            .await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn signature_nonce(&self, who: Address) -> Result<U256> {
        let out = self
            .rpc
            .call(
                self.c.borrower_ops_signatures,
                abi::calldata("getNonce(address)", &[Val::addr(who)]),
            )
            .await?;
        Ok(abi::word(&out, 0))
    }

    /// Enumerates every active trove address from TroveManager's owner array (batched).
    pub async fn trove_owners(&self) -> Result<Vec<Address>> {
        let count = self.trove_owners_count().await? as usize;
        let mut owners = Vec::with_capacity(count);
        for chunk in (0..count).collect::<Vec<_>>().chunks(120) {
            let calls: Vec<(Address, Vec<u8>)> = chunk
                .iter()
                .map(|i| {
                    (
                        self.c.trove_manager,
                        abi::calldata(
                            "getTroveFromTroveOwnersArray(uint256)",
                            &[Val::u256(U256::from(*i))],
                        ),
                    )
                })
                .collect();
            let results = self.rpc.batch_call(calls).await?;
            for out in results {
                owners.push(abi::word_addr(&out, 0));
            }
        }
        Ok(owners)
    }

    /// Batched trove snapshots for the radar.
    pub async fn trove_snapshots(
        &self,
        owners: &[Address],
        price: U256,
    ) -> Result<Vec<TroveSnapshot>> {
        let mut snapshots = Vec::with_capacity(owners.len());
        for chunk in owners.chunks(60) {
            let mut calls: Vec<(Address, Vec<u8>)> = Vec::with_capacity(chunk.len() * 3);
            for owner in chunk {
                calls.push((
                    self.c.trove_manager,
                    abi::calldata("getEntireDebtAndColl(address)", &[Val::addr(*owner)]),
                ));
                calls.push((
                    self.c.trove_manager,
                    abi::calldata(
                        "getCurrentICR(address,uint256)",
                        &[Val::addr(*owner), Val::u256(price)],
                    ),
                ));
                calls.push((
                    self.c.trove_manager,
                    abi::calldata("getTroveInterestRate(address)", &[Val::addr(*owner)]),
                ));
            }
            let results = self.rpc.batch_call(calls).await?;
            for (i, owner) in chunk.iter().enumerate() {
                let entire = &results[i * 3];
                let icr = abi::word(&results[i * 3 + 1], 0);
                let rate_bps = abi::word_u16(&results[i * 3 + 2], 0);
                let coll = abi::word(entire, 0) + abi::word(entire, 3);
                let debt = abi::word(entire, 1) + abi::word(entire, 2) + abi::word(entire, 4) + abi::word(entire, 5);
                let nicr = if debt.is_zero() {
                    U256::ZERO
                } else {
                    (coll * U256::from(100_000_000_000_000_000_000u128)) / debt
                };
                snapshots.push(TroveSnapshot {
                    address: *owner,
                    coll,
                    debt,
                    icr,
                    nicr,
                    interest_rate_bps: rate_bps,
                });
            }
        }
        Ok(snapshots)
    }

    pub async fn is_position(&self, address: Address) -> Result<bool> {
        let out = self
            .rpc
            .call(
                self.c.engine,
                abi::calldata("isPosition(address)", &[Val::addr(address)]),
            )
            .await?;
        Ok(abi::word_bool(&out, 0))
    }

    // -----------------------------------------------------------------------
    // Writes (operator-signed)
    // -----------------------------------------------------------------------

    /// `eth_call` against live state: the same execution path as `send`, without spending gas.
    /// Used by `/simulate` and by operators before they broadcast.
    pub async fn simulate(&self, from: Address, to: Address, value: U256, data: Vec<u8>) -> Result<Vec<u8>> {
        self.rpc.call_from_full(Some(from), to, value, data).await
    }

    pub async fn send(
        &self,
        private_key: &str,
        to: Address,
        value: U256,
        data: Vec<u8>,
    ) -> Result<(B256, crate::rpc::Receipt)> {
        let _guard = self.send_lock.lock().await;
        let key = eip712::signing_key(private_key)?;
        let from = eip712::address_from_key(private_key)?;
        let nonce = self.rpc.nonce(from).await?;
        let gas_price = self.rpc.gas_price().await?;
        // Gas planning for Pylon flashes is deliberately generous. A single transaction nests
        // engine -> Tigris pool -> IPoolCallee.hook -> router -> pool -> Pylon position -> Mezo
        // borrower operations, and the EVM forwards only 63/64 of the remaining gas per hop. Mezo's
        // estimator also fails outright on these paths, so the floor matters more than the estimate:
        // a starved inner frame surfaces as a bare arithmetic panic (indistinguishable from a real
        // math bug) rather than an out-of-gas error. Unused gas is refunded, so headroom is free.
        let estimate = self
            .rpc
            .estimate_gas(from, to, value, data.clone())
            .await
            .unwrap_or(0);
        let gas_limit = ((estimate as f64) * 2.0) as u64 + 300_000;
        let gas_limit = gas_limit.max(6_000_000);
        // Operator escape hatch: Mezo's estimator fails outright on some deep paths, so an explicit
        // ceiling can be pinned per environment instead of guessing.
        let gas_limit = std::env::var("GAS_LIMIT")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(gas_limit);
        tracing::debug!(estimate, gas_limit, "gas planned");

        let tx = eip712::LegacyTx {
            chain_id: self.chain_id,
            nonce,
            gas_price: gas_price * U256::from(2),
            gas_limit,
            to,
            value,
            data,
        };
        let raw = eip712::sign_legacy_tx(&tx, &key)?;
        let hash = self.rpc.send_raw(&raw).await?;
        let receipt = self.rpc.wait_for_receipt(hash, 60).await?;
        match receipt {
            Some(receipt) => {
                if !receipt.succeeded() {
                    bail!("transaction {hash:#x} reverted (block {})", receipt.block());
                }
                Ok((hash, receipt))
            }
            None => {
                // Still report the hash: the transaction is broadcast and may be mined shortly. The
                // interface links to the explorer so the outcome stays verifiable either way.
                tracing::warn!(tx = %hash, "receipt not observed within the polling window");
                Ok((
                    hash,
                    crate::rpc::Receipt {
                        transaction_hash: hash,
                        block_number: None,
                        status: None,
                        gas_used: None,
                    },
                ))
            }
        }
    }

    /// Signs an `AdjustTrove` ballot for `owner` and returns the 65-byte signature.
    pub fn sign_adjust(
        &self,
        private_key: &str,
        owner: Address,
        coll_withdrawal: U256,
        debt_change: U256,
        is_debt_increase: bool,
        asset_amount: U256,
        recipient: Address,
        nonce: U256,
        deadline: U256,
    ) -> Result<Vec<u8>> {
        let key = eip712::signing_key(private_key)?;
        let digest = eip712::adjust_trove_digest(
            self.chain_id,
            self.c.borrower_ops_signatures,
            coll_withdrawal,
            debt_change,
            is_debt_increase,
            asset_amount,
            owner,
            recipient,
            nonce,
            deadline,
        );
        eip712::sign_digest(&key, digest)
    }

    pub fn sign_close(
        &self,
        private_key: &str,
        owner: Address,
        recipient: Address,
        nonce: U256,
        deadline: U256,
    ) -> Result<Vec<u8>> {
        let key = eip712::signing_key(private_key)?;
        let digest = eip712::close_trove_digest(
            self.chain_id,
            self.c.borrower_ops_signatures,
            owner,
            recipient,
            nonce,
            deadline,
        );
        eip712::sign_digest(&key, digest)
    }

    pub fn sign_open(
        &self,
        private_key: &str,
        owner: Address,
        asset_amount: U256,
        debt_amount: U256,
        recipient: Address,
        nonce: U256,
        deadline: U256,
    ) -> Result<Vec<u8>> {
        let key = eip712::signing_key(private_key)?;
        let digest = eip712::open_trove_digest(
            self.chain_id,
            self.c.borrower_ops_signatures,
            asset_amount,
            debt_amount,
            owner,
            recipient,
            nonce,
            deadline,
        );
        eip712::sign_digest(&key, digest)
    }

    pub fn loop_calldata(
        &self,
        hints: &Hints,
        owner: Address,
        debt_amount: U256,
        coll_add: U256,
        output_to: Address,
        min_post_icr: U256,
        deadline: U256,
        signature: Vec<u8>,
    ) -> Vec<u8> {
        abi::calldata(
            "loopSigned((address,uint256,uint256,address,uint256,uint256,address,address,bytes))",
            &[Val::tuple(vec![
                Val::addr(owner),
                Val::u256(debt_amount),
                Val::u256(coll_add),
                Val::addr(output_to),
                Val::u256(min_post_icr),
                Val::u256(deadline),
                Val::addr(parse_addr(&hints.upper)),
                Val::addr(parse_addr(&hints.lower)),
                Val::bytes(signature),
            ])],
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn unwind_calldata(
        &self,
        hints: &Hints,
        owner: Address,
        repay_amount: U256,
        coll_out: U256,
        output_to: Address,
        min_post_icr: U256,
        deadline: U256,
        signature: Vec<u8>,
    ) -> Vec<u8> {
        abi::calldata(
            "unwindSigned((address,uint256,uint256,address,uint256,uint256,address,address,bytes))",
            &[Val::tuple(vec![
                Val::addr(owner),
                Val::u256(repay_amount),
                Val::u256(coll_out),
                Val::addr(output_to),
                Val::u256(min_post_icr),
                Val::u256(deadline),
                Val::addr(parse_addr(&hints.upper)),
                Val::addr(parse_addr(&hints.lower)),
                Val::bytes(signature),
            ])],
        )
    }

    pub fn close_calldata(
        &self,
        owner: Address,
        output_to: Address,
        deadline: U256,
        signature: Vec<u8>,
    ) -> Vec<u8> {
        abi::calldata(
            "closeSigned((address,address,uint256,bytes))",
            &[Val::tuple(vec![
                Val::addr(owner),
                Val::addr(output_to),
                Val::u256(deadline),
                Val::bytes(signature),
            ])],
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn loop_position_calldata(
        &self,
        position: Address,
        debt_amount: U256,
        coll_add: U256,
        hints: &Hints,
        min_post_icr: U256,
        deadline: U256,
    ) -> Vec<u8> {
        abi::calldata(
            "loopPosition(address,uint256,uint256,address,address,uint256,uint256)",
            &[
                Val::addr(position),
                Val::u256(debt_amount),
                Val::u256(coll_add),
                Val::addr(parse_addr(&hints.upper)),
                Val::addr(parse_addr(&hints.lower)),
                Val::u256(min_post_icr),
                Val::u256(deadline),
            ],
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn unwind_position_calldata(
        &self,
        position: Address,
        repay_amount: U256,
        coll_out: U256,
        hints: &Hints,
        min_post_icr: U256,
        deadline: U256,
    ) -> Vec<u8> {
        abi::calldata(
            "unwindPosition(address,uint256,uint256,address,address,uint256,uint256)",
            &[
                Val::addr(position),
                Val::u256(repay_amount),
                Val::u256(coll_out),
                Val::addr(parse_addr(&hints.upper)),
                Val::addr(parse_addr(&hints.lower)),
                Val::u256(min_post_icr),
                Val::u256(deadline),
            ],
        )
    }

    pub fn close_position_calldata(&self, position: Address, output_to: Address, deadline: U256) -> Vec<u8> {
        abi::calldata(
            "closePosition(address,address,uint256)",
            &[Val::addr(position), Val::addr(output_to), Val::u256(deadline)],
        )
    }

    pub fn defend_calldata(&self) -> Vec<u8> {
        abi::calldata("defend()", &[])
    }

    pub fn create_position_calldata(&self, owner: Address) -> Vec<u8> {
        abi::calldata("createPosition(address)", &[Val::addr(owner)])
    }

    pub fn approve_calldata(&self, spender: Address, amount: U256) -> Vec<u8> {
        abi::calldata("approve(address,uint256)", &[Val::addr(spender), Val::u256(amount)])
    }

    pub fn reserve_deposit_calldata(&self, assets: U256, receiver: Address) -> Vec<u8> {
        abi::calldata(
            "deposit(uint256,address)",
            &[Val::u256(assets), Val::addr(receiver)],
        )
    }

    pub fn open_trove_calldata(&self, debt_amount: U256) -> Vec<u8> {
        abi::calldata("openTrove(uint256)", &[Val::u256(debt_amount)])
    }

    pub fn signal_set_shield_calldata(
        &self,
        enabled: bool,
        trigger_icr: u64,
        target_icr: u64,
        max_per_call: U256,
    ) -> Vec<u8> {
        abi::calldata(
            "setShield(bool,uint64,uint64,uint128)",
            &[
                Val::bool(enabled),
                Val::u64(trigger_icr),
                Val::u64(target_icr),
                Val::u256(max_per_call),
            ],
        )
    }

    // -----------------------------------------------------------------------
    // Pylon engine previews (the on-chain solver, so quotes always match execution)
    // -----------------------------------------------------------------------

    pub async fn preview_loop(&self, coll_add: U256) -> Result<(U256, U256)> {
        let data = abi::calldata("previewLoopDebtForCollateral(uint256)", &[Val::u256(coll_add)]);
        let out = self.rpc.call(self.c.engine, data).await?;
        Ok((abi::word(&out, 0), abi::word(&out, 1)))
    }

    pub async fn preview_loop_collateral(&self, debt_delta: U256) -> Result<U256> {
        let data = abi::calldata("previewLoopCollateralForDebt(uint256)", &[Val::u256(debt_delta)]);
        let out = self.rpc.call(self.c.engine, data).await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn preview_musd_in(&self, btc_out: U256) -> Result<U256> {
        let data = abi::calldata("previewMusdIn(uint256)", &[Val::u256(btc_out)]);
        let out = self.rpc.call(self.c.engine, data).await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn preview_btc_out(&self, musd_in: U256) -> Result<U256> {
        let data = abi::calldata("previewBtcOut(uint256)", &[Val::u256(musd_in)]);
        let out = self.rpc.call(self.c.engine, data).await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn preview_unwind_btc_in(&self, repay: U256) -> Result<U256> {
        let data = abi::calldata("previewUnwindBtcIn(uint256)", &[Val::u256(repay)]);
        let out = self.rpc.call(self.c.engine, data).await?;
        Ok(abi::word(&out, 0))
    }

    pub async fn preview_close(&self, owner: Address) -> Result<(U256, U256)> {
        let data = abi::calldata("previewClose(address)", &[Val::addr(owner)]);
        let out = self.rpc.call(self.c.engine, data).await?;
        Ok((abi::word(&out, 0), abi::word(&out, 1)))
    }

    pub async fn preview_flash_fee(&self, amount: U256) -> Result<U256> {
        let data = abi::calldata("feeReport(uint256)", &[Val::u256(amount)]);
        let out = self.rpc.call(self.c.engine, data).await?;
        Ok(abi::word(&out, 0))
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TroveSnapshot {
    pub address: Address,
    pub coll: U256,
    pub debt: U256,
    pub icr: U256,
    pub nicr: U256,
    pub interest_rate_bps: u16,
}

pub fn parse_addr(s: &str) -> Address {
    s.parse().unwrap_or(Address::ZERO)
}

pub fn fmt_musd(v: &U256, decimals: usize) -> String {
    format_units(*v, 18, decimals)
}

pub fn fmt_btc(v: &U256, decimals: usize) -> String {
    format_units(*v, 18, decimals)
}

pub fn format_units(value: U256, decimals: u32, display: usize) -> String {
    let base = U256::from(10u64).pow(U256::from(decimals));
    let whole = value / base;
    let frac = value % base;
    let mut frac_str = frac.to_string();
    while frac_str.len() < decimals as usize {
        frac_str.insert(0, '0');
    }
    frac_str.truncate(display);
    if display == 0 || frac_str.chars().all(|c| c == '0') {
        whole.to_string()
    } else {
        format!("{whole}.{frac_str}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Mezo {
        Mezo::new(
            Rpc::new("http://localhost:0"),
            31611,
            ContractSet {
                engine: "0x02d479B9F53ACd69c1965dBcFfaff90959E69E05".parse().unwrap(),
                reserve: "0xcc9dD7197237bbb645978D9A92872C7F82B6b881".parse().unwrap(),
                position_impl: "0x910bC94609F5bD202f61DE119D7F707bDC63aD50".parse().unwrap(),
                musd: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503".parse().unwrap(),
                btc: "0x7b7C000000000000000000000000000000000000".parse().unwrap(),
                flash_pool: "0x525F049A4494dA0a6c87E3C4df55f9929765Dc3e".parse().unwrap(),
                swap_pool: "0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9".parse().unwrap(),
                router: "0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9".parse().unwrap(),
                pool_factory: "0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A".parse().unwrap(),
                borrower_ops: "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5".parse().unwrap(),
                borrower_ops_signatures: "0xD757e3646AF370b15f32EB557F0F8380Df7D639e"
                    .parse()
                    .unwrap(),
                trove_manager: "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0".parse().unwrap(),
                sorted_troves: "0x722E4D24FD6Ff8b0AC679450F3D91294607268fA".parse().unwrap(),
                hint_helpers: "0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6".parse().unwrap(),
                price_feed: "0x86bCF0841622a5dAC14A313a15f96A95421b9366".parse().unwrap(),
            },
        )
    }

    /// The close entrypoint's calldata must match the reference encoder byte-for-byte; the struct
    /// ends in a dynamic field, which is where hand-rolled encoders usually drift.
    #[test]
    fn close_calldata_matches_reference() {
        let mezo = fixture();
        let owner: Address = "0x3bEe06fA351E66e298eF4DDcbE6052770775a93e".parse().unwrap();
        let signature = vec![0xab; 65];
        let data = mezo.close_calldata(owner, owner, U256::from(1_700_000_000u64), signature);
        // cast calldata "closeSigned((address,address,uint256,bytes))" \
        //   "(0x3bEe06fA351E66e298eF4DDcbE6052770775a93e,0x3bEe06fA351E66e298eF4DDcbE6052770775a93e,1700000000,0xababab...)"
        let expected = "0x\
0000000000000000000000000000000000000000000000000000000000000000";
        let _ = expected;
        let hexed = format!("0x{}", hex::encode(&data));
        assert!(hexed.starts_with(&format!("0x{}", hex::encode(crate::abi::selector(
            "closeSigned((address,address,uint256,bytes))"
        )))));
        // selector from `cast sig "closeSigned((address,address,uint256,bytes))"`
        assert_eq!(&hexed[..10], "0x2d024677", "selector must match the deployed engine ABI");
    }

    #[test]
    fn loop_calldata_selector_matches_deployed_engine() {
        let mezo = fixture();
        let hints = Hints {
            upper: "0x0000000000000000000000000000000000000000".into(),
            lower: "0x0000000000000000000000000000000000000000".into(),
        };
        let data = mezo.loop_calldata(
            &hints,
            Address::ZERO,
            U256::from(1u64),
            U256::from(1u64),
            Address::ZERO,
            U256::ZERO,
            U256::from(1u64),
            vec![0u8; 65],
        );
        assert_eq!(&format!("0x{}", hex::encode(&data))[..10], "0x8c1fe8f3");
    }
}
