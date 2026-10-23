# AKINDO — Wave 1 answers (plain text)

## Updates in this Wave

This wave we built Pylon from scratch: a non-custodial terminal that lets a Mezo borrower loop, unwind, exit or defend their own trove, one transaction per action and one signature from the owner.

What shipped:

Contracts. A flash engine, a shield reserve and position contracts, written in Solidity with Foundry. They were audited (35 findings, 5 high; 32 fixed) and covered by 43 tests.

Engine. A Rust service that reads the redemption queue, prices each route, runs the keeper, records every operation and relays signed transactions. It also serves a paid x402 endpoint. Live on Fly.io.

Terminal. A Next.js app on Vercel: redemption radar, an x-ray that prices every leg before signing, the shield reserve, the proof ledger, docs, and a switch between testnet and mainnet. It also works with no backend by reading Mezo directly.

Deployments. Testnet (31611) runs the full product. Mainnet (31612) runs the same audited contracts with real MUSD: a funded reserve, a second depositor priced correctly, and a pool migration with nothing stranded.

Proof. A relayed loop, an unwind, a full exit, a keeper defence and a mainnet x402 payment, each linked to its transaction.

Materials. A 10-slide deck and a 1:45 demo video that includes a real execution.

Links: https://pylon-mezo.vercel.app | https://pylon-mezo.vercel.app/mainnet/ | https://github.com/PhiBao/pylon-mezo

---

## Milestone

Pylon is a tool for people who borrow MUSD against Bitcoin on Mezo.

The problem: a Mezo loan can be liquidated, but it can also be redeemed against. Anyone holding MUSD can repay the lowest-ratio trove above 110% and take its BTC. Borrowers cannot see that queue, cannot easily lever up, and cannot repay without already holding MUSD.

What Pylon does, on the borrower's own trove:

- Flash Loop: borrow MUSD, swap it to BTC, add it as collateral and repay the flash loan in one transaction.
- Flash Unwind: repay debt using the trove's own collateral, with no MUSD in the wallet.
- Flash Exit: close the trove and return the remaining BTC.
- Redemption Shield: a MUSD reserve that only lends to repay a registered position's debt. The position cannot release collateral until the loan is settled, so the protection is enforced by code.

The owner signs one EIP-712 message per action. Pylon never holds the position or the funds.

Under the hood: Solidity and Foundry contracts, a Rust (Axum) engine, and a Next.js terminal. 43 contract tests and 9 Rust tests. Both networks are deployed and public.

Why it matters: Mezo's redemption risk is invisible in most interfaces, and the operations borrowers need are the ones that require MUSD upfront. Pylon makes the queue readable, the leverage atomic, and the defence automatic.

Links: https://pylon-mezo.vercel.app | https://pylon-mezo.vercel.app/mainnet/ | https://github.com/PhiBao/pylon-mezo
