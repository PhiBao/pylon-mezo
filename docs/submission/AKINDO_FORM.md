# AKINDO submission: final copy (Wave 2)

Paste-ready fields for the final entry. Numbers and links match the repository at `21d9604`.

## Tagline

Pylon is the execution and risk terminal for Mezo borrowers: flash leverage, self-deleveraging and a
redemption shield for Bitcoin troves. Every action is one signature and one transaction. Running on
Mezo testnet, with the audited generation deployed on mainnet.

---

## About

### What it does

Pylon turns a Mezo MUSD trove into a position you can steer without giving up custody:

- **Flash Loop**: borrow MUSD, swap it for BTC, post that BTC as collateral and repay the flash loan
  inside one transaction.
- **Flash Unwind**: repay debt out of the trove's own collateral, with no MUSD in the wallet.
- **Flash Exit**: close the trove and return what is left, funded by the trove itself.
- **Redemption Shield**: a MUSD reserve that lends only to a registered position and only to repay
  that position's debt. The claim is enforced by the contract.

Every action is one EIP-712 ballot signed by the owner, then relayed by the engine or broadcast from
the wallet. The terminal draws the live `SortedTroves` redemption queue, prices every leg before
anything is signed, and sells a single trove report to agents over x402.

Live: [testnet terminal](https://pylon-mezo.vercel.app/) ·
[mainnet build](https://pylon-mezo.vercel.app/mainnet/) ·
[repo](https://github.com/PhiBao/pylon-mezo) ·
[walkthrough video](https://github.com/PhiBao/pylon-mezo/raw/main/docs/video/pylon-wave2.mp4)

### The problem it solves

Mezo is a Liquity-style CDP. MUSD is redeemable for BTC against the lowest-ICR trove above the 110%
MCR, so a borrower sitting at 135% can lose collateral to redemptions long before liquidation, and
nothing in the current UIs warns them. Repaying needs MUSD they may not have. Looping takes a dozen
transactions. The queue that decides who pays is invisible.

Pylon makes the queue legible and leverage atomic, and turns defence into a priced, enforceable
market.

### Challenges I ran into

- **Solidly-style pools cannot be swapped inside their own flash callback.** The path is split into a
  flash venue and a swap venue, both inside one transaction.
- **`BorrowerOperationsSignatures` burns from its own caller.** Flash proceeds have to stay in the
  engine; the position contract cannot hold them.
- **Mezo's BTC ledger is one native/ERC-20 balance.** Value is already credited when the callee body
  runs, which changes the ordering of every leg.
- **Hint resolution is expensive and time-sensitive.** The solver supplies `SortedTroves` hints and
  the contract validates them; a relay that passes hints across a block boundary can revert, so
  position relays now let the position resolve them at execution time.
- **The public testnet RPC is hostile:** hidden revert data, missing receipts, occasional 403s to
  browser traffic. The engine keeps a proof ledger, the terminal falls back to direct reads, and the
  service now proxies browser JSON-RPC so a wallet transaction does not depend on the node's mood.
- **Two audit rounds.** The first found 35 issues (5 high, 32 fixed with regression tests). The second
  found 10 (4 high, 3 medium, 2 low, 1 rejected with source evidence): 7 fixed, 2 accepted and
  documented, including a surplus path that could release BTC while a reserve loan was open.
- **Verification drift.** Sourcify only reproduced the deployment with the full 38-source compilation
  input that Foundry used, not the dependency-closed module set explorers compile by default.

### Technologies I used

Solidity 0.8.24 + Foundry (flash engine, shield reserve, EIP-1167 positions), Mezo core
(`TroveManager`, `SortedTroves`, `BorrowerOperationsSignatures`, MUSD, the BTC precompile), Tigris
pools and router, Rust (Axum, Tokio, alloy) for the radar, solver, keeper and relay, Next.js 15 +
TypeScript + wagmi/viem + Tailwind for the terminal, Fly.io and Vercel for hosting.

### How we built it

Contracts first, against a faithful Mezo/Tigris harness (52 Foundry tests, including a BTC mock that
models the unified native ledger). Then the Rust engine: queue walk, local pricing, EIP-712
assembly, keeper, x402. Then the terminal, which works with no backend and upgrades to the engine
when present. Several generations later, the hardened v6 runs on testnet with timelocked admin,
borrowing-capacity and Recovery Mode pre-checks, and all three contracts verified on Sourcify; the audited
generation is deployed on mainnet with real MUSD and a funded reserve.

In Wave 2, five wallets funded from the Mezo faucet ran the whole flow under their own keys (create,
trove, shield, flash loop), every transaction linked in `docs/USERS.md`, and one of them repeats the
execution on camera in the walkthrough.

### What we learned

- One signed ballot can move an entire position, so the signature and the calldata it authorises are
  the things to get right.
- Liquidation is not the only risk that matters to a borrower. The redemption queue is the one that
  arrives first, and showing borrowers their place in it changes how they size a trove.
- On testnets the RPC is part of the product. Fallbacks, receipts and a proof ledger decide whether a
  demo survives.
- Audit findings cluster at accounting edges (flash fee, share pricing), not on the happy path.

### What's next for

- A paid external audit and multisig roles for the reserve before third-party capital at scale.
- Defence ballots for native troves and a keeper bounty market.
- More MUSD pairs: Mezo mainnet lists 33, and the engine takes its venues as constructor arguments.
- A Pylon position on mainnet once the trove clears Mezo's 1,800 MUSD minimum debt (about 0.037 BTC).

---

## Demo video (final)

`docs/video/pylon-wave2.mp4`: 1:44, 1920×1080, 30 fps, narrated, subtitles burned in, sidecar `.srt`.

Direct: https://github.com/PhiBao/pylon-mezo/raw/main/docs/video/pylon-wave2.mp4

It records an outside user (user1, position `0x1027ac4a…1833`) opening the live terminal, reading the
queue, sizing a 0.001 BTC flash loop, signing once, and the engine relay confirming the transaction
on screen. Both recording loops are explorer-linked and in the proof ledger.

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
| 1 | `docs/submission/gallery/01-cover.jpg` | the terminal as it loads: live radar, architect, reserve, and the proof ledger with the two relayed recording loops (2560×1440) |
| 2 | `docs/submission/gallery/02-radar.jpg` | the live redemption radar: 367 troves, 429.4M MUSD queued, tail / watch / buffered bands |
| 3 | `docs/submission/gallery/03-xray.jpg` | an outside user's position priced for a 0.001 BTC flash loop: borrow, swap, debt delta, post-loop ICR |
| 4 | `docs/submission/gallery/04-executed.jpg` | the confirmed relayed loop: all four stages green, tx hash on screen |
| 5 | `docs/submission/gallery/05-mainnet.jpg` | the mainnet bundle on 31612: RPC reads, three mainnet troves, the seeded reserve |

All 16:9, JPEG, 238 to 374 KB each. The cover is 2560×1440, the rest are 1920×1080.
