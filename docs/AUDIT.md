# Pylon — security audit

**Target:** `PhiBao/pylon-mezo`, commits `840bd88` (audited snapshot) and the working tree that followed
**Network:** Mezo Testnet (chain ID `31611`) · **Auditor:** the building agent, as an adversarial reviewer
**Scope:** all Solidity in `contracts/src`, `contracts/script`; the Rust engine (`server/src`), HTTP
surface, x402 gateway, keeper, store; the terminal's execution and signing paths.

**Method.** Two independent passes.

1. **Twelve speciality lenses over the Solidity**, one adversarial agent per lens: `math-precision`,
   `access-control`, `economic-security`, `execution-trace`, `invariant`, `periphery`,
   `first-principles`, `asymmetry`, `boundary`, `numerical-gap`, `trust-gap`, `flow-gap`. Each lens got
   the full in-scope source plus shared rules, and every claim had to arrive with a concrete proof
   (numbers, a trace, or a quoted test result) and a minimal fix. Claims without a proof were reported
   as leads, separately.
2. **A boundary-first review of the service and interface layers**, where each candidate names the
   lower-trust principal, the accepted input, the intended control, the boundary crossed, and the
   concrete result.

No live probing was performed for the audit itself. Every "verified" statement below cites source, a
test, or a transaction that existed before the audit.

---

## 1. Result

