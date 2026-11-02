# Wave 2 goal

**Objective:** raise the two lowest scoring criteria — **User Experience (10%)** and **Technical
Implementation (20%)** — before the Wave 2 deadline (Nov 15), without a mainnet trove.

## Why these two

The Wave 1 feedback is explicit: deep Mezo composition, but "run the flows on mainnet and with
outside users" and "no clear security flaws". The first is a funding constraint; the second and the
usability gap are not. Technical also covers what a judge can inspect: tests, CI, verification,
deployed code.

## Definition of done

### User experience

- [x] The empty architect teaches the three-step flow instead of saying "no trove selected".
- [x] One-click ways in: "Use my wallet's trove" and "Pick the cheapest to redeem".
- [x] Each mode (Loop / Unwind / Exit / Shield) explains itself in one visible line.
- [x] The wrong-network state is visible and fixable from the header (auto-switch + button).
- [x] Mobile: no horizontal overflow at 390px (scrollWidth 390 = innerWidth).
- [ ] Every async state says what is happening and why — mostly there; worth a final pass on the
      quote/signing states.

### Technical

- [x] CI on every push: Foundry tests, Rust tests, web typecheck + build — green in 1m56s
      (run 41436868671).
- [x] Relayed executions are recorded in the proof ledger (kind, note, amounts, block, gas).
- [x] Fuzz tests for reserve shares and fee rounding; 51 Foundry tests.
- [~] Contracts verified on the Mezo explorers — **blocked**: the deployed generation predates the
      round-2 fixes, so Sourcify recompiles to different bytecode. Verification belongs to the new
      generation deploy.
- [ ] Deployment record and README state exactly which generation runs which fixes — partially: the
      README says the deployed generation predates the fixes; it needs the new addresses once
      deployed.

### Not in this goal

- A new mainnet trove (needs ~0.037 BTC locked; documented as the remaining integration gap).
- A new contract generation migration (requires settling the live position first; scoped separately).

## Evidence

- CI: run **41436868671** — success (contracts, server, web).
- Live terminal: `START HERE`, the three steps, `PICK THE CHEAPEST` and the per-mode line render at
  1600px; no horizontal overflow at 390px.
- Cold start: Fly suspend → `/health` 1.24 s, `/api/v1/radar` 1.09 s from suspended.
- Tests: 51 Foundry, 9 Rust.

## Open items

1. ~~Deploy the hardened generation (testnet)~~ — **done**: v6 engine `0xa1780be8…`, reserve
   `0xAC8239Ca…`, template `0xe22fB303…`. The old reserve loan was settled, its depositor capital
   withdrawn, and 1,000 MUSD seeded into the v6 reserve. The v5 position remains on its own engine
   as legacy (positions are bound to the engine that created them).    Verification: **engine and reserve match on Sourcify**; the position template's deployed
   bytecode differs from the local build by ~395 bytes (all 31 selectors present), so it is recorded
   as unverified rather than claimed. Next: run the five outside wallets.
2. Outside testnet users (5–10 wallets) with tx links — the judge's "outside users" point, achievable
   without mainnet capital.
3. A final pass on async labels (quote/signing) and one more UX screenshot set for the deck.
