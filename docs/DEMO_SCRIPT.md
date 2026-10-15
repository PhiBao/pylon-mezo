# Pylon — 2-minute demo script

Recording setup: terminal at 1600×1000 (or a 1440-wide window), engine service running
(`pylon-server serve`), the production bundle served (`cd web && pnpm exec serve out`), wallet
disconnected. Total run time ≈ 1:55. Every transaction referenced is already mined, so nothing in this
script depends on live confirmation timing.

---

## 0:00 – 0:15 · Hook

**On screen:** the terminal, untouched. The radar loads with 245 troves.

> "Mezo lets you borrow a dollar against your Bitcoin at one percent. That loan has three problems.
> You can't lever it up without a dozen manual transactions. You can't deleverage it unless you already
> hold MUSD. And you can lose Bitcoin to a redemption while your collateral ratio still looks healthy."

## 0:15 – 0:35 · The queue nobody shows you

**Action:** point at the radar strip and the tail table (ranks 1–9).

> "This is `SortedTroves`, read live. In Mezo, redemptions walk up from the *lowest* collateral ratio
> above 110 percent — so the four-hundred-million dollars of queue depth behind this strip is the real
> risk surface, not the liquidation line. Rank one sits at a hundred and eleven percent."

## 0:35 – 1:05 · Flash Loop

**Action:** Architect → `Loop`. Paste the operator's trove — or simply connect and pick your own. Drag
the slider to 0.005 BTC. The X-Ray fills in.

> "One signature authorises the exact collateral and debt deltas. That signature *is* the slippage
> guard — Pylon cannot move more than you signed."

**Action:** execute, then open the transaction.

> "One transaction: flash-borrow 394 MUSD from the MUSD/mUSDC pool, swap it for BTC on the MUSD/BTC
> pool, post that BTC as collateral, borrow against the trove to repay the flash, and route the
> origination fee to the shield reserve — all inside one block. The reserve's share price just moved
> because of our own trade."

## 1:05 – 1:25 · Flash Unwind — the part that should not be possible

**Action:** Architect → `Unwind`, repay 300 MUSD, wallet balance card reads **0 MUSD**.

> "Now the failure mode. I spent my MUSD and I want the debt gone. On the Mezo app this is
> impossible — repayment needs MUSD I have, and my collateral is locked behind the repayment."

**Action:** execute, open the transaction.

> "Pylon flashes the exact repayment, the trove's debt falls by three hundred, releases just enough
> collateral to repay the flash, and returns the rest. My wallet still had zero MUSD when it started."

## 1:25 – 1:45 · Shield defence

**Action:** `Reserve` page → point at the outstanding loan row (position `0xE077…DC23`, 543.94 MUSD,
179.9% ICR, shield `armed`), then open the defence transaction from `Proofs`.

> "This position armed a band: defend below 160 percent, toward 180. It sat at 142. The defence was
> called by a third party — anyone can do this — the reserve lent 543.94 MUSD, the position repaid its
> own debt, and the ratio came back to 180. Try to withdraw collateral now and the position reverts:
> the reserve's claim is enforced in code, not in policy."

## 1:45 – 1:55 · Close

**Action:** `Proofs` page, scroll the ledger.

> "Every claim in this terminal resolves to a Mezo transaction — loop, unwind, exit, defence, deposit.
> And the same primitives are callable by software: the engine exposes quotes and execution over HTTP,
> and paid telemetry settles in MUSD over x402. Pylon. A Bitcoin loan you can steer."

---

## Appendix — the transactions on screen

| Moment | Hash |
| --- | --- |
| Flash loop | `0x7933c8531f1c368da18ec70496e3d5eb5d6167f2b0160a63db224d21751e6430` |
| Flash unwind | `0xe7e020535e7888a5d34a51eedacac0f79d2e84ef100c728e33817fb39b32b7e2` |
| Flash exit | `0xfd3e382ffa9b180939f52dfd8214f75ef6e1bc9f28bd42de500d572e7de48311` |
| Shield defence | `0x0e3b671079592808ca499c830367a4f7deb012ae2c0f7bd9b6e9cdda2a2fb511` |
| Reserve seeded | `0x9321dd9e394cf0166fd9cf0fcd78d49b31b142bf1c05bad47e190ef052600b68` |
| Trove opened | `0xe10f306cc3d04df73f9945301bd16b68d7c273413f2a99e9ab0ba355bc0792ae` |

Explorer: `https://explorer.test.mezo.org/tx/<hash>`

## Recording notes

* The unwind segment is the emotional peak — hold the "0 MUSD" readout on screen for a beat before
  executing.
* If the engine service is unavailable during recording, the terminal falls back to direct RPC reads and
  shows `RPC READ-ONLY`; the quotes still resolve, so the demo survives.
* Do not re-run the loop against the same trove mid-recording: it moves the numbers cited in the script
  (the debt delta depends on live pool depth).
