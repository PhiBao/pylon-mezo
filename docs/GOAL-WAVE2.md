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

- [ ] The empty architect teaches the three-step flow instead of saying "no trove selected".
- [ ] One-click ways in: "Use my wallet's trove" and "Pick the cheapest to redeem".
- [ ] Each mode (Loop / Unwind / Exit / Shield) explains itself in one visible line.
- [ ] Every async state says what is happening and why (reading, pricing, signing, relaying).
- [ ] The wrong-network state is visible and fixable from the header (done: auto-switch + button).
- [ ] Mobile: header, architect and tables usable at 390px (no horizontal overflow).

### Technical

- [ ] CI on every push: Foundry tests, Rust tests, web typecheck + build.
- [ ] Relayed executions are recorded in the proof ledger (currently only CLI/keeper rows are).
- [ ] Contracts verified on the Mezo explorers; a script reproduces the verification.
- [ ] Fuzz/invariant tests for reserve shares and flash fee rounding.
- [ ] Deployment record and README state exactly which generation runs which fixes.

### Not in this goal

- A new mainnet trove (needs ~0.037 BTC locked; documented as the remaining integration gap).
- A new contract generation migration (requires settling the live position first; scoped separately).

## Evidence to collect

- CI run link.
- A relayed execution that appears in `/api/v1/proofs`.
- Explorer links for the verified contracts.
- Screenshots of the first-run panel and the mode help.
