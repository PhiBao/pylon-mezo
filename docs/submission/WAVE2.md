# AKINDO — Wave 2 answers (plain text)

## Updates in this Wave

Wave 2 focused on the two criteria the judges scored lowest: user experience and technical implementation — and it ends with the hardened generation live on chain, Sourcify-verified, and five outside wallets running the real flow.

Security. A second review round — an external hunter report, the Wave 1 feedback and a fresh boundary pass — found 10 issues: 4 high, 3 medium, 2 low, 1 rejected. Seven are fixed with regression tests; two are accepted and documented. The high fixes: claiming collateral surplus could release BTC while a reserve loan was open; the relay ballot named the owner instead of the engine; the engine could re-point its reserve with live loans; reserve admin actions were immediate single-owner calls. The suite went from 43 to 52 Foundry tests.

On chain. The hardened v6 generation is deployed and the product points at it: engine 0xa1780be8…, reserve 0xAC8239Ca… (seeded with 1,000 MUSD), position template 0xe22fB303…. The v5 reserve loan was settled and the depositor capital moved to v6; nothing was stranded. All three contracts verify on Sourcify — the template needed the full 38-source compilation input foundry used for the deploy, not the dependency-closed module set explorers compile by default.

Five outside wallets funded from the Mezo faucet ran the full flow on v6 under their own keys — create a position, open a trove with 0.045 BTC / 2,000 MUSD, arm the shield, flash loop — with every transaction linked in docs/USERS.md. (Three needed one openTrove retry; no funds moved.)

Video. The Wave 2 walkthrough (1:44) records an outside user executing a real flash loop on camera: paste their position, size the move, read the x-ray, sign once, the engine relays, the receipt confirms. Both loops are explorer-linked. The recording exposed two relay bugs (owner authorisation missing; hints stale between quote and execution), both fixed.

User experience. The empty terminal teaches the flow in three steps — pick a trove, size the move, sign once — with one-click entry ("Use my wallet's trove", "Pick the cheapest to redeem"). Each mode explains itself in one line under the tabs. The network switch is a dropdown with both chains; the wallet is switched to the bundle's chain automatically, and added first if the wallet does not know it. The radar readout has a fixed height, so hovering no longer moves the chart, and the layout no longer overflows on a 390px phone.

Technical. GitHub Actions runs the Foundry tests, the Rust tests and the web typecheck plus dual-network build on every push. Relayed executions are written to the proof ledger instead of only CLI and keeper runs. The Fly engine scales to zero with suspend — measured resume is 1.1 to 1.2 seconds — so an idle deployment costs only volume storage. Fuzz tests cover the reserve round trip and the fee rounding.

Live: https://pylon-mezo.vercel.app | https://pylon-mezo.vercel.app/mainnet/ | https://github.com/PhiBao/pylon-mezo

---

## Milestone — Wave 2

The wave delivered a hardened, teachable version of Pylon without changing what it is: a non-custodial terminal where a Mezo borrower loops, unwinds, exits or defends their own trove in one transaction and one signature.

The security work is the core of it. The surplus path now refuses to release collateral while the reserve holds a claim; the relay signs the engine as the recipient the contract actually verifies; both loop paths pre-check Mezo's maxBorrowingCapacity and refuse in Recovery Mode with a clear reason; and the admin actions that can move value between the reserve and its depositors — engine handover, reserve handover, loan write-off, position implementation — are two-step with a two-day public delay. Fifty-two Foundry tests cover the fixes, including the regressions that reproduced the original bugs.

The deployment is done, not promised: v6 is live on testnet with the reserve seeded, the terminal reads it, engine and reserve are Sourcify-verified, and five faucet-funded outside wallets opened troves and ran loops under their own keys — the strongest evidence so far that the flow works for anyone, not just the operator. The remaining gap is the mainnet trove, which needs about 0.037 BTC locked to clear Mezo's minimum debt.

Links: https://pylon-mezo.vercel.app | https://pylon-mezo.vercel.app/mainnet/ | https://github.com/PhiBao/pylon-mezo
