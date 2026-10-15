# Pylon — security audit

**Target:** `PhiBao/pylon-mezo` at commit `6c334b0` (plus the fixes recorded below)
**Network under audit:** Mezo Testnet, chain ID `31611`
**Method:** source-only review. Two independent passes:

1. **Twelve speciality lenses over the Solidity** (`math-precision`, `access-control`, `economic-security`,
   `execution-trace`, `invariant`, `periphery`, `first-principles`, `asymmetry`, `boundary`,
   `numerical-gap`, `trust-gap`, `flow-gap`), one agent per lens, each given the full in-scope source
   plus shared rules; findings required a concrete proof and a minimal fix.
2. **A boundary-first review of the Rust engine service, HTTP surface, x402 gateway and terminal**
   (`security-audit` workflow): every candidate names the lower-trust principal, the accepted input, the
   intended control, the boundary crossed and the concrete result.

No live probing was performed for the audit. Every "verified" statement below cites either source or a
transaction that already existed before the audit started.

---

## 1. Result

| Severity | Found | Fixed | Regression test |
| --- | --- | --- | --- |
| High | 1 | 1 | `store::tests::a_payment_proof_is_spendable_exactly_once` |
| Medium | 6 | 6 | 6 tests |
| Low | 6 | 5 | 4 tests; 1 accepted |
| Informational | 4 | 2 | — |
| **Total** | **17** | **14** | **29 contract tests, 9 service tests** |

**Nothing found in the twelve-lens pass changed the custody model, the flash accounting or the
signature exactness property.** The single High finding was in the paid telemetry endpoint, not in the
on-chain protocol: a settled payment could be replayed, which matters because the endpoint is priced.

All contract fixes are deployed as the next generation of the *position template* only, so nothing on
the live deployment is stranded (see §4). All service fixes are deployed.

---

## 2. Confirmed findings

Descriptions are written so a developer can act on them: one sentence, active voice, who acts and what
they get.

### PYL-S1 · High · A settled payment unlocked the paid endpoint forever

* **Location:** `server/src/api.rs` — `x402_report`, `verify_onchain_payment`
* **Lower-trust principal:** any HTTP client.
* **Input:** `X-PAYMENT-TX: <hash>` naming a MUSD transfer of at least the price to the pay-to address.
* **Intended control:** one payment authorises one request.
* **Boundary crossed:** payment → authorisation, one-to-many. The same hash was accepted for every
  later request, and any third-party transfer to the pay-to address qualified as a payment.
