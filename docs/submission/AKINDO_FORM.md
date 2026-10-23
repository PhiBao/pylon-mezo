# AKINDO submission — paste-ready fields

## Tagline

Pylon is the execution and risk terminal for Mezo borrowers: flash leverage, self-deleveraging and a
redemption shield for your Bitcoin trove — one EIP-712 signature per action, live on testnet and
mainnet.

---

## About

## What it does

Pylon turns a Mezo MUSD trove into a position you can actually steer, without giving up custody:

- **Flash Loop** — borrow MUSD, swap it to BTC, post that BTC as collateral, and repay the flash loan inside one transaction.
- **Flash Unwind** — repay debt out of the trove's own collateral, with zero MUSD in the wallet.
- **Flash Exit** — close the trove entirely, funded by itself, and return the rest as BTC.
- **Redemption Shield** — a MUSD reserve that only ever lends to a registered position and only to repay its debt; the claim is enforced in code, not by policy.

Every action is one EIP-712 ballot signed by the owner and either relayed by the engine or self-broadcast. The terminal also plots the full `SortedTroves` redemption queue, prices each atomic path leg by leg before signing, and exposes an x402 paid telemetry endpoint for agents.

Live: [testnet terminal](https://pylon-mezo.vercel.app/) · [mainnet build](https://pylon-mezo.vercel.app/mainnet/) · [repo](https://github.com/PhiBao/pylon-mezo)

## The problem it solves

Mezo is a Liquity-style CDP: MUSD is redeemable for BTC against the lowest-ICR trove above the 110% MCR. A borrower sitting at 135% is therefore exposed to redemptions long before liquidation — with no warning in any UI. Repaying requires MUSD the borrower may not have, looping takes 6–15 transactions, and the queue that decides who gets redeemed is invisible.

Pylon closes those three gaps: it makes the queue legible (live radar, redemption depth, buffer ahead of every trove), makes leverage atomic (one flash transaction instead of a dozen), and turns defence into a priced, enforceable market instead of a manual panic.

## Challenges I ran into

- **Solidly-style pools cannot be swapped inside their own flash callback.** Split the path into a flash venue and a swap venue, both inside one transaction.
- **`BorrowerOperationsSignatures` burns from its own caller.** Flash proceeds have to stay in the engine; the position contract cannot hold them.
- **Mezo's BTC ledger is one native/ERC-20 balance.** Value is already credited when the callee body runs, which changes the ordering of every leg.
- **Hint resolution is expensive.** The solver supplies `SortedTroves` hints and the contract validates them on chain.
- **The public testnet RPC is hostile:** hidden revert data, missing receipts, misleading gas. The engine records proofs, and the terminal falls back to direct reads when it is absent.
- A 35-finding audit (5 high) plus a quote-shape mismatch that only appeared when the engine was healthy — a successful quote could crash the terminal. Both are fixed with regression tests.

## Technologies I used

Solidity 0.8.24 + Foundry (flash engine, shield reserve, EIP-1167 positions), Mezo core (`TroveManager`, `SortedTroves`, `BorrowerOperationsSignatures`, MUSD, the BTC precompile), Tigris pools + router, Rust (Axum, Tokio, alloy) for the radar, solver, keeper and relay, Next.js 15 + TypeScript + wagmi/viem + Tailwind for the terminal, Fly.io and Vercel for hosting.

## How we built it

Contracts first, against a faithful Mezo/Tigris harness (43 Foundry tests, including a BTC mock that models the unified native ledger). Then the Rust engine: queue walk, local pricing, EIP-712 assembly, keeper, x402. Then the terminal, which works with no backend at all and upgrades to the engine when present. Four generations on testnet; the audited generation is deployed on mainnet (31612) with real MUSD, a funded reserve, and a migration that left nothing stranded.

## What we learned

- The primitive that matters is the signature, not custody: one ballot can move an entire position.
- Redemption risk is a queue problem, not a liquidation problem — showing the queue changes how people size a trove.
- On testnets, the RPC is part of the product: fallbacks and receipts decide whether a demo survives.
- Audit findings cluster at accounting edges (flash fee, share pricing), not on the happy path.

## What's next for

- An external audit before third-party capital, plus multisig roles for the reserve.
- Defence ballots for native troves and a keeper bounty market.
- More MUSD pairs: Mezo mainnet lists 33, and the engine takes its venues as constructor arguments.
- Mainnet execution once the mainnet trove clears Mezo's 1,800 MUSD minimum debt.

---

## Build with

```
Mezo
Bitcoin
MUSD
Tigris
```

## Product Category (max 3)

```
DeFi
Lending
Market Infrastructure
```

(If the picker only offers fixed labels, use **DeFi** + **Lending** + **Other**.)

## Tags (max 10)

```
Solidity
Foundry
Rust
Axum
Next.js
TypeScript
wagmi
viem
EIP-712
Fly.io
```

---

## Image gallery (5 files, 16:9)

| Slot | File | Shows |
|---|---|---|
| 1 | `docs/submission/gallery/01-cover.jpg` | PYLON title, thesis, testnet/mainnet/proof |
| 2 | `docs/submission/gallery/02-radar.jpg` | live redemption radar with the hover walk (429.1M MUSD queue) |
| 3 | `docs/submission/gallery/03-xray.jpg` | live position + 0.0005 BTC loop priced leg by leg |
| 4 | `docs/submission/gallery/04-executed.jpg` | confirmed relayed execution with the tx hash |
| 5 | `docs/submission/gallery/05-mainnet.jpg` | the mainnet bundle (31612, RPC reads, real reserve) |

All 1920×1080 (the cover 2560×1440), JPEG, ≤ 460 KB each.
