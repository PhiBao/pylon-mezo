# AKINDO — Wave 2 answers

## Updates in this Wave (≤ 3,000 characters)

Wave 2 turned Pylon from a testnet prototype into a two-network product with a public deployment, a funded mainnet instance, and a working execution path.

**Mainnet (31612), live with real MUSD.** The audited generation is deployed and funded: engine `0x8DEa475605ac7a99ad28F0DD3537A93b2aCf655D`, reserve `0x81175AaAC5Fa0873e64480502566Fe993bB88e62`, position implementation `0x645174D655814839a85Bd80D2F54b35A7160465E`. A real deposit round trip priced a second depositor exactly right, the pool migrated to a new generation with capital intact, and a machine payment settled in MUSD over x402. https://explorer.mezo.org/address/0x81175AaAC5Fa0873e64480502566Fe993bB88e62

**Public hosting.** The terminal runs on Vercel (https://pylon-mezo.vercel.app) and the Rust engine on Fly.io (https://pylon-mezo-api.fly.dev) with the radar, quotes, proof ledger, x402 and the relay live. The GitHub Pages mirror was removed; the repo is the single source.

**Network switch.** Two prerendered bundles now ship from one repo: testnet at `/` (engine API) and mainnet at `/mainnet/` (RPC-only, mainnet contracts, real reserve state). The header network chip is a dropdown listing both chains; the wallet is switched to the bundle's chain automatically on connect and after switching networks, and the chain is added first if the wallet doesn't know it. https://pylon-mezo.vercel.app/mainnet/

**Execution relay fixed.** The relay asked the server for `/api/v1/build/*`, which did not exist, so it could never execute. Positions are now driven directly by the engine (their owner authorises it through `canExecute`), while native troves keep the borrower's EIP-712 ballot; `minPostIcr` is forwarded instead of silently dropped. A real relayed loop: `0xe198fb3b11160c2fd489c636da87e247d2d2c760d120c20fd54491a3c0b90861`.

**Product hardening.** 35 audit findings (5 high), 32 fixed; 43 Foundry + 9 Rust tests. Quote payloads are normalised at the fetch boundary (a healthy engine could crash the terminal), ledger kinds are mapped so badges and filters work, a `uint256`-max ICR is guarded, the radar readout no longer reflows the page on hover, and the loop slider labels no longer collide at the right edge.

**Submission material.** A 10-slide deck (`docs/deck/pylon-deck.pdf`) and a 1:45 narrated demo with a real execution (`docs/video/pylon-demo.mp4`).

Repo: https://github.com/PhiBao/pylon-mezo

---

## Milestone — 2nd Wave

Pylon is a non-custodial execution and risk terminal for Mezo borrowers. This wave delivered its production shape: mainnet, public hosting, a network switch, and an execution path that works end to end.

**What the product does.** Flash Loop — borrow MUSD, swap it to BTC, post that BTC as collateral and repay the flash loan inside one transaction. Flash Unwind — repay debt out of the trove's own collateral, with zero MUSD in the wallet. Flash Exit — close the trove entirely, funded by itself, and return the rest as BTC. Redemption Shield — a MUSD reserve that only lends to a registered position and only to repay its debt, with the claim enforced in code. Every action is one EIP-712 ballot signed by the owner; Pylon never holds the position.

**Contracts (Solidity 0.8.24 + Foundry).** Flash engine, reserve with share accounting and utilisation caps, EIP-1167 positions carrying shield policies. Testnet: engine `0x901198cD4EE9086997D839401f361518cAE46ed6`, reserve `0x53a0206A307E084AdA2eB24346463cf4E14C5131`. Mainnet: engine `0x8DEa475605ac7a99ad28F0DD3537A93b2aCf655D`, reserve `0x81175AaAC5Fa0873e64480502566Fe993bB88e62`. 43 tests run against a faithful Mezo/Tigris harness, including a BTC mock that models the unified native ledger.

**Engine (Rust).** An Axum/Tokio service that walks `SortedTroves`, prices loops against both venues, assembles the ballots, runs the keeper, records the proof ledger and serves the x402 endpoint. Deployed on Fly.io with a volume for the ledger; `ALLOW_RELAY` is gated and the operator key stays server-side.

**Terminal (Next.js 15, TypeScript, wagmi/viem).** Works with no backend at all — reads fall back to direct Mezo RPC — and upgrades to the engine when it is present. Redemption radar over the live queue with redemption depth and buffer ahead, an atomic x-ray that prices every leg before signing, the shield reserve, the explorer-linked proof ledger, in-app docs and the x402 panel. Static export, two network bundles, automatic chain switching, and a UI built for dense protocol data.

**Evidence, all on chain.** A real relayed loop `0xe198fb3b11160c2fd489c636da87e247d2d2c760d120c20fd54491a3c0b90861`; the reserve at 1,107 MUSD of assets, 332.18 MUSD lent, 2.70 MUSD of fees; an autonomous keeper defence `0x456e815b049105283943e026e55b132e54e4614f62ed235fb0351046e980b84b`; a mainnet reserve funded with real MUSD.

**Why it matters.** Mezo redemptions walk up from the lowest-ICR trove above 110%, so a borrower can lose BTC without a liquidation warning, and repaying requires MUSD they may not have. Pylon makes that queue legible, makes leverage atomic, and turns defence into a priced market instead of a manual panic.

Live: https://pylon-mezo.vercel.app · mainnet: https://pylon-mezo.vercel.app/mainnet/ · repo: https://github.com/PhiBao/pylon-mezo · video: `docs/video/pylon-demo.mp4`
