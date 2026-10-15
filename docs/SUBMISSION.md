# AKINDO submission — paste-ready answers

Form: AKINDO → Buildathons → *Build with MUSD and MEZO: Bitcoin's Economic Layer* (Mezo Buildathon)
Wave: 1 (building period Oct 16 – 26, 2026)

---

### Project name

**Pylon**

### Project category (3–5 words)

Flash leverage, redemption shield

### TL;DR (one sentence)

Pylon gives an existing Mezo bitcoin trove atomic leverage, atomic self-deleveraging and a paid-for
defence against MUSD redemptions — non-custodially, on the user's own trove, with one signature.

### How it works

*(problem → function → how MUSD/MEZO are used and positioned)*

**Problem.** A Mezo loan is static. Levering it up takes a dozen manual transactions and pre-existing
MUSD; deleveraging it after the MUSD is spent is impossible because `BorrowerOperations.repayMUSD` burns
MUSD from the caller while the collateral is only withdrawable *after* the repayment; and the real tail
risk is not liquidation but **redemption** — MUSD redemptions walk up from the lowest collateral ratio
above 110%, so a 135% borrower can lose BTC with no warning.

**Function.** Pylon executes three atomic paths against a user's existing trove, funded by flash
liquidity from Mezo's own Tigris pools, authorised by a single EIP-712 signature created by Mezo's
`BorrowerOperationsSignatures`:

* **Flash Loop** — flash-borrow MUSD from the MUSD/mUSDC pool, swap it to BTC on the MUSD/BTC pool, post
  it as collateral, and repay the flash out of the trove's own new borrow, all in one transaction
  (live: `0x7933c853…`).
* **Flash Unwind** — repay trove debt out of the trove's *own* collateral with zero MUSD in the wallet
  (live: `0xe7e02053…`).
* **Flash Exit** — close the trove entirely, funded by its collateral, and return net BTC
  (live: `0xfd3e382f…`).

On top of that sits the **Redemption Shield**: a MUSD reserve pool (`PylonReserve`) that lends only to
repay the debt of registered positions that armed a defence band, only within per-call, per-position and
utilisation caps, and only in a direction that improves the position's ICR. The claim is enforceable
because a Pylon position cannot release collateral or close while a shield loan is outstanding
(live defence: `0x0e3b6710…`, ICR 142% → 180%, 543.94 MUSD lent, called by a third party).

**MUSD / MEZO positioning.** MUSD is the settlement asset for every leg — flash principal, swap input,
origination fees (0.20%, routed to the reserve as lender yield) and the reserve's loans. MEZO is the
reward leg: the terminal's yield path pairs borrowed MUSD with MUSD/BTC and MUSD/MEZO liquidity, and the
engine exposes the same operations over HTTP with an x402 MUSD-paid telemetry endpoint for agents.

### Target group

Mezo borrowers who already hold BTC-backed MUSD debt — DeFi-native users managing positions, and holders
who borrowed and spent the proceeds. They are desktop-first, comfortable with wallets and signing, and
they read numbers: the terminal is built for people who want their collateral ratio, queue rank and fee
stack visible before they sign. Secondary: agents and operators who need the same operations
programmatically.

### Tech stack

Solidity 0.8.24 + Foundry (engine, reserve, EIP-1167 position template, 19 tests), Rust (Axum + Tokio;
`SortedTroves` indexer, flash-route solver, keeper, x402 gateway, JSON-RPC + hand-rolled ABI/EIP-712
encoders, 6 tests), Next.js 15 + TypeScript + wagmi/viem (static export, RPC fallback, no backend
required), Mezo Testnet for everything on-chain.

### Track

**Track 1 — DeFi (Borrowing, Lending, Looping, Yield)** (primary). The terminal, the shield reserve and
the x402 endpoint also serve Track 2 — Access and Distribution.

### Chain deployed on

**Mezo Testnet (Matsnet)**, chain ID `31611`. Mainnet deployment is planned; `Deploy.s.sol` takes the
flash venue address from the environment because it is chain-specific.

### Project status

**Entirely new** project, created during this hackathon. No pre-existing product site.

### Project readiness

**Testnet deployment**, live and operating: `PylonFlashEngine`
`0x94b6384F9202F27c3ab1b3b0c6f1A8b7218F45F6`, `PylonReserve` `0xcc9dD7197237bbb645978D9A92872C7F82B6b881`,
`PylonPosition` template `0x504DcDD85FD82C2974F27b1f71B6cc116EbE18bE`, and a live shielded position
`0xe0773065977747d34e94397fc902178709ccdc23`.

### Links

* Live deployment: the terminal's static bundle (hosted link to be added at submission) — Mezo Testnet
  reads work without a wallet or backend
* Repository: `https://github.com/<owner>/pylon` (to be pushed; full history and this README included)
* Product deck: `docs/PITCH.md`
* 2-minute pitch video: `docs/DEMO_SCRIPT.md` (script and transaction index)
* Diagram set: `docs/diagrams/01-atomic-paths.svg`, `02-redemption-queue.svg`, `03-system-map.svg`

### Future milestones (if continuing after the hackathon)

1. **Defence ballots for native troves** (3 weeks) — pre-authorised, amount-capped, revocable defence
   so a native trove can be defended while its owner is offline without ever moving the position.
2. **Multi-leg yield routing** (4 weeks) — deploy loop proceeds into MUSD/BTC and MUSD/MEZO liquidity
   with ICR-aware shield checks, plus a real APY report from on-chain fee history.
3. **Keeper market + mainnet** (6 weeks) — bounty-funded permissionless defence, timelocked reserve
   governance, a dedicated operator key, and an external audit of the flash accounting.

### Team

Solo builder. *(Fill in name, role, X/LinkedIn before submitting.)*

---

## Wave 2 resubmission notes (Nov 2–15)

Explicit changes to cite:

* Position flash loop executed on-chain for a v4-bound position (solver hints instead of ~4.75M gas of
  on-chain hint resolution).
* Native-trove defence ballots shipped, with the shield's claim still enforced by the position.
* Reserve reporting: per-position loans, realised yield, and a realisable-vs-locked split for LPs.
* Cross-chain loop prototype on Base using MUSD NTT transfers (if time allows).