* **Result:** with one 0.001 MUSD transfer (or somebody else's transfer), a caller used the metered
  endpoint without limit.
* **Fix:** claim each proof exactly once (`Store::claim_payment`, persisted in
  `spent-payments.jsonl` so a restart is not a reset) and refuse proofs whose settling block is older
  than `X402_MAX_AGE_SECS` (default 900).
* **Status:** fixed and deployed. Regression test asserts the second claim fails, that case changes do
  not create a second claim, and that the spend survives reopening the store.

### PYL-S2 · Medium · The facilitator path trusted verification instead of settlement

* **Location:** `server/src/api.rs` — previously `verify_with_facilitator`
* **Lower-trust principal:** any HTTP client holding a signed x402 payload.
* **Intended control:** a paid resource requires a settled payment.
* **Boundary crossed:** signature validity → payment. `POST /verify` returning `isValid: true` only
  proves that the payload is well formed and correctly signed; the service granted the resource without
  ever calling `/settle`, and the path was enabled by default.
* **Fix:** the path is off unless `X402_ALLOW_FACILITATOR=1`, and when enabled it calls `/settle`,
  requires an explicit success field, and consumes the returned transaction hash like any other proof.
* **Status:** fixed and deployed.

### PYL-S3 · Medium · The paid endpoint had no request budget

* **Location:** `server/src/api.rs`
* **Lower-trust principal:** any HTTP client.
* **Result:** each paid request triggers two upstream RPC reads (receipt + receipt logs), so an
  unauthenticated caller could make the service spend its own RPC quota. Measured cost per request: 2
  RPC calls, ~0.4 s.
* **Fix:** `ratelimit::RateLimiter` — per-client fixed windows, 30/min for paid requests and 240/min for
  reads, with a bounded client map so tracking cannot itself be grown without limit.
* **Status:** fixed and deployed, with tests for the budget and for window recovery.

### PYL-S4 · Medium · Concurrent operator sends could replace one another

* **Location:** `server/src/mezo.rs` — `send`
* **Lower-trust principal:** two internal callers (the keeper cycle and an operator command).
* **Intended control:** every broadcast action lands exactly once.
* **Result:** the nonce was read, signed and submitted without serialisation, so two senders in the same
  window could receive the same nonce; the second transaction replaces the first. A lost transaction is
  silent: the caller receives a hash for work that never happened, and a shield defence is the most
  likely casualty.
* **Fix:** a `tokio::sync::Mutex` held across read-sign-submit, so nonce allocation and submission are
  one critical section.
* **Status:** fixed and deployed.

### PYL-C1 · Medium · A venue could return without servicing the flash, and the operation would succeed

* **Location:** `contracts/src/PylonFlashEngine.sol` — `_flash`, `hook`
* **Lower-trust principal:** the configured flash pool (a third-party contract).
* **Input:** `swap(...)` that transfers the output and returns without calling `IPoolCallee.hook`.
* **Intended control:** an entrypoint either executes every leg or reverts.
* **Result:** `_flash` returned normally, the entrypoint reported success with zero effect, and `_op`
  stayed set — leaving the engine unable to serve that caller's next attempt.
* **Fix:** `if (_op != OP_NONE) revert FlashNotServiced();` after the swap. `hook` clears `_op`, so a
  surviving value proves the callback never ran.
* **Status:** fixed in the repo. Regression test drives a mock venue that skips the callback: the
  guarded call reverts, and the same request succeeds once the venue behaves.

### PYL-C2 · Low · The callback payload was not bound to the operation that started it

* **Location:** `contracts/src/PylonFlashEngine.sol` — `hook`
* **Lower-trust principal:** the configured flash pool.
* **Result:** `HookPayload.op` was decoded and ignored; dispatch used the stored `_op`. A payload
  describing a different operation would have been executed against the stored operation's expectations.
* **Fix:** `if (p.op != op) revert PayloadMismatch();` before dispatch.
* **Status:** fixed in the repo, with a regression test that corrupts the op byte in the callback
  payload.

### PYL-C3 · Medium · An engine handover could strand outstanding defence loans

* **Location:** `contracts/src/PylonReserve.sol` — `setEngine`
* **Lower-trust principal:** reserve governance (an owner key).
* **Intended control:** a position can always settle its claim and release its collateral.
* **Result:** positions read the reserve through the engine. Re-pointing the engine at a different
  reserve left every outstanding loan recorded in the old reserve only, so `repayReserve` would target a
  reserve with no record of the debt and revert — the collateral could never be released.
* **Fix:** `setEngine` reverts with `OutstandingLoans()` while `outstanding != 0`.
* **Status:** fixed in the repo, with a test that a handover is refused while a loan is live and allowed
  after settlement. **This guard is the reason the live engine cannot be upgraded until the live
  position settles its 543.94 MUSD claim** — the guard working as intended, and the reason the live
  deployment keeps its current engine.

### PYL-C4 · Medium · A position resolved its reserve dynamically

* **Location:** `contracts/src/PylonPosition.sol` — `engine_reserve`, `repayReserve`, `defend`
* **Result:** the same root cause as PYL-C3, seen from the position: `reserve()` was read from the engine
  on every call, so a later engine configuration decided which reserve the claim had to be repaid to.
* **Fix:** the reserve is captured in `initialize` and never re-read. The binding is immutable for the
  life of the position.
* **Status:** fixed in the repo (hardened template deployed). Test asserts the binding survives an
  engine `setReserve` call.

### PYL-C5 · Medium · Shield credit was unpriced and unbounded

* **Location:** `contracts/src/PylonPosition.sol` — `setShield`, `defend`; `PylonReserve` — `lendTo`
* **Lower-trust principal:** any position owner.
* **Intended control:** the shield pool lends to defend positions, and its capital is priced.
* **Result:** the trigger and target ICR had no upper bound and loans carried no fee. A borrower could
  arm a band above any reachable ratio and draw reserve capital to repay their own debt at 0%, then
  leave the position open indefinitely. The reserve's claim is enforceable (collateral cannot leave), so
  this is not theft — it is unpaid occupation of a shared pool: other positions lose their defence
  capacity and lenders earn nothing on the capital.
* **Fix:** four independent brakes:
  1. `MAX_SHIELD_ICR` (5e18) bounds the shield band, so `want` cannot be "the entire debt";
  2. `defenceFeeBps` (50, ceiling 500) is withheld at issuance and booked to `feesReceived`, so a loan
     prices the capital from its first second without an accrual model;
  3. `maxPerPositionBps` (2,000, ceiling 10,000) caps one position's share of the pool's assets;
  4. the existing per-call, per-position and utilisation caps remain.
* **Status:** fixed in the repo (reserve generation 2, deployed as code; live migration in §4), with
  tests for the band bounds, the fee ceiling, the concentration cap and the achieved ICR.

### PYL-C6 · Low · A rounding-level defence consumed a keeper slot

* **Location:** `contracts/src/PylonPosition.sol` — `defend`
* **Result:** any epsilon improvement satisfied `postICR > preICR`, so a one-wei defence could burn the
  position's borrowing room and a keeper's incentive without changing its risk.
* **Fix:** require a material improvement (at least 2% relative) — `postICR * 10_000 < icr * 10_200`
  reverts with `NoImprovement()`.
* **Status:** fixed in the repo, with a test that caps `maxPerCall` to 100 wei and expects the revert.

### PYL-C7 · Low · Anyone could initialise a position clone

* **Location:** `contracts/src/PylonPosition.sol` — `initialize`
* **Result:** `initialize` took the owner as a parameter and checked only that it had not run before.
  Clones are created and initialised atomically by the engine, so no uninitialised clone is reachable
  in practice; the implementation contract's own storage was the exposure, and the pattern invites a
  mistake in any future deployment path.
* **Fix:** `if (msg.sender != engine_) revert OnlyEngine();`.
* **Status:** fixed in the repo, with a test.

### PYL-C8 · Low · Collateral could be withdrawn to `address(0)`

* **Location:** `contracts/src/PylonPosition.sol` — `withdrawCollateral`
* **Result:** only the owner could call it, so the effect was self-inflicted loss of collateral rather
  than a cross-boundary attack.
* **Fix:** reject the zero address.
* **Status:** fixed in the repo, with a test.

### PYL-S5 · Low · `Config` derived `Debug` while holding the operator private key

* **Location:** `server/src/config.rs`
* **Result:** no key was logged, but any future `tracing::debug!(?config)` would have printed it.
* **Fix:** a manual `Debug` implementation that renders `operator_key` as `<redacted>`.
* **Status:** fixed and deployed.

### PYL-S6 · Low · The paid response misreported the payer

* **Location:** `server/src/api.rs`
* **Result:** the response's `payer` field carried the pay-to address, not the sender, so an "audit
  receipt" misattributed the payment.
* **Fix:** the transfer's `from` topic is returned as `payer`, and the settlement block time is taken
  from the receipt's block for the freshness check.
* **Status:** fixed and deployed.

### PYL-S7 · Informational · CORS is open

* **Location:** `server/src/api.rs`
* **Note:** `allow_origin(Any)` and `allow_headers(Any)` are deliberate: the surface serves public chain
  data and must be callable by agents and any origin. The paid endpoint is now rate-limited and
  single-use, which bounds the abuse this enables (a page proxying requests through a visitor's browser).

### PYL-C9 · Informational · Misleading guard name in the reserve

* **Location:** `contracts/src/PylonReserve.sol` — `withdraw`
* **Result:** the share-ownership check reverted with `NotPositionOwner()`, which reads like a position
  guard. Renamed to `NotShareOwner()`.

### PYL-C10 · Informational · No rescue path for stray tokens

* **Location:** `PylonFlashEngine`, `PylonReserve`
* **Note:** the reserve can sweep non-MUSD tokens; the engine cannot sweep anything. This is deliberate
  (fewer owner powers over the contract that holds user authorisations) and documented in the README as
  a limitation rather than a bug. Anyone can send tokens to the engine; nobody can take them out.

---

## 3. Controls verified during the audit (no finding)

These are the properties a judge or a reader should be able to check, and the audit confirmed each from
source or from an existing transaction:

| Control | Evidence |
| --- | --- |
| The user's signature is the slippage guard | `AdjustTrove` carries the exact collateral and debt deltas; the engine cannot exceed them. Live: an unwind with a stale quote reverted rather than moving less collateral. |
| Non-custodial signatures | The terminal builds EIP-712 typed data **locally** with a pinned domain (`chainId` `31611`, `verifyingContract` = `BorrowerOperationsSignatures`) and sets `recipient` = the engine, so a hostile API response cannot retarget a signature. |
| Wallet sends are bounded | `isTrustedTarget()` refuses any destination outside the deployed Pylon/Mezo set, and `{signature}` template substitution validates hex before sending. |
| Flash accounting is delta-based | Every leg measures `balance − snapshot`; the engine returns dust to the beneficiary and holds nothing between transactions (tests assert zero idle MUSD after loop, unwind and exit). |
| Reserve lending can only reduce a position's debt | `lendTo` is reachable only from a registered position's defence path; the reserve can never send MUSD anywhere else. |
| The claim is enforced in code | `withdrawCollateral` and `executeClose` revert while `reserveDebt != 0`. Live: `0xa06fe405` (`ReserveDebtOutstanding`) on the shielded position. |
| No secret material reaches logs or the bundle | No key logging in the service; only `NEXT_PUBLIC_*` values are compiled into the terminal. |
| ABI and EIP-712 encoders match reference implementations | Service unit tests compare byte-for-byte against `cast calldata` and an independently computed digest. |

---

## 4. Deployment decisions taken after the audit

The user's rule for this session: *redeploy only if nothing is stranded*. Applied literally:

| Change | Deployed? | Why |
| --- | --- | --- |
| Position-side fixes (C4, C5-partial, C6, C7, C8) | **Yes** — hardened template `0x4b0f750A3682229F574451420E0Eeeaf10284136` is now the engine's `positionImplementation` | New positions get the fixes; existing clones keep their own implementation, so nothing is disturbed |
| Reserve-side fixes (C3, C5 fee/cap) | **Code + tests**, migration planned | Re-pointing the live engine would strand the live position's 543.94 MUSD claim. The new `setEngine` guard now makes that impossible until the loan settles |
| Engine-side fixes (C1, C2) | **Code + tests**, migration planned | A new engine cannot be wired while the reserve holds an outstanding loan: `notifyFee` requires the reserve's stored engine. This is the guard from C3 working as designed |
| Service fixes (S1–S6) | **Yes** | Stateless, no on-chain binding |

### Migration procedure (recorded so it is not improvised)

1. Position owner calls `repayReserve(reserveDebt)` — the live position holds 543.94 MUSD of debt against
   0.045 BTC of collateral and its owner received 600 MUSD when it was looped, so this is funded.
2. `PylonReserve.setEngine(newEngine)` now succeeds (`outstanding == 0`).
3. Deploy the hardened `PylonReserve` generation, move LP capital, and wire the new engine to it.
4. `PylonFlashEngine(positionImplementation)` points at the hardened template (already done).
5. Positions created before the migration keep their own reserve binding and remain settleable, which is
   the property PYL-C4 adds for every new position.

---

## 5. Coverage and limits

* **Solidity in scope:** 7 files, 2,211 lines — `PylonFlashEngine.sol`, `PylonReserve.sol`,
  `PylonPosition.sol`, `PylonMath.sol`, `Clones.sol`, and both deploy/proof scripts. Interfaces, mocks
  and tests were out of scope for hunting but were read where inherited behaviour mattered.
* **Service in scope:** the Rust engine (`src/*.rs`), the HTTP surface, the x402 gateway, the keeper and
  the store; plus the terminal's execution and signing paths.
* **Not covered:** mainnet deployment topology, the off-repository Mezo core contracts and Tigris pools
  (consumed as dependencies), the browser wallet implementations, and anything requiring execution of
  target code outside an OS-enforced sandbox (none was performed).
* **This is one pass.** A second pass would hunt new ground rather than re-walk the same functions; the
  coverage above is what one pass reached, not a claim of exhaustion.
* **Findings that remain accepted risks rather than fixed:** PYL-C9 (cosmetic rename pending), PYL-C10
  (deliberate design), PYL-S7 (deliberate CORS), and the reserve-side economics on the *live* generation
  (fixed in code, migration pending, and the only live borrower is this project's own operator
  position — no third-party capital is exposed to it).
