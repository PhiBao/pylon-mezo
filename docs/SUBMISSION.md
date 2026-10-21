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

* **Flash Loop** — flash-borrow MUSD from a stable MUSD pool, swap it to BTC on the MUSD/BTC pool, post
  it as collateral, and repay the flash out of the trove's own new borrow, all in one transaction
  (live on testnet: `0x7933c853…`).
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
origination fees (0.20%, routed to the reserve as lender yield), the reserve's loans, and the machine
payments that buy telemetry. MEZO is the reward leg: the terminal's yield path pairs borrowed MUSD with
MUSD/BTC and MUSD/MEZO liquidity, and the engine exposes the same operations over HTTP with an x402
MUSD-paid telemetry endpoint for agents.

### Target group

Mezo borrowers who already hold BTC-backed MUSD debt — DeFi-native users managing positions, and holders
who borrowed and spent the proceeds. They are desktop-first, comfortable with wallets and signing, and
they read numbers: the terminal is built for people who want their collateral ratio, queue rank and fee
stack visible before they sign. Secondary: agents and operators who need the same operations
programmatically.

### Tech stack

Solidity 0.8.24 + Foundry (engine, reserve, EIP-1167 position template, **43 tests**), Rust (Axum + Tokio;
`SortedTroves` indexer, flash-route solver, keeper, x402 gateway, JSON-RPC + hand-rolled ABI/EIP-712
encoders, **9 tests**), Next.js 15 + TypeScript + wagmi/viem (static export, RPC fallback, no backend
required), Mezo **Testnet (31611) and Mainnet (31612)** for everything on-chain.

### Track

**Track 1 — DeFi (Borrowing, Lending, Looping, Yield)** (primary). The terminal, the shield reserve and
the x402 endpoint also serve Track 2 — Access and Distribution.

### Chain deployed on

**Both chains.**

* **Mezo Testnet (Matsnet), chain 31611** — the full product, end to end: engine, reserve, position
  template, a live shielded position, and a hosted terminal that runs on live testnet reads with no
  wallet and no backend.
* **Mezo Mainnet, chain 31612** — the same audited generation, deployed and **funded with real MUSD**:
  the reserve holds capital, a second depositor's shares priced exactly right, a withdrawal executed, and
  then the whole pool **migrated into a freshly deployed generation with nothing stranded** — the
  upgrade path proven with real value rather than asserted. A real 0.001 MUSD machine payment settled a
  paid report against the mainnet whale trove. Mainnet readiness was verified against Mezo's own
  deployment records and the chain itself (MUSD, the BTC ledger's `balanceOf == native balance` identity,
  the trove stack, `BorrowerOperationsSignatures`, and both venue pools with their depths and fees).

### Project status

**Entirely new** project, created during this hackathon. No pre-existing product site.

### Project readiness

**Testnet, live and operating** — `PylonFlashEngine` `0x901198cD4EE9086997D839401f361518cAE46ed6`,
`PylonReserve` `0x53a0206A307E084AdA2eB24346463cf4E14C5131`, `PylonPosition` template
`0x0e64B682Add80A61d24E61ed360b3F3679C6860a`, live shielded position
`0x02f472dd2c08a4dab586ab11bafb294c27f5182e`, three live atomic-path transactions, a live shield
defence, and a hosted terminal on live testnet reads.

**Mainnet, live with real value** — `PylonFlashEngine` `0x8DEa475605ac7a99ad28F0DD3537A93b2aCf655D`,
`PylonReserve` `0x81175AaAC5Fa0873e64480502566Fe993bB88e62`, `PylonPosition` template
`0x645174D655814839a85Bd80D2F54b35A7160465E` (previous generation engine `0x770BDCbc…` / reserve
`0x62b33b59…`, drained by the migration and kept for lineage).

**Security** — a source-only audit ran after the build: twelve adversarial speciality lenses over the
Solidity (math, access control, economics, execution trace, invariants, periphery, first principles,
asymmetry, boundaries, numerical gaps, trust gaps, flow gaps) plus a boundary-first review of the Rust
service, HTTP surface, x402 gateway, keeper and terminal. **35 findings (5 high, 12 medium, 13 low, 5
informational); 32 are fixed, each with a regression test** (43 contract tests, up from 19). Two of the
high findings were latent defects that had made the position-mode flash legs *impossible* to execute
(balance deltas that underflowed), and one was a mispriced deposit that would have taken up to half a
later depositor's money — the live mainnet deposit demonstrates the fix. Report:
[`docs/AUDIT.md`](docs/AUDIT.md).

### Links

* Live deployment: **https://phibao.github.io/pylon-mezo/** — the full terminal, running on live Mezo
  Testnet reads with no wallet and no backend required
* Repository: **https://github.com/PhiBao/pylon-mezo** (public; full history, tests, deployment records
  for both chains, the audit report and the engineering log)
* Mainnet contracts: engine `0x8DEa475605ac7a99ad28F0DD3537A93b2aCf655D`, reserve
  `0x81175AaAC5Fa0873e64480502566Fe993bB88e62`, template
  `0x645174D655814839a85Bd80D2F54b35A7160465E` on
  [explorer.mezo.org](https://explorer.mezo.org)
* Engine service (radar solver, keeper, x402): `cd server && cargo run --release -- serve` — the API the
  hosted terminal uses when it is reachable; `server/.env.mainnet.example` is the mainnet variant
* Product deck: `docs/PITCH.md` · 2-minute pitch video: `docs/DEMO_SCRIPT.md` (script and transaction
  index) · diagram set: `docs/diagrams/01-atomic-paths.svg`, `02-redemption-queue.svg`,
  `03-system-map.svg`
* Mainnet readiness and the cost ladder: `docs/MAINNET-READINESS.md` · deploy and escape procedures:
  `docs/MAINNET-RUNBOOK.md`

### Future milestones (if continuing after the hackathon)

1. **Native-trove defence ballots** (3 weeks) — pre-authorised, amount-capped, revocable defence so a
   native trove can be defended while its owner is offline without ever moving the position.
2. **Multi-leg yield routing** (4 weeks) — deploy loop proceeds into MUSD/BTC and MUSD/MEZO liquidity
   with ICR-aware shield checks, plus a real APY report from on-chain fee history. Mainnet already offers
   33 MUSD pairs — including tokenised-equity pairs — and the engine takes its venues as constructor
   arguments, so each is a deployment choice rather than a code change.
3. **External audit and a two-of-two owner** (6 weeks) — an independent review of the flash accounting,
   a Safe-style two-of-two owner module for the reserve and engine, a dedicated keeper key, and a
   mainnet trove (Mezo's 2,000 MUSD minimum debt makes that the one cost that a small budget cannot
   cover).

### Team

**PhiBao** (solo builder) — <https://github.com/PhiBao>

---

## Wave 2 resubmission notes (Nov 2–15)

Explicit changes to cite:

* The position flash loop's two code defects are **fixed and unit-tested** (a balance delta that
  underflowed on every collateral-adding call, and another that underflowed on every repayment). The
  on-chain execution is still outstanding: the testnet's effective gas ceiling is below what the
  on-chain hint solver needs against 245+ troves, and the RPC returns no revert data for contract calls,
  so the residual cause could not be isolated from the build environment. The native-trove paths — the
  same three operations — are proven live.
* Mainnet is no longer a plan: contracts deployed, capital deployed, a real x402 machine payment settled,
  and the pool migrated to a second generation with the capital intact.
* Reserve reporting: per-position loans, realised yield, and a realisable-vs-locked split for LPs.
* Cross-chain loop prototype on Base using MUSD NTT transfers (if time allows).
