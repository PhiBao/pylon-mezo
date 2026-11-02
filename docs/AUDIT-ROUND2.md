# Pylon — security review, round 2

**Date:** 2026-11-02
**Target:** `PhiBao/pylon-mezo` — `PylonFlashEngine`, `PylonPosition`, `PylonReserve`, relay, deployment config
**Environment:** local Foundry harness (mocked Mezo/Tigris), read-only Mezo testnet (31611) and mainnet (31612)
**Authorization:** repository owner, own code. No mainnet transactions, no third-party accounts.

## Summary

Ten findings: **4 High, 3 Medium, 2 Low, 1 rejected**. Nine were valid; seven are fixed with
regression tests, two are accepted and documented. The suite is now **51 passing Foundry tests**.

The round started from an external hunter's report on `claimCollateralSurplus` and a judge's review
of the Wave 1 submission. Both were reproduced. Two further issues were found during the review:
the engine could re-point its reserve while loans were live, and the position implementation could
change without delay.

| ID | Severity | Finding | Status |
|---|---|---|---|
| PYL-01 | High | Claimed surplus bypasses an open reserve loan | Fixed |
| PYL-02 | High | Relay ballot named the owner instead of the engine | Fixed |
| PYL-03 | High | Engine reserve handover could redirect repayments | Fixed |
| PYL-04 | Medium | Loop paths did not pre-check `maxBorrowingCapacity` | Fixed |
| PYL-05 | Medium | Debt increases not guarded against Recovery Mode | Fixed |
| PYL-06 | High | Reserve admin actions were immediate | Fixed |
| PYL-07 | Medium | Position implementation change had no delay | Fixed |
| PYL-08 | — | `defend()` allegedly double-counts pending redistribution | Rejected |
| PYL-09 | Low | Reserve cap updates remain immediate | Accepted |
| PYL-10 | Low | `rescueToken` can move arbitrary tokens outside a flash | Accepted |

## High

### PYL-01 — Surplus bypasses the reserve claim

`claimCollateralSurplus()` forwarded recovered BTC to the owner without checking `reserveDebt`,
while `withdrawCollateral`, `executeTroveAdjust` and `executeClose` all refuse in that state. A
shielded position that ends with a claimable surplus could therefore hand the collateral to its
owner and leave the reserve with a claim on an empty position; the loss could only be cleared with a
write-off.

**Fix:** the claim reverts with `ReserveDebtOutstanding` while a loan is open, matching every other
outflow. Regression: `test_claimCollateralSurplus_blockedWhileReserveDebtOpen`.

### PYL-02 — Relay ballot recipient

The engine calls `adjustTroveWithSignature(..., recipient = address(this))` and
`closeTroveWithSignature(..., address(this), ...)`. A recent client change signed the owner instead,
so the relay's digest no longer matched and the native-trove route reverted. Positions were
unaffected because they ignore the signature, which is why the demo still worked.

**Fix:** all three relay operations sign `recipient = engine`. Verified against `_adjustSigned` and
`_runExit`.

### PYL-03 — Reserve handover with live loans

`engine.setReserve()` was a one-transaction owner call, and positions resolve `engine.reserve()`
dynamically. Re-pointing it while a defence loan was outstanding would send later repayments (and
`recordRepayment`) to a reserve that never lent the MUSD, leaving the original depositors with an
unpayable claim.

**Fix:** `setReserve` refuses while the current reserve reports `outstanding() != 0`, and later
handovers are two-step with a 2-day delay (`applyReserve`). First wiring at deployment stays
immediate. Regression: `test_engine_setReserveRefusedWhileReserveHasLoans`,
`test_engine_setReserveIsTwoStep`.

### PYL-06 — Immediate reserve admin

`setEngine` and `writeOffLoan` were single-owner, single-transaction powers. A write-off moves the
loss to depositors immediately; an engine handover changes who receives fees and registrations.

**Fix:** write-off and (post-deployment) engine changes are two-step with a 2-day public delay
(`proposeWriteOff`/`applyWriteOff`, `setEngine`/`applyEngine`). `setEngine` still refuses while
loans are outstanding. `applyEngine` re-checks it. Regressions:
`test_reserve_writeOffClearsThePositionMirror`, `test_stuckPositionIsReleasedByWriteOff`,
`test_reserve_refusesEngineHandoverWithLiveLoans`.

## Medium

### PYL-04 — `maxBorrowingCapacity`

Mezo stores a per-trove capacity and enforces it inside `adjustTrove`. The loop paths did not check
it, so an oversized loop quoted successfully and reverted inside the flash. `_requireBorrowingCapacity`
now reads `getTroveMaxBorrowingCapacity` (and accrues interest first) and reverts pre-flight with
`ExceedsBorrowingCapacity` on both `loopSigned` and `loopPosition`.

### PYL-05 — Recovery Mode

New debt is not permitted in Recovery Mode. Both loop paths now call
`troveManager.checkRecoveryMode(price)` and revert with `RecoveryMode` before the flash.
Regression: `test_loopSigned_revertsInRecoveryMode`.

### PYL-07 — Position implementation delay

`setPositionImplementation` applied to every new clone in the same block. It is now two-step with a
2-day delay; existing positions keep their implementation. Regression:
`test_engine_setImplementationIsTwoStep`.

## Rejected

**PYL-08 — pending redistribution "double counting".** Mezo's `getEntireDebtAndColl` returns raw
`coll`, `principal`, `interest` **plus** `pendingCollateral`, `pendingPrincipal`,
`pendingInterest` separately (source: `mezo-org/musd`,
`solidity/contracts/TroveManager.sol`). Adding the pending values in `defend()` is correct. A quick
check of the deployed getter's return shape matches. No change made; the reasoning is recorded here
so the next reviewer does not re-raise it.

## Accepted and documented

- **PYL-09** — `setLimits` / `setConcentration` apply immediately. Bounded by hard ceilings
  (utilisation ≤ 95%, defence fee ≤ 5%) and only affect future operations. A timelock is the right
  next step once the owner is a multisig.
- **PYL-10** — `rescueToken` can move tokens sent to the engine by mistake; blocked during a flash.

## Coverage and negative results

Covered and found sound: flash repayment and fee rounding (ceil), hook validation (pool, sender,
amount, op), clone initialization (engine-only, one-shot), share pricing (pre-transfer snapshot,
virtual offsets, donation resistance), per-call/per-position/utilisation caps, defence fee rounding,
`recordRepayment` bounds, signature nonce/deadline handling.

Not covered: mainnet execution (unfunded trove), Mezo core internals beyond the published source,
economic attacks requiring large capital, frontend.

## Residual risks

1. **Single EOA owner.** All admin paths (limits, treasury, rescue, timelock proposals) are one key.
   Multisig is the next control.
2. **No pause.** An incident requires the owner to act per function.
3. **Relay executions are not written to the proof ledger.** The transaction is on chain, but the
   engine's ledger does not record it.
4. **Mainnet flow unexercised.** The same bytecode is deployed on 31612, but no trove was funded;
   behaviour there is inferred, not observed.
5. **Mezo core trust.** TroveManager/SortedTroves/Tigris are assumed correct.

## Recommendation

Fix round is complete and tested. Before third-party capital: independent audit, multisig ownership,
a pause or circuit breaker on the reserve, relay ledger recording, and one funded mainnet round trip
(open → loop → unwind → close) with published hashes.
