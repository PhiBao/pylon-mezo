# Contract verification — status and how to retry

Mezo testnet explorer: <https://explorer.test.mezo.org/address/>\<address>
Sourcify: <https://repo.sourcify.dev/contracts/full_match/31611/>\<address>/

| Contract | Address | Status |
|---|---|---|
| `PylonFlashEngine` | `0xa1780be8f3c6e07714F51e5063839D6a6c61EE0b` | **match** (Sourcify, job `916db073-…`) |
| `PylonReserve` | `0xAC8239Ca9eE97c7aB044447063aC77ddC4E8Bb31` | **match** (Sourcify, job `a34429c8-…`) |
| `PylonPosition` (template) | `0xe22fB3036840d41A96612BA1686EBeaCe1b7141D` | **match** (Sourcify, job `1f975c71-…`, runtime bytecode) |

## All three contracts verify now

The earlier `no_match` had nothing to do with settings or bytecode — it was the **module set**.
Foundry compiles the whole project (38 source units, including `test/` and `script/`) in one
via_ir pipeline; reproducing the deployment therefore requires the same input. A minimal
dependency-closed input (8 files) produces a different — though valid — bytecode, and that is
what Sourcify's module-graph compilation kept producing. The full 38-unit input reproduces the
on-chain bytecode byte-for-byte (24,258 bytes, `keccak` of it matches the on-chain code
`0x60806040…becc55f00`), and Sourcify accepts it:

```
POST /v2/verify/31611/0xe22fB3036840d41A96612BA1686EBeaCe1b7141D
{ "stdJsonInput": <docs/verification/PylonPosition-standard-json.json>,
  "compilerVersion": "0.8.24+commit.e11b9ed9",
  "contractIdentifier": "src/PylonPosition.sol:PylonPosition" }
→ match: match · runtimeMatch: match
```

`docs/verification/PylonPosition-standard-json.json` is that exact input (full source units,
trimmed only for `outputSelection` size). Explorer UIs with a "Standard JSON" tab (e.g. the Mezo
Blockscout) accept the same file if Sourcify-style verification is unavailable.

## How the earlier no_match was diagnosed — and why it misled us



The deployed template's runtime bytecode is **byte-identical** to the local build from the
current source (`contracts/out/PylonPosition.sol/PylonPosition.json`, ERC-1167-ancestor clone
implementation): after a clean `forge build`, the two are 12,129 bytes and 0 differing bytes.
The earlier "~395 byte drift" was a stale forge cache, not a source difference.

Sourcify nonetheless reports `no_match` on both verification paths:

- `forge verify-contract … --verifier sourcify` (job `f0798aaa-…`, later `cdbc32fe-…`)
- Direct metadata API: `POST /v2/verify/metadata/31611/{address}` with the exact build metadata
  and sources, plus creation transaction `0x29bce74a…a86` (job `054f7d63-…`)

In both cases the recompiled runtime differs from the on-chain runtime in 1,247 bytes, all of
which are dispatcher/jump-table constants shifted by small deltas (offset 624 onward). The
compiler inputs match — `solc 0.8.24+commit.e11b9ed9`, viaIR, optimizer 200, cancun,
`bytecodeHash: none` — and the engine and reserve (same toolchain, same settings) verify cleanly,
so this is a pipeline discrepancy in Sourcify's recompilation of this larger module rather than
a source or settings problem on our side. It cannot be fixed by editing project files.

## What you can do

1. **Accept it (recommended for the hackathon).** The fund-holding contracts are verified; the
   template's deployed code is proven byte-identical to the audited source. The clone holds no
   funds of its own (positions are EIP-1167 proxies).
2. **Try the Mezo explorer's Verify & Publish UI by hand** — engine and reserve matched on
   purpose; the explorer UI may use a native solc pipeline that matches. File ready at
   `docs/verification/PylonPosition-standard-json.json` (solc 0.8.24, viaIR, optimizer 200,
   cancun, `bytecodeHash: none`). Steps:
   1. Open the template page on explorer.test.mezo.org → **Code** → **Verify & Publish**.
   2. Choose **Standard JSON** input, paste the file above, set compiler `v0.8.24+commit.e11b9ed9`,
      and pick `src/PylonPosition.sol:PylonPosition` as the contract.
   3. If the UI has no such tab, the explorer serves no public verification API either
      (every REST path returns the "page not found" shell), and the attempt is over.
3. If a future generation is deployed with **default bytecode hash** (drop
   `bytecode_hash = "none"`), Sourcify's CBOR-anchored matching has a better chance — but that
   is a new deploy, not a fix for this one.

Sourcify job results are re-checkable with:

```bash
curl -s https://sourcify.dev/server/v2/verify/054f7d63-e080-4612-be8e-7463c90b06e8 | jq '.contract, .error.customCode'
```
