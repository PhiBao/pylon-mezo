# Wave 2 goal

**Objective:** land everything we can before the Wave 2 deadline (Nov 15, submission window closes
Nov 20) — the five outside-user wallets running the real flow on the hardened v6 generation, the
evidence documented in `docs/USERS.md` and folded into the submission, and the two lowest-scoring
criteria (**UX 10%**, **Technical 20%**) closed out as far as they can go without mainnet capital.

## Definition of done

### Outside users (the judge's "outside users" point)

- [x] Five wallets generated, keys at `~/.pylon-demo/users.json` (0600, outside the repo).
- [x] All five funded from the Mezo faucet (0.05 BTC each).
- [x] Run `contracts/script/run-users.sh`: createPosition → openTrove (0.045 BTC / 2,000 MUSD) →
      setShield(170→185) → one flash loop (0.0005 BTC) per wallet on the v6 engine.
      All five wallets completed; receipts `status = 1`. (users 2/3/5 needed one hint-race retry.)
- [x] `docs/USERS.md` filled with position addresses and create/open/loop/shield tx links.
- [x] Five positions verified readable on-chain (engine isPosition, reserve registered, trove active).
- [ ] Evidence linked from the submission (Wave 2 form + SUBMISSION.md).

### Technical (20%)

- [x] CI on every push — Foundry tests, Rust tests, web typecheck + build — green (run 41436868671).
- [x] Relayed executions recorded in the proof ledger.
- [x] Fuzz tests for reserve shares and fee rounding; **52 Foundry tests**, 9 Rust.
- [x] Hardened v6 generation deployed: engine `0xa1780be8…`, reserve `0xAC8239Ca…`,
      template `0xe22fB303…`; reserve seeded with 1,000 MUSD; wiring verified.
- [x] Sourcify: **engine and reserve match** the round-2 source. Template recorded as unverified
      (deployed bytecode ~395 B off local build, identical ABI/selectors) — not claimed.
- [x] Legacy v5 position left on its own engine; its reserve loan settled and depositor shares
      withdrawn; v6 deployment is the live one.
- [ ] Commit + push docs/USERS.md and the Wave 2 updates; confirm Vercel + Fly serve v6 config.
- [ ] Deployment record, README, submission updated to v6 with the verification status stated
      exactly (partially done — final pass after the users run).

### User experience (10%)

- [x] Empty-architect start panel (three steps, "Use my wallet's trove", "Pick the cheapest").
- [x] Per-mode explanation line; wrong-network auto-switch; no 390px overflow; radar readout height.
- [ ] Final pass on async labels (quote/signing states).
- [ ] One more UX screenshot set for the deck if anything changes.

### Explicitly out of scope (and why)

- A mainnet trove — needs ~0.037 BTC locked in a new trove; documented as the remaining gap.
- Re-cutting the demo video — single 1:48 cut; template machine is gone.
- Re-verifying the position template on Sourcify — blocked on understanding the ~395 B delta; not
  claimed anywhere.

## Evidence

- CI: run **41436868671** — success.
- Tests: **52 Foundry**, 9 Rust.
- v6 wiring + seed: `engine.reserve`, `reserve.engine`, `engine.positionImplementation` all match;
  reserve assets 1,000 MUSD @ 1.0000 share price.
- Sourcify match IDs: engine `916db073-…`, reserve `a34429c8-…` (both `match: match`).
- Fly scale-to-zero with suspend: cold `/health` ~1.2 s.
- Vercel production: terminal serves the v6 fallback.

## Status log

- v6 deployed; migration of the v5 reserve loan + shares done (332.18 MUSD settled, 1,007.6 MUSD
  withdrawn with ~100 left for another shareholder).
- Faucet: 5/5 wallets funded (0.05 BTC each), all five ran the full flow on v6 (receipts status=1).
  Three needed a hint-race retry on openTrove. Evidence in `docs/USERS.md`.
