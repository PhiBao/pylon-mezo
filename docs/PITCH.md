# Pylon — pitch deck content

> 10 slides. Each slide is deliberately one idea: a judge should be able to read the deck and the
> terminal side by side and find the same claims.

---

## 1 — Title

**Pylon**
*Non-custodial flash leverage, self-deleveraging and a redemption shield for Bitcoin on Mezo.*

Mezo Buildathon · Track 1 (DeFi: Borrowing, Lending, Looping, Yield)
Mezo Testnet · chain ID 31611

---

## 2 — The trap

Mezo lets you borrow `MUSD` against BTC at a fixed 1%.

Three properties of that loan decide everything:

1. **Looping is manual** — borrow → swap → re-collateralise → repeat, 6–15 transactions, each one moving
   your collateral ratio.
2. **Repayment needs MUSD you may not have** — your collateral is only withdrawable *after* the
   repayment. A borrower with equity and a falling price cannot reach it.
3. **Liquidation is not the only risk** — redemptions walk up from the *lowest* collateral ratio above
   110%. A 135% borrower loses BTC without ever seeing a liquidation warning.

*Visual: the live queue — 245 troves, ranks 1–9 between 111% and 128%.*

---

## 3 — The insight

Mezo already contains every part needed to fix all three:

* `BorrowerOperationsSignatures` — a contract can act on **your existing trove** from **one EIP-712
  signature**.
* Tigris pools — Solidly-style `IPoolCallee.hook` optimistic flash liquidity, in the DEX you already
  trade on.
* The BTC precompile — an 18-decimal ERC-20/native ledger, so BTC bought in a swap pays `msg.value` in
  the very next call.

Nothing in Mezo had composed them. That composition is the product.

---

## 4 — What Pylon does

| Mode | One transaction |
| --- | --- |
| **Flash Loop** | Borrow against your trove, swap the MUSD for BTC, post it as collateral, repay the flash from the trove borrow |
| **Flash Unwind** | Repay debt out of your trove's *own* collateral — with **0 MUSD in your wallet** |
| **Flash Exit** | Close the trove entirely, funded by its own collateral |
| **Redemption Shield** | A MUSD reserve that permissionlessly pushes a shielded position back out of the queue |

No custody. No vault migration. No up-front capital. Your trove stays your trove.

*Visual: the Atomic Execution X-Ray — every leg, both fees, venue rate vs oracle, post-trade ICR, before
signing.*

---

## 5 — Proof, not promises (live on Mezo Testnet)

| What | Transaction |
| --- | --- |
| Flash loop: +0.005 BTC collateral, +394.77 MUSD debt, 0.79 MUSD fee to the reserve | `0x7933c853…` |
| Flash unwind: 300 MUSD repaid from collateral, wallet MUSD = 0 | `0xe7e02053…` |
| Flash exit: trove closed, 0.0218 BTC returned | `0xfd3e382f…` |
| Shield defence: ICR 142% → 180%, 543.94 MUSD lent by the reserve, called by a third party | `0x0e3b6710…` |

Reserve state at submission: **1,005.18 MUSD assets · share price 1.00518 · 5.18 MUSD of fees earned ·
543.94 MUSD lent · claim enforced in code.**

---

## 6 — Why this is hard (and therefore why it is worth watching)

Four constraints that only appear against live Mezo infrastructure — each cost us a redeploy:

1. A Solidly pool **cannot be swapped inside its own flash callback** → two venues, by design.
2. `BorrowerOperationsSignatures` burns repayment MUSD **from its own caller** → keep the flash proceeds
   in the engine.
3. Gas: **63/64 forwarding** across a six-hop nest + an estimator that fails on that path → an explicit
   gas floor, and per-leg `StageFailed` reporting instead of a bare panic.
4. `HintHelpers.getApproxHint(40)` costs **~4.75M gas** on a 245-trove book → the solver supplies hints
   and the contract validates them.

We found these because we executed them, not because we read them.

---

## 7 — The shield economy

* Borrowers arm a band: *defend below X% ICR, toward Y%*.
* Anyone can defend — the owner, a keeper, a competing bot.
* The reserve lends MUSD that can **only** repay that position's debt.
* The claim is enforced by the position: **collateral cannot leave while a shield loan is outstanding**
  (verified live).
* Lenders are paid by flash origination fees — 0.20% of every flashed notional, on-chain.

This is the piece Mezo is missing: a priced, enforceable market for redemption defence.

---

## 8 — Track record in this build

* 19 Foundry tests over a faithful Mezo/Tigris harness (flash accounting, guards, reserve caps, math).
* 6 Rust tests with vectors cross-checked byte-for-byte against `cast` (ABI + EIP-712).
* A Rust engine that indexes all 245 troves, solves routes and hints, runs the keeper, and settles
  x402 payments in MUSD.
* A terminal that works with no backend at all (direct RPC), with the same design system.

---

## 9 — Beyond the hackathon

1. Defence ballots for native troves (defend while the owner is offline, still non-custodial).
2. Multi-leg yield routing (loop proceeds into MUSD/BTC and MUSD/MEZO with ICR-aware shields).
3. Cross-chain reach — MUSD is an NTT token; manage one position from Base or Ethereum.
4. Keeper market with bounties (the defence path is already permissionless).
5. Mainnet with timelocked reserve governance, a dedicated operator key, and an audit.

---

## 10 — Closing

**A Bitcoin loan should be a position you can steer, not a contract you obey.**

Pylon · Mezo Testnet 31611 · engine `0x94b6384F…45F6` · reserve `0xcc9dD719…b881`
MIT · docs, diagrams and the full engineering log in the repository.
