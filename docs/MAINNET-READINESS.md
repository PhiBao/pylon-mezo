# Pylon — Mezo mainnet readiness

Verified from this machine against live Mezo mainnet RPCs on 15 Oct 2026. Nothing here is copied
from memory: every address and number came from Mezo's own repositories (`mezo-org/musd`,
`mezo-org/tigris`, `mezo-org/mezod`, `mezo-org/evm-chain-list`) and was then read back from the chain.

Re-run the whole check at any time:

```bash
cd contracts && ./script/verify-mainnet.sh          # defaults to a public mainnet RPC
```

## 1. What mainnet already has

| Item | Mainnet (chain **31612**) |
| --- | --- |
| MUSD | `0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186` — total supply 29.87M |
| BTC ledger | `0x7b7C000000000000000000000000000000000000` — `balanceOf` **equals** the native balance (verified against the MUSD/BTC pool) |
| BorrowerOperations | `0x44b1bac67dDA612a41a58AAf779143B181dEe031` |
| **BorrowerOperationsSignatures** | `0xB57ab578BF20b3e318f3EFAA587C51DBccE5df7a` — `getNonce` present, EIP-712 domain `("BorrowerOperationsSignatures", "1", 31612, …)`, **identical to testnet apart from the chain id** |
| TroveManager / SortedTroves / HintHelpers / PriceFeed | `0x94AfB503…`, `0x8C5DB4C6…`, `0xD267b3bE…`, `0xc5aC5A88…` |
| Parameters | minNetDebt 1,800 MUSD · gas compensation 200 MUSD · MCR 110% · CCR 150% · borrowing fee 0.1% · BTC oracle 82,150 MUSD/BTC |
| Troves live right now | **8** |
| Tigris PoolFactory / Router | `0x83FE469C…` / `0x16A76d3c…` (router `defaultFactory` == the pool factory, which the engine asserts at deploy) |
| Pools | **33**, including a full set of MUSD pairs with tokenised equities (MSTR, COIN, TSLA, NVDA, GOOGL, CRCL, BTDR) and WUSD, sUSDat, mSolvBTC, mT, REKT |

## 2. Pylon's venues exist on mainnet

| Role | Pool | Depth | Fee |
| --- | --- | --- | --- |
| **Flash** (stable MUSD pool) | `0x10906a9E…` MUSD/mUSDT (also `0xEd812AEc…` MUSD/mUSDC) | 7.70M MUSD (6.86M) | **2 bps** |
| **Swap** (volatile MUSD/BTC) | `0x52e604c4…` | 102.98M MUSD / 1.2375 BTC | **30 bps** |

Both legs therefore have real venues, and the flash pool's depth covers any trove Mezo's minimum debt
allows with three orders of magnitude to spare.

**One economic difference to plan for:** the volatile fee on mainnet is **30 bps**, not the 4 bps the
testnet pool charges. With Pylon's own 20 bps origination fee and the 2 bps flash fee, a mainnet loop
or unwind pays ≈0.52% of the flashed notional, against ≈0.25% on testnet. Fee parameters and the
interface's "cost of this operation" copy must be set for the mainnet venue, not copied from testnet.

**One product opportunity:** the engine takes `flashPool` and `swapPool` as constructor arguments and
does not care what the pair is called. The same audited bytecode can serve any of the 33 MUSD pairs —
including the tokenised-equity pairs — which is a second market for the same product, and a reason the
mainnet deployment is not just a testnet replica.

## 3. Cost of going live, in real numbers

Mainnet gas price at the time of writing: **1,462,500 wei (0.0014625 gwei)**, base fee 1.3M wei.
With BTC at 82,150 MUSD:

**Executed on 21 Oct 2026:** package A (deployment) and package B (real MUSD through the reserve,
plus the withdrawal that exercises the escape route) are done on mainnet — and the pool was then
*migrated to a second generation* with the capital intact, so the upgrade path is proven with real
value rather than only in tests. Package C — a real trove for the atomic paths — is not, and is out of
reach at this budget: Mezo's 2,000 MUSD debt floor needs 0.0268–0.0365 BTC, roughly $2,200–3,000.

| What | Cost | Evidence it produces |
| --- | --- | --- |
| **A. Deployment** — the three audited contracts deployed and wired | **≈0.8 MUSD of gas** (reserve alone ≈0.24) | the audited bytecode is live and wired on Mezo mainnet; verifiable by anyone in seconds |
| **B. Value flow** — A, plus a real MUSD round trip through the reserve and a real `x402` settlement | **≈1 MUSD of gas + 20–30 MUSD** (buyable in the MUSD/BTC pool for ~0.0003 BTC + 30 bps) | real MUSD enters and leaves an audited Pylon contract on mainnet, at the corrected share pricing; a real machine payment is verified by the service |
| **C. Atomic paths** — B, plus one real trove to run Flash Loop, Unwind, Exit and a reserve defence | **A + 0.0268–0.0365 BTC (≈2,200–3,000 MUSD)** | the three atomic paths and the shield, executed against real Mezo mainnet state with real money |

The jump from B to C is not Pylon's choice: Mezo's protocol floor is **minNetDebt 1,800 MUSD plus the
200 MUSD gas compensation**, so the smallest trove that can exist carries 2,000 MUSD of debt against
collateral worth at least 2,200 MUSD. No deployment trick avoids it.

**$10 buys package A several times over, and package B once.** Package C is a $2–3k decision.

## 4. What still has to happen before package A is honest to describe

1. **A mainnet deployment config** — `contracts/deployments/31612.json` with the addresses above, and
   the interface/service switches (`web/src/lib/chain.ts`, `server/.env`, `server/src/config.rs`).
   No contract changes are needed: every network constant is a constructor argument or an env value,
   and the EIP-712 domain is built from the chain id and the helper address.
2. **Fee and cap recalibration** for the 30 bps venue (see §2) and for real liquidity.
3. **A guarded rescue function.** Today a stray transfer to the engine is unrecoverable. Fine on
   testnet; not defensible with real funds.
4. **The open hint-solver item** (§5 of `docs/AUDIT.md`). The native-trove paths are proven live; the
   position-mode path is not, and money should not be the first thing to exercise it.
5. **Key management.** A dedicated keeper key, a multisig as owner, and the proof ledger pointed at
   mainnet.
6. **An external audit** before any third-party capital. The report in `docs/AUDIT.md` is self-run:
   good enough for a submission, not enough for a treasury.

## 5. Honest wording for the submission

Until packages are executed, the correct claim is:

> Pylon's audited contracts are tested against Mezo testnet end to end, and mainnet readiness is
> verified against Mezo's deployed core: MUSD, the BTC ledger, the trove stack, the EIP-712 signature
> helper and both venue pools are present and were read live. See `docs/MAINNET-READINESS.md`.

After package A, the claim becomes: "deployed and wired on Mezo mainnet at <addresses>". After B:
"moving real MUSD on mainnet". Only after C: "the atomic paths run on mainnet".

Do not compress those steps into one claim: a judge can check each of them, and the deployment
addresses alone do not prove value flow.
