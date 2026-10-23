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

## Milestone (plan for Wave 2)

In wave 2 we will take Pylon from a working testnet and mainnet deployment to a product that can be used with real money end to end.

1. Mainnet execution. Fund a mainnet trove above Mezo's 1,800 MUSD minimum debt and run the full flow there: loop, unwind, exit and a shield defence, each with a public transaction.

2. External audit and controls. Commission an independent audit of the contracts and the relay, then add multisig ownership and role separation for the reserve before any third-party capital.

3. Shield for native troves. Today the shield works on Pylon positions. Wave 2 adds defence ballots for native Mezo troves, so a borrower can keep the trove they already have and still be defended.

4. Keeper market. Open defence to third-party keepers with a fee, so a position can be defended even when its owner is offline.

5. More MUSD pairs. Mezo mainnet lists 33 MUSD pairs, and the engine already takes its venues as constructor arguments. Wave 2 adds the top pairs (mUSDC, mUSDT, tokenised equity) with per-pair limits.

6. Reliability. Write relayed executions into the proof ledger, add RPC failover, alert on keeper and reserve health, and publish an incident runbook.

Success for wave 2: one real mainnet loop, one mainnet shield defence, an external audit report, and a keeper that defends a position nobody is watching.
