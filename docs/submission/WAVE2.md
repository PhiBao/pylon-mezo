# AKINDO — Wave 2 answers (plain text)

## Updates in this Wave

Wave 2 focused on the two criteria the judges scored lowest: user experience and technical implementation.

Security. A second review round — an external hunter report, the Wave 1 feedback and a fresh boundary pass — found 10 issues: 4 high, 3 medium, 2 low, 1 rejected with source evidence. Seven are fixed with regression tests; two are accepted and documented. The high fixes: claiming collateral surplus could release BTC while a reserve loan was open; the relay ballot named the owner instead of the engine, which made the native route revert; the engine could re-point its reserve with live loans and redirect repayments; reserve admin actions (engine handover, loan write-off) were immediate single-owner calls. The suite went from 43 to 51 Foundry tests.

User experience. The empty terminal now teaches the flow in three steps — pick a trove, size the move, sign once — with one-click entry ("Use my wallet's trove", "Pick the cheapest to redeem"). Each mode explains itself in one line under the tabs. The network switch is a dropdown with both chains; the wallet is switched to the bundle's chain automatically, and the chain is added first if the wallet does not know it. The radar readout has a fixed height, so hovering no longer moves the chart, and the layout no longer overflows on a 390px phone.

Technical. GitHub Actions now runs the Foundry tests, the Rust tests and the web typecheck plus dual-network build on every push; the first run is green. Relayed executions are written to the proof ledger instead of only CLI and keeper runs. The Fly engine scales to zero with suspend — measured resume is 1.1 to 1.2 seconds — so an idle deployment costs only volume storage. Fuzz tests cover the reserve round trip and the fee rounding.

Contract verification is the one item still blocked: the deployed generation predates these fixes, so the explorer recompiles to different bytecode. It moves with the new generation deployment, not with another submission.

Live: https://pylon-mezo.vercel.app | https://pylon-mezo.vercel.app/mainnet/ | https://github.com/PhiBao/pylon-mezo

---

## Milestone — Wave 2

The wave delivered a hardened, teachable version of Pylon without changing what it is: a non-custodial terminal where a Mezo borrower loops, unwinds, exits or defends their own trove in one transaction and one signature.

The security work is the core of it. The surplus path now refuses to release collateral while the reserve holds a claim; the relay signs the engine as the recipient the contract actually verifies; both loop paths pre-check Mezo's maxBorrowingCapacity and refuse in Recovery Mode with a clear reason; and the admin actions that can move value between the reserve and its depositors — engine handover, reserve handover, loan write-off, position implementation — are two-step with a two-day public delay. Fifty-one Foundry tests cover the fixes, including the regressions that reproduced the original bugs.

The experience work makes the product legible on first contact: a start panel with three steps and two one-click entry points, a visible explanation for each mode, a wallet that follows the selected network, a chart that does not move under the cursor, and a phone layout with no horizontal overflow.

The technical work makes it inspectable: CI on every push, relayed executions in the ledger, fuzz tests, and a Fly deployment that scales to zero and resumes in about a second.

The next step is the one that turns "fixed in source" into "fixed on chain": deploy the hardened generation, migrate the reserve, verify the new addresses and re-run the proofs. The mainnet trove remains the honest gap — it needs about 0.037 BTC locked to clear Mezo's minimum debt.

Links: https://pylon-mezo.vercel.app | https://pylon-mezo.vercel.app/mainnet/ | https://github.com/PhiBao/pylon-mezo