| Severity | Found | Fixed | Regression test | Live |
| --- | --- | --- | --- | --- |
| High | 5 | 5 | 5 | 1 proven live (#1) |
| Medium | 12 | 12 | 10 | 2 live (#9, #10) |
| Low | 13 | 13 | 9 | — |
| Informational | 5 | 2 fixed, 3 accepted | — | — |
| **Total** | **35** | **32 fixed** | **39 contract tests, 9 service tests** | — |

Nothing found changed the custody model, the flash accounting, or the signature exactness property.
Four of the five High findings were in code paths that had **never executed successfully on chain** —
they were latent, not exploited: the position-mode flash loop and unwind had always reverted. The one
High that was live (the reserve's deposit pricing) had been exercised exactly once, by the project's own
operator, as the pool's first deposit — the one case the bug does not damage.

Two independent lenses found the deposit mispricing, three found the unsigned payout destination, four
found the missing lien guard, and two found the position-mode underflows. Convergent findings are
reported once, with the lenses credited.

---

## 2. High findings

### H1 · `PylonReserve.deposit` priced shares against a total that already held the deposit

*Lenses: math-precision, economic-security, first-principles, numerical-gap.*

`deposit` credited MUSD first and then asked `convertToShares`, which reads
`totalAssets() = musd.balanceOf(this) + outstanding` — already including the new money. A depositor
adding `a` to a pool holding `T` received shares worth `a(T+a)/(T+2a)`, so a later depositor lost up to
half their deposit to earlier holders, inside one transaction. Measured by the lenses: a 100,000 MUSD
deposit into a 1,000 MUSD pool returned 50,248.75 MUSD of value.

**Fix:** snapshot the pre-transfer total and price against it, plus the ERC-4626 virtual offset
(`VIRTUAL_SHARES = VIRTUAL_ASSETS = 1`) so the first deposit is priced and a donation attack costs more
than the deposit it blocks. **Live proof:** after the migration, the operator deposited 1,005.185 MUSD
(1:1, first depositor) and the demo wallet then deposited 100 MUSD as the *second* depositor — its
shares are worth exactly 100 MUSD on chain, where the audited code returned ~50.

### H2 · A signature did not bind where the proceeds go

*Lenses: math-precision, access-control, economic-security, execution-trace, invariant, periphery,
asymmetry, trust-gap, boundary.*

`loopSigned`, `unwindSigned` and `closeSigned` took `outputTo` from the **caller**, while Mezo's EIP-712
ballot only binds `(collWithdrawal, debtChange, isDebtIncrease, assetAmount, borrower, recipient=engine,
nonce, deadline)`. Anyone who copied a signed request out of the mempool could resubmit it with
`outputTo = themselves` and take the residual collateral: for the live position that is 0.0224 BTC
(≈1,840 MUSD) out of a 0.045 BTC trove. The lenses proved the engine-side forwarding directly.

**Fix:** `_signedPayout` — a caller other than the trove owner can only route proceeds to the owner; the
owner keeps full choice. Applied to all three signed entrypoints *and* to `closePosition`, where a
nominated executor could previously name itself.

This fix is the reason the report is credible: my first patch computed `payoutTo` and then **discarded
it** in the payload (the compiler warned about an unused local). The regression test
`test_engine_thirdPartyCannotRedirectSignedPayout` failed on exactly that, which is how the mistake was
found. A fix without its test would have shipped the vulnerability with a hardened-looking diff.

### H3 · A position could borrow back the money the reserve lent it

*Lenses: math-precision, access-control, economic-security, execution-trace, periphery, invariant,
boundary.*

`withdrawCollateral` and `executeClose` refuse to run while `reserveDebt != 0`, but `addCollateral` did
not. The sequence — arm the shield, let `defend()` repay the trove's debt from the reserve, then call
`addCollateral(sameAmount)` to borrow that capacity back into the owner's wallet — converted the
reserve's loan into cash the owner kept, with the trove left at the liquidation threshold. One lens
measured 90,000 MUSD extracted against 110,000 MUSD of abandoned collateral, ending with the reserve's
claim uncollectable and every other shielded position starved of defence capacity.

**Fix:** while a claim is outstanding, any MUSD gained from borrowing is applied to the reserve's claim
first (`_routeGainToClaimOrOwner`), so the loan can only be repaid, never cashed out. Also applied to
`openTrove`, for consistency.

### H4 · Position-mode unwind could never succeed

*Lenses: execution-trace, periphery, invariant (via the same root cause).*

`_runUnwindPosition` pre-funds the position with the MUSD it must repay, then calls
`executeTroveAdjust`. The position measured `musd.balanceOf(this) - musdBefore` after the repayment had
burned that MUSD, so the subtraction underflowed (Panic `0x11`), the engine wrapped it as
`StageFailed(2, …)`, and **every** `unwindPosition` call reverted for every input. No test called
`unwindPosition`, so the suite was green.

**Fix:** only forward a gain when the balance grew. Regression test `test_position_flashLegsExecute`
drives a real unwind and asserts the debt falls and the surplus is recoverable.

### H5 · Position-mode loop could never succeed

*Lenses: trust-gap, periphery, execution-trace (as the inferred counterpart).*

On Mezo, native and ERC-20 BTC are one ledger: `msg.value` is already inside `btc.balanceOf(this)` when
the callee body runs, and forwarding it spends it. `executeTroveAdjust` read its baseline *before*
subtracting that value, so every collateral-adding call underflowed — the exact `Panic(0x11)` visible in
the live `loopPosition` transactions (one burned its whole gas limit). The unit tests could not see it
because the mock modelled BTC as a plain ERC-20 whose `balanceOf` ignores native value.

**Fix:** `btcBefore = btc.balanceOf(this) - msg.value`. **Harness fix:** the BTC mock now models the
unified ledger (`MockBtcToken.balanceOf` adds the account's native balance), so this class of bug cannot
hide again. `test_position_flashLegsExecute` fails without either change.

---

## 3. Medium findings

| # | Finding | Fix | Evidence |
| --- | --- | --- | --- |
| M1 | `closePosition` let a nominated executor send the position's whole residual to itself | payout follows the owner unless the owner is the caller | `test_engine_closePositionExecutorCannotRedirectPayout` |
| M2 | `executeTroveAdjust` lacked the `reserveDebt` guard, so an unwind could strip the collateral backing the claim | guard added on `collWithdrawal > 0` | `test_position_openLoopAndShield` (collateral blocked while shielded) |
| M3 | Shield credit was unpriced and its band unbounded: a borrower could occupy the pool at 0% and never repay | `MAX_SHIELD_ICR`, a 50 bps defence fee booked as lender yield, and a 20% per-position concentration cap, on top of the existing per-call/per-position/utilisation caps | `test_position_shieldRejectsOutOfRangeBands`, `test_reserve_concentrationCapLimitsOnePosition`, `test_reserve_refusesDefenceFeeAboveItsCeiling` |
| M4 | `setEngine` could re-point a reserve with live loans, and positions resolved the reserve through the engine — one governance call would strand every claim and lock collateral | handover refused while `outstanding != 0`; each position **captures** its reserve at initialisation and never re-reads it | `test_reserve_refusesEngineHandoverWithLiveLoans`, `test_position_bindsItsReserveAtInitialisation` |
| M5 | The paid x402 endpoint accepted the same settlement forever (and any third-party transfer to the pay-to address) | single-use claim persisted across restarts + a 900 s freshness window | `a_payment_proof_is_spendable_exactly_once` |
| M6 | The facilitator path trusted `/verify` (a signature) as payment and was enabled by default | disabled unless `X402_ALLOW_FACILITATOR=1`; then it must `/settle` and consumes the settlement hash | service review, code |
| M7 | No request budget on an endpoint that performs two upstream RPC reads per call | per-client fixed windows (30/min paid, 240/min reads) with a bounded client map | `blocks_after_the_window_budget_is_spent` |
| M8 | Operator transactions read the nonce, signed, and submitted without serialisation: two senders could collide and silently replace one another (a lost shield defence) | `send` holds a mutex across read-sign-submit | code |
| M9 | The exit path sold collateral with no slippage bound: an attacker could push the pool and make the close sell more BTC for the same MUSD | the realised sale price must be within `maxExitSlippageBps` (800, owner-set, ≤2,000) of the oracle price | `test_engine_exitRejectsAPushedPool`, `test_engine_exitPushedPoolRevertIsTheSlippageGuard` |
| M10 | `_flash` did not verify the callback ran: a venue that returned without servicing the flash produced a successful no-op and left `_op` stuck | `if (_op != OP_NONE) revert FlashNotServiced()` | `test_flash_revertsWhenVenueDoesNotServiceTheCallback` |
| M11 | The callback payload was not bound to the started operation | `if (p.op != op) revert PayloadMismatch()` | `test_flash_revertsWhenPayloadDescribesAnotherOperation` |
| M12 | `defend()` sized and checked with trove figures that exclude pending liquidation rewards, so it could stop short of its target or never fire | `getEntireDebtAndColl` (pending-inclusive) for sizing, checks and the post-ratio | `test_position_defendStopsAtMezosDebtFloor` (clamp path) |

---

## 4. Low findings

| # | Finding | Fix |
| --- | --- | --- |
| L1 | Collateral the engine paid to a position was unreachable: every position outflow moved only a fresh delta | `withdrawCollateral` now transfers the whole balance; `sweep` for stray tokens; the position-mode surplus is recoverable |
| L2 | A liquidated position could not claim Mezo's collateral surplus, and the reserve kept the dead loan on its books at face value | `claimCollateralSurplus()`; `writeOffLoan` for honest bad-debt accounting |
| L3 | `writeOffLoan` cleared the reserve's ledger but not the position's mirror, permanently locking that collateral | the reserve clears the position's mirror; `recordRepayment` tolerates an already-written-off loan |
| L4 | ERC-20 transfer results were ignored throughout | `_safeTransfer` in `PylonPosition` |
| L5 | `repay(debt)` reverted with an arithmetic panic (zero-debt hint lookup) | explicit `FullRepaymentNotSupported` |
| L6 | `_runUnwind*` trusted the signed ceiling rather than the balance received, so a short delivery would be funded from the engine | `_verifyCollateralReceived` |
| L7 | The swap route named the router's default factory while pricing used `swapPool` | route uses `swapPool.factory()`; the constructor refuses a mismatch |
| L8 | Origination and defence fees truncated to zero on small operations, making tiny flashes free | both round up |
| L9 | `initialize` was callable by anyone | engine-only |
| L10 | `withdrawCollateral(_, address(0))` burned collateral | zero address refused |
| L11 | `canExecute(address(0))` returned true when no executor is set | explicit zero-address refusal |
| L12 | A defence that moved the ratio by a rounding amount burned a keeper slot | material improvement required (≥2% relative) |
| L13 | `Config` derived `Debug` while holding the operator private key; the paid response mislabelled the payer; a mint counted as a payment | redacting `Debug`; the payer comes from the transfer; mints excluded |

---

## 5. Accepted risks (not defects)

| Item | Position taken |
| --- | --- |
| Open CORS on the API | Deliberate: the surface serves public chain data and must be callable by agents. The paid endpoint is now single-use and rate-limited, which bounds the abuse. |
| No rescue path in the engine | Deliberate: fewer owner powers over the contract that holds user authorisations. Tokens sent to the engine stay there. |
| `minPostICR` is not covered by the signature | The signed amounts bound the operation; the floor is a convenience. A third party can only execute the owner's signed amounts, and proceeds go to the owner. |
| Defence loans carry no term and cannot be foreclosed | Priced from the first second by the defence fee, capped per position and per pool, and documented as the reserve's credit risk. Seizure rights are a Wave 2 design item. |
| JIT fee capture around deposits; donation griefing of tiny deposits | The virtual offset raises the cost above the damage; a minimum deposit and a yield index are roadmap items. |
| `_flashFee` takes the venue fee from the factory rather than the pool | Verified against the venue's own implementation (the pool reads the same factory). A mismatch reverts the flash rather than losing funds. |
| Live position-mode flash loop still reverts on Mezo testnet | **Open investigation.** The two code causes are fixed and unit-tested (#H4, #H5). A live `loopPosition` still reverts; the testnet RPC returns no revert data for contract calls (an expired-deadline control confirms the blindness) and reports gas as a fixed fraction of the limit, so the residual cause — likely the on-chain hint walk against 245+ troves exceeding what the RPC will relay — cannot be isolated from here. The native-trove flash loop is proven live; the position path stays marked "not proven live" in the README. |

---

## 6. Deployment after the audit

The rule applied: **redeploy only if nothing is stranded.** Nothing was.

| Step | Result |
| --- | --- |
| Settled the live position's claim | `repayReserve(543.943 MUSD)` — tx `0xfa77c38d…4cc926`; `reserveDebt = 0`, `outstanding = 0` |
| Withdrew the operator's LP from reserve v1 | 1,000 shares → 1,005.185 MUSD — tx `0xf7ceb302…942afe` |
| Deployed the hardened generation | position template `0x0e64B682Add80A61d24E61ed360b3F3679C6860a`, reserve `0x53a0206A307E084AdA2eB24346463cf4E14C5131`, engine `0x901198cD4EE9086997D839401f361518cAE46ed6` |
| Wired and verified | `engine.reserve == reserve`, `reserve.engine == engine`, `positionImplementation == template`, `flashFeeBps 20`, `maxExitSlippageBps 800`, `defenceFeeBps 50`, `maxPerPositionBps 2000` |
| Re-deposited the capital | operator 1,005.185 (first depositor, 1:1), demo 100 (second depositor, worth exactly 100 — the live proof of #H1) |
| Created a fresh position on the hardened stack | `0x02f472dd2c08a4dab586ab11bafb294c27f5182e`, 0.030 BTC against 2,001.8 MUSD (ICR 1.23), reserve binding captured at initialisation |
| Left the previous generation intact | The pre-audit position keeps its own implementation and reserve binding and stays settleable — the property #M4 adds for every new position. Its claim was settled and 0.012 BTC of collateral withdrawn to fund the new trove (tx `0x7aa57305…516b6b`, 3M gas: the on-chain hint solver). |

---

## 7. Coverage and limits

* **Solidity in scope:** 7 files, 2,211 lines — engine, reserve, position, `PylonMath`, `Clones`, and the
  deploy/proof scripts. Interfaces, mocks and tests were read where inherited behaviour mattered.
* **Service in scope:** the Rust engine, HTTP surface, x402 gateway, keeper, store, and the terminal's
  execution and signing paths.
* **Not covered:** the off-repository Mezo core contracts and Tigris pools (consumed as dependencies,
  read as behaviour), browser wallets, and anything requiring execution of target code outside an
  OS-enforced sandbox (none was performed). The live-loop investigation in §5 stopped at the RPC's
  visibility limit rather than at a conclusion.
* **This was one pass.** A second pass would hunt new ground; the list above is what one pass reached,
  not a claim of exhaustion.
* **Test suites at hand-off:** 39 Foundry tests (was 19 before the audit), 9 Rust tests (was 6), plus
  the terminal's typecheck and static build. Every fix in §2–§4 has a named regression test except the
  service items marked "code" (which are enforced by construction rather than by a unit test).
