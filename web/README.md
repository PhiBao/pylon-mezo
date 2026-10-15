# Pylon — Redemption Terminal

**A non-custodial execution and risk terminal for Mezo bitcoin CDPs.**

Pylon gives an existing Mezo bitcoin trove three operations it cannot perform on its own — **flash loop**,
**flash unwind** and **flash exit** — funded by flash liquidity from Mezo's native Tigris pools, and shows
every borrower their exact position in the protocol's redemption queue with a **redemption shield** that
pays down debt before a redemption can reach their collateral.

Built for the **Mezo Buildathon** on Mezo Testnet (chain id 31611).

```
Mezo MCR 110%   ·   CCR 150%   ·   min net debt 1,800 MUSD   ·   gas compensation 200 MUSD
Pylon fee 0.20% ·   flash venue 0.01%   ·   swap 0.04%        ·   Mezo borrow fee 0.10% / 1.00% fixed interest
```

---

## 1. Product

### What it is

A precision terminal that sits on top of Mezo's CDP system and treats **redemption** as the primary risk a
borrower manages — not liquidation.

Mezo is a Liquity-style protocol: any MUSD holder can redeem 1 MUSD for $1 of BTC against the trove with the
lowest collateralisation ratio that is still above the 110% minimum. That trove is found by walking
`SortedTroves`, which means a borrower's real exposure is not "am I above 110%?" but **"how much redemption
volume stands in front of me, and what happens when it arrives?"**

Pylon answers that question with a chart, a number, and three atomic ways to act on it.

### Who it is for

- **Leveraged bitcoin borrowers** on Mezo who want to size, hedge or retire a position without parking MUSD
  in a wallet first.
- **Borrowers sitting in the redemption tail** (111–130% ICR) who need to move up the queue without selling
  BTC on a CEX.
- **Agent builders and keepers** who want to buy a single execution through an HTTP 402 endpoint instead of
  holding a trove owner's key.
- **Shield reserve lenders** who want a MUSD-denominated pool whose only lending destination is debt
  reduction on registered positions.

### The problem

Four concrete failures of the current Mezo experience:

1. **Adjusting a trove needs MUSD up front.** Repaying debt, adding collateral or closing a position
   normally requires the stablecoin to already be in the wallet — usually bought elsewhere, at spread.
2. **The redemption queue is invisible.** `SortedTroves` is ordered data, but nothing in a wallet UI says
   how far up the queue a position sits or how much redemption volume it takes to reach it.
3. **"Healthy" is not safe.** A trove at 115% ICR is above the liquidation line and still first in line for a
   redemption sweep. Nothing warns the borrower.
4. **Rescue is reactive and manual.** By the time a borrower notices, the cheapest option is a bridge-and-sell
   loop that takes minutes and multiple transactions.

### Value proposition

| | Without Pylon | With Pylon |
|---|---|---|
| Loop into more BTC | Borrow MUSD → bridge → buy BTC → add collateral | One transaction, no up-front capital |
| Repay debt out of collateral | Sell BTC → bridge → repay | One transaction, **0 MUSD in the wallet** |
| Close a trove | Repay the debt from a wallet that must already hold it | One transaction, debt cleared from its own collateral |
| Redemption exposure | Not visible anywhere | Rank, buffer ahead, drawdown absorbed, and a shield |
| Agent execution | Owner key or nothing | x402-priced execution slot |

### Why now

- Mezo's redemption path is live and the testnet book shows exactly the failure mode Pylon targets: of the 244
  troves in `SortedTroves`, the eight cheapest-to-redeem sit between 111% and 125% ICR and will absorb a
  redemption before anyone above them does.
- Flash liquidity is already deep enough to fund real operations (the MUSD/mUSDC pool holds ~201k MUSD) and the
  MUSD/BTC pool is deep enough to swap against (~102.5M MUSD / 1,302 BTC).
- Mezo ships `BorrowerOperationsSignatures`, which makes atomic operations possible **without custody**: an
  owner signs an EIP-712 `AdjustTrove` or `CloseTrove`, and any executor may relay it.

### Key product insight

> The unit a Mezo borrower manages is not the collateralisation ratio. It is the **redemption buffer** — the
> MUSD that has to be redeemed before their collateral is touched — and the **drawdown** their trove absorbs
> before liquidation. Pylon prints both, per trove, live.

The second insight is a market-structure one that Pylon surfaced during development and now displays next to
every quote: **the Tigris MUSD/BTC pool can trade several percent away from Mezo's oracle** (on testnet,
~4.2% below it). A loop buys BTC at that discount, an unwind and exit sell into it. Any product that quotes
"the price" hides the dominant cost of the operation; Pylon prints the venue rate, the oracle, and the signed
deviation on the same line.

---

## 2. User experience

### Primary workflow

1. **Land on the terminal.** The first pixel is the working surface: the **Redemption Radar** (left, 62%) and
   the **Position Architect** (right, 38%). No hero, no pitch.
2. **Read the queue.** The radar is a depth chart of the live `SortedTroves` list, ordered from the 110% MCR
   tail to the safe head. Bar height is the BTC drawdown a trove can absorb before liquidation; colour is the
   risk band. Hovering walks the redemption: the shaded region from the tail to the cursor is exactly the MUSD
   that must be redeemed before that trove is touched. The instrument bar above prints BTC price, system ICR,
   queue depth, flash liquidity, pool depth, fees, trove count and chain head.
3. **Pick a trove.** Click a tick, or a row in the ledger below. The inspector opens with the trove's ICR
   against the MCR/CCR lines, its collateral, debt, interest, rank, buffer ahead — and one sentence that
   states what an unwind can actually do to it.
4. **Choose a mode.** `Loop · Unwind · Exit · Shield`. The control surface changes, the slider snaps to a fine
   integer grid, and the **Atomic Execution X-Ray** lists the exact legs the transaction will run with live
   numbers and the venue each leg trades on.
5. **Execute.** One primary button. A lifecycle strip reports prepare → sign → broadcast → confirm, with the
   explorer link and a retry on failure.

### Activation moment

Not a signup: the moment a borrower sees their own trove's bar sitting in the vermilion tail with
**"redemption reaches this trove after 0 MUSD"**, and understands — in the same screen where the fix lives —
that a flash unwind can move it without selling BTC.

### Important interactions

- **Hover the strip** → the redemption walk, quantified.
- **Click a trove** → it is loaded into the architect (radar and architect share one focus; no modals).
- **Drag the slider** → the quote re-sizes on an integer grid; guards appear before the button, never after.
- **Switch broadcast route** → `Engine relay` (the Pylon service broadcasts) or `Self-broadcast` (your wallet
  sends it). Both sign the same EIP-712 struct.
- **Paste any trove address** into the architect's target field to operate on a position the radar's visible
  tail does not show.
- **Request terms** on the x402 panel → decodes the HTTP 402 challenge and shows exactly what payment would be
  signed before anything is signed.

### Differentiation

- A queue-centric product, not a position dashboard: the home route is the protocol's own data structure,
  rendered.
- Numbers are never raw wei, never unlabelled, and always carry the venue they came from. The header states
  whether the terminal is reading the engine API or chain RPC directly.
- Every guard is explicit: below the 150% CCR, the loop blocks itself and computes the repayment that would
  unblock it; a slider ceiling that stops at Mezo's 1,800 MUSD debt floor says so and points at Flash Exit.
- Read-only mode is a first-class product, not a degraded one: with no backend and no wallet, the radar,
  market and reserve are reconstructed from chain reads.

---

## 3. Innovation

**What a user can now do that was previously difficult or impossible:**

1. **Repay debt with zero MUSD.** The flash venue supplies the MUSD, the trove's own collateral buys it back,
   and the surplus returns to the wallet — all inside one transaction. This inverts the usual capital
   requirement: no bridging, no stablecoin purchase, no price exposure while moving funds.
2. **See the redemption queue as a risk surface.** Pylon renders `SortedTroves` as a depth chart where the
   vertical axis is survivable drawdown and the horizontal axis is queue order, and quantifies the walk.
3. **Buy an execution over HTTP 402.** The `x402` endpoint prices one unwind in MUSD; the payer signs an
   EIP-3009 `TransferWithAuthorization`, the facilitator redeems it, and the terminal shows both the settlement
   receipt and the resulting Mezo transaction.
4. **Fund a defence instead of a sale.** The shield reserve lends MUSD that can only ever reduce a registered
   position's own debt, and a defence call is permissionless, so anyone (a keeper, a DAO, an insurance
   provider) can push a position back above its trigger.

**Why it is not a thin wrapper:** the engine's own contracts supply the atomicity (`loopSigned`, `unwindSigned`,
`closeSigned`, flash callbacks, fee accounting), the reserve supplies the defence capital, and the terminal
supplies the risk model — the legacy derive from the queue ordering, the size ceilings from the CCR floor,
flash liquidity and swap-pool depth, and the venue-rate disclosure. A wrapper could not answer "how much
redemption volume reaches me?" or "what is the largest loop this trove can survive?".

---

## 4. Hackathon relevance

- **Track:** Mezo — bitcoin-backed lending, MUSD, and the native Tigris DEX.
- **Sponsor technology used meaningfully:**
  - **Mezo CDP:** `TroveManager` (ICR/TCR, MCR/CCR), `SortedTroves` (the redemption queue), `BorrowerOperations`
    and **`BorrowerOperationsSignatures`** (EIP-712 trove authorisation), the native BTC price precompile.
  - **MUSD:** the asset that is borrowed, flashed, repaid, shielded and payable.
  - **Tigris:** the MUSD/mUSDC pool as flash venue, the MUSD/BTC pool as swap venue, and the router/factory
    fee surface.
- **Judging criteria this is built against:** technical depth (real atomic multi-leg execution, exact integer
  maths), product insight (redemption as the borrower's real risk), originality (queue-as-interface, shield
  reserve, x402 execution slots), and demonstrable proof (an explorer-linked ledger and live testnet reads).

---

## 5. Architecture

```text
┌──────────────────────────── browser (static bundle) ─────────────────────────────┐
│                                                                                  │
│  Redemption Radar        Position Architect        Reserve / x402 / Proof panels  │
│  ├ SortedTroves walk     ├ Loop · Unwind · Exit     ├ shield pool + shares        │
│  ├ ICR bands + drawdown  ├ EIP-712 signing          ├ HTTP 402 exact scheme       │
│  └ buffer ahead          ├ self-broadcast calldata  └ explorer-linked ledger      │
│                          └ Atomic Execution X-Ray                                │
│                                                                                  │
│  lib/api.ts  ── typed engine API client        lib/rpc.ts ── viem chain reads    │
│  lib/format.ts ── 18-decimal → human module    lib/execution.ts ── EIP-712 + ABI  │
└───────────┬──────────────────────────────────────────────────┬───────────────────┘
            │ HTTPS (optional)                                 │ JSON-RPC (fallback)
            ▼                                                  ▼
┌──────────────────────────┐                        ┌──────────────────────────────┐
│ Pylon engine service     │                        │ Mezo Testnet RPC (31611)      │
│ Rust · /api/v1/*         │                        │ price precompile, TroveManager│
│ quotes, builds, ledger   │                        │ SortedTroves, pools, MUSD     │
└───────────┬──────────────┘                        └──────────────────────────────┘
            │ relayer                                    
            ▼
┌────────────────────────── Mezo Testnet ──────────────────────────────────────────┐
│ PylonFlashEngine ←→ PylonReserve ←→ PylonPosition (EIP-1167 clones)              │
│        ↕ flash hook                ↕ funds defence repayment                     │
│ Tigris MUSD/mUSDC pool     Tigris MUSD/BTC pool     Mezo TroveManager/SortedTroves│
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Major components

| Layer | Responsibility |
|---|---|
| `src/app/*` | Four static routes: `/` terminal, `/reserve`, `/proofs`, `/docs`. |
| `src/components/radar/*` | Queue reconstruction, depth chart, ledger, inspector, queue maths (`scale.ts`). |
| `src/components/architect/*` | Mode controls, mechanical slider, execution bounds (`limits.ts`), X-Ray, action bar. |
| `src/components/panels/*` | Shield reserve, x402 pay-to-deleverage, proof ledger. |
| `src/lib/api.ts` | Typed client for the engine API; distinguishes *unreachable* (fall back) from *rejected* (surface). |
| `src/lib/rpc.ts` | Chain reads: market, queue walk, trove, reserve, position, wallet, and the engine's own `preview*` quote functions. |
| `src/lib/execution.ts` | EIP-712 structs mirroring `BorrowerOperationsSignatures`, calldata encoding, hint/nonce reads, target allowlist. |
| `src/lib/x402.ts` | x402 v1/v2 challenge parsing, EIP-3009 authorisation, settlement receipt decoding. |
| `src/lib/format.ts` | The only place integers become text: adaptive precision, tabular figures, no raw wei. |

### Data flow

1. **Reads** prefer the engine API (`/api/v1/config|market|radar|trove|reserve|proofs`) and fall back to RPC
   when it is unreachable. Both paths are tagged at the point of use (`engine` / `rpc`) and the tag is visible
   in the header and in each panel's meta row.
2. **Queue reconstruction** walks `SortedTroves.getPrev` from the tail, chunked with multicall3 and streamed
   into the chart as it goes, with explicit coverage (`80 of 244 troves`).
3. **Quotes** come from the engine API or, when it is down, from the engine's own view functions
   (`previewLoopDebtForCollateral`, `previewUnwindMusdNeeded`, `previewUnwindBtcIn`, `previewClose`,
   `previewBtcOut/MusdIn`) — the same integer maths that runs inside the transaction.
4. **Writes** are always one atomic operation: build → EIP-712 signature → broadcast (engine relay or wallet) →
   receipt → confirmation. Every destination is checked against the deployed Pylon/Mezo address set first.

### Important technical decisions

- **Static export, no server.** `output: 'export'` keeps deployment to a bucket and removes any server-side
  trust surface; the terminal is a pure client of the API and the chain.
- **No wallet SDK beyond wagmi's injected connector.** No hosted wallet vendor, no analytics, no remote fonts
  (fonts are self-hosted variable woff2).
- **Numbers as integers only.** Wei/wad strings travel through the app; `lib/format.ts` is the single boundary
  where they become text, with product-defined precision rules.
- **Read-only RPC mode via multicall3** with a bounded queue walk, so the product works with no backend and no
  wallet.
- **Two broadcast routes, one authorisation:** the engine service can relay, but it can only relay what the
  owner's signature already authorises.

### External services

| Service | Role | Failure behaviour |
|---|---|---|
| Pylon engine API | Quotes, builds, ledger | Falls back to RPC reads + on-chain preview quotes; execution falls back to self-broadcast |
| Mezo Testnet RPC | All chain state | A panel shows an error state with retry; the queue walk reports coverage |
| Mezo price precompile | BTC price | Blocks price-dependent quotes with a stated error rather than guessing |

---

## 6. Running

### Prerequisites

- Node ≥ 20.9 and pnpm 9+
- Optional: the Pylon engine service (Rust) for live quotes, builds and the pylon-relayed broadcast route

### Install, develop, build

```bash
cd web
pnpm install
pnpm dev        # http://localhost:3000
pnpm typecheck  # strict TS: no implicit any, no unchecked index access, no unused locals
pnpm build      # static export → ./out
pnpm preview    # serve the exported bundle on :4173
```

### Environment

```bash
cp .env.example .env.local
# NEXT_PUBLIC_API_BASE=http://localhost:8787   # engine service (optional)
# NEXT_PUBLIC_MEZO_RPC=https://rpc.test.mezo.org
```

Both are optional: with no `.env.local`, the terminal runs read-only against the public Mezo RPC and says so in
the header (`RPC READ-ONLY`).

---

## 7. Demo

**Deployed application:** static bundle (`web/out`) — serve it with `pnpm preview` or any static host, with
`NEXT_PUBLIC_API_BASE` pointing at a running engine service.

**What to try first (no wallet, no backend needed):**

1. Open `/`. Everything on screen is live Mezo Testnet state read over RPC.
2. Hover the radar strip from left to right: *"Redemption reaches this trove after N MUSD"* walks the queue.
3. Click the first tick (rank 1, ~111% ICR). Read the inspector's closing sentence: how much debt this trove's
   own collateral can repay, the ICR that leaves behind, and the pool's rate versus the oracle.
4. Click **Flash Unwind**: the slider ceiling, the guards and the X-Ray legs (withdraw → swap → repay → return)
   all populate from a live quote. Nothing is signed.
5. Click **Flash Loop** on a tail trove: it blocks itself below 150% CCR and states the repayment that would
   unblock it. Then paste a high-ICR trove address (e.g. the `SortedTroves` head) into the target field and
   watch the loop size, size ceiling and post-loop ICR populate.
6. Open `/reserve` for the shield pool (assets, share price, utilisation, caps, loans), `/proofs` for the
   explorer-linked ledger and the deployment manifest, and `/docs` for the two diagrams that explain the
   redemption sweep and the atomic unwind.

**With a wallet on Mezo Testnet:** connect, pick a mode, execute. Route `Self-broadcast` needs no backend at
all; `Engine relay` needs the engine service to publish the `build/*` + `execute/*` pair (see assumption 1).

**Paid endpoint (agent flow):** with the engine service running, open the x402 panel, paste a trove address,
request terms, then settle: the terminal sends a MUSD transfer from your wallet and retries with
`X-PAYMENT-TX`, and the returned report is rendered next to the settlement transaction on the explorer.

---

## 8. Verification: real, live, assumed

### Live and externally verifiable

- **Every figure on the radar, market strip, reserve, docs and inspector** is read from Mezo Testnet chain 31611
  (price precompile, `TroveManager`, `SortedTroves`, Tigris pools, `PylonFlashEngine`, `PylonReserve`) or from
  the engine API when it is running. There is no mock data path in the app.
- **The proof ledger** lists real transactions from the repository's broadcast log, each linking to the Mezo
  explorer; two of them carry the block number observed from a live receipt.
- **Deployed contracts** (all on 31611, listed in `/proofs`):

  | Contract | Address |
  |---|---|
  | PylonFlashEngine **v2** | `0x02d479B9F53ACd69c1965dBcFfaff90959E69E05` |
  | PylonReserve | `0xcc9dD7197237bbb645978D9A92872C7F82B6b881` |
  | PylonPosition (impl v2) | `0x910bC94609F5bD202f61DE119D7F707bDC63aD50` |
  | MUSD | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` |
  | BTC | `0x7b7C000000000000000000000000000000000000` |
  | SortedTroves | `0x722E4D24FD6Ff8b0AC679450F3D91294607268fA` |
  | TroveManager | `0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0` |
  | BorrowerOperationsSignatures | `0xD757e3646AF370b15f32EB557F0F8380Df7D639e` |
  | Tigris MUSD/mUSDC (flash) | `0x525F049A4494dA0a6c87E3C4df55f9929765Dc3e` |
  | Tigris MUSD/BTC (swap) | `0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9` |

- **The quotes are exact.** When the engine API is unavailable the terminal calls the engine's own `preview*`
  view functions, so a fallback quote is the same integer computation the transaction will perform.
- **The deployment manifest is a snapshot, and the terminal treats it that way.** Engine v1
  (`0x0bafCB…9CF9`) was superseded because it parked repayment MUSD at `BorrowerOperationsSignatures`; v2 is
  the address used here. The terminal prefers `GET /api/v1/config` for every address, falls back to the
  bundled snapshot, and (in RPC mode) refuses to run if no bytecode exists at the engine address — a stale
  manifest fails loudly instead of pointing a transaction at a dead contract.
- **Signature construction** mirrors `contracts/script/Prove.s.sol`: domain `BorrowerOperationsSignatures` v1,
  `AdjustTrove(collWithdrawal, debtChange, isDebtIncrease, assetAmount, borrower, recipient, nonce, deadline)`
  and `CloseTrove(borrower, recipient, nonce, deadline)`, with the nonce read live from
  `BorrowerOperationsSignatures.getNonce` and hints computed via `HintHelpers.getApproxHint` +
  `SortedTroves.findInsertPosition`.

### Implemented and exercised in this build

- Queue walk with streaming coverage, ICR bands, drawdown axis, redemption-walk shading, wallet-trove highlight.
- Trove inspector with a floor-capped, venue-aware unwind claim.
- Loop / unwind / exit modes: size ceilings, guards, X-Ray legs, broadcast-route switching, execution lifecycle.
- Shield mode: position discovery (including creation and opening the position's own trove), policy
  configuration, manual defence, reserve-loan repayment.
- Reserve deposit/redeem (approve → deposit, shares → assets), x402 terms + settlement (on-chain transfer or
  EIP-3009) + report rendering, proof ledger.
- Verified by hand against chain: BTC price, TCR, trove count, pool reserves, fee parameters, a tail trove's
  collateral/debt/ICR, `previewUnwindMusdNeeded` / `previewUnwindBtcIn` for a real repayment size, and the
  derived venue-vs-oracle deviation.

### Assumed (documented, not hidden)

1. **Build / execute endpoints are assumed, and currently unused.** The brief specifies
   `POST /api/v1/build/loop` → `{ typedData, tx, hints, quote }` and `POST /api/v1/execute/loop`. The engine
   service in this repository currently exposes the read surface (`config`, `market`, `radar`, `trove`,
   `position`, `reserve`, `quote/*`, `hints`, `proofs`, x402) but not `build/*` or `execute/*`, so the
   engine-relay route is wired and degrades to a stated error with a one-click switch to **Self-broadcast**,
   which is fully implemented: the terminal reads the nonce, computes `SortedTroves` hints and encodes
   `loopSigned` / `unwindSigned` / `closeSigned` itself. The same assumption covers the unwind/exit analogues.
2. **x402 endpoint.** The paid resource is the engine service's trove report —
   `GET {API_BASE}/api/v1/x402/trove-report/:address` — which returns a v1 x402 challenge (`x402Version`,
   `accepts[]`) plus the base64 `PAYMENT-REQUIRED` header. The terminal settles it two ways: it sends a real
   MUSD transfer from the wallet and retries with `X-PAYMENT-TX: <hash>` (verified on chain by the service),
   or it signs an EIP-3009 `TransferWithAuthorization` for the facilitator and retries with
   `PAYMENT-SIGNATURE`. The on-chain transfer route works on any deployment; the signature route needs a
   facilitator configured.
3. **`txWithSignatureTemplate`.** For engine-built calldata the terminal looks for a
   `txWithSignatureTemplate.data` string containing a `{signature}` placeholder, substitutes the 65-byte
   signature, and refuses to send unless the destination is a deployed Pylon/Mezo contract. When the template is
   absent, the wallet route builds the calldata locally instead.
4. **Mezo debt floor.** The 1,800 MUSD minimum net debt is treated as binding on the *ceiling* the terminal is
   willing to propose for a partial unwind (it stops there and points at Flash Exit). Whether Mezo would also
   reject a lower partial repayment is not asserted.
5. **Reserve picture when the engine API is down.** `/api/v1/reserve` loans are the only reserve data with no
   direct chain equivalent (they are per-position mappings), so in RPC mode the loans table shows an empty state
   instead of guessing.

---

## 9. Security and reliability

### Trust model

- **Non-custodial by construction.** Pylon never holds collateral or MUSD between transactions and never takes
  an allowance. The reserve can only send MUSD to a registered position, and the position can only spend it on
  its own trove debt.
- **Signature-bound authorisation.** Trove changes require an EIP-712 signature bound to owner, recipient, nonce
  and deadline, verified by Mezo's own `BorrowerOperationsSignatures`. A relayed transaction cannot differ from
  what was signed.
- **Atomic or nothing.** Flash liquidity and health checks happen inside the transaction; a failing leg reverts
  the whole operation, so there is no half-unwound state.

### Guards implemented in the terminal

- Minimum post-operation ICR on every signed operation (`minPostICR`, derived from the target with tolerance).
- Loop refuses to size beyond the 150% CCR line, flash venue liquidity, or 5% of the swap pool's BTC side, and
  names which ceiling binds.
- Unwind ceiling stops at what the collateral can fund (including the engine's withdrawal headroom) and at
  Mezo's minimum debt, and blocks below the 110% MCR.
- Exit blocks when collateral cannot fund the debt buy-back at the current price, and states the numbers.
- Venue-versus-oracle deviation is disclosed and warned about at ≥1.5%.
- Wallet transactions are refused for any destination outside the deployed Pylon/Mezo address set.
- Signatures are never replayed automatically; a stale challenge or signature means a fresh request.

### Failure handling

| Failure | Behaviour |
|---|---|
| Engine API offline | Header shows `RPC READ-ONLY`; reads fall back to chain; quotes fall back to engine previews; execution falls back to self-broadcast |
| RPC unreachable | Panel-level error state with a retry; the terminal never spins indefinitely |
| Queue walk incomplete | Coverage is printed (`80 of 244 troves`) and the walk can be extended |
| Quote reverts at this size | Stated in the panel with the reason and a suggested reduction; the action stays disabled |
| Wallet rejects signature | Lifecycle strip reports "Signature rejected in the wallet" |
| Transaction reverts | Lifecycle strip reports the revert with the explorer link to the failed transaction |
| Payment rejected (x402) | Settlement error surfaced; no retry with a stale signature |

### Known risks

- **Data provenance.** Reads come from the public Mezo RPC and the engine service. If both lied, the numbers
  would be wrong; the explorer-linked ledger exists so any row can be independently checked.
- **Venue price risk.** Operations trade against a pool that can sit several percent from the oracle. The
  terminal discloses this, but it is real economic cost.
- **Reserve credit risk.** Defence loans are only repaid when positions repay them. A defence followed by a
  deeper drawdown can impair the loan and therefore the share price. Lenders are exposed to the troves they
  defend.
- **Self-broadcast hints.** Locally computed `SortedTroves` hints are correct at build time; a competing
  transaction in the same block can invalidate them, which is why the engine-relay route recomputes hints at
  execution time and is the default when available.
- **Testnet only.** Amounts are testnet MUSD and BTC; nothing here should be pointed at mainnet without an
  independent review of the engine contracts.

---

## 10. Limitations and roadmap

### Current limitations

- **Native-trove shielding needs a Pylon position.** The shield attaches to a position that owns its trove, so
  shielding an existing native trove requires operating it through a position; the terminal offers to create
  one and open its trove, and documents the migration rather than pretending it is one click.
- **Queue coverage in RPC mode** is bounded (default 80 of 244 troves) because `SortedTroves` is a linked list
  and each hop needs the previous address. Coverage is always printed.
- **Unwind uses an approximate collateral ceiling** at quote time; the engine's previews pin the exact swap
  leg, and the surplus is swept back to the owner.
- **One position at a time.** The architect operates on a single trove; there is no portfolio view yet.
- **The x402 panel needs a facilitator.** Without the engine service the paid flow can only be probed, not paid.

### Roadmap

1. **Multi-trove portfolio** with combined health, redemption exposure and batch unwinds.
2. **Scheduled shields** — a keeper that defends without a manual call, funded from the reserve's fee stream.
3. **Cross-trove rebalancing** that repays the cheapest-to-redeem position first, sized against the whole book.
4. **Strategy previews over a BTC price path** — "if BTC drops 20%, where do I sit in the queue?" using the same
   queue model the radar already builds.
5. **x402 metered defence** — pay-per-defence subscriptions for agent-run positions, where the payment itself
   capitalises the reserve.

---

## 11. Design notes

The interface is deliberately a **Swiss monetary instrument**, not a web3 app:

- **Planes, not cards.** Hairline-ruled surfaces (`#1F232B`) form the layout; the only depth cue is a 1px inset
  highlight on controls. No shadows, blur, glass or gradient decoration.
- **Typographic discipline.** Space Grotesk for structure, Inter for prose, JetBrains Mono with tabular figures
  for every number, address and hash — so columns align exactly in dense ledgers.
- **Etched labels.** Structural text is 10px uppercase mono with 0.16em tracking, the way a machined panel is
  annotated.
- **Semantic colour only.** Bitcoin amber for BTC, collateral and the primary action; Mezo vermilion reserved
  exclusively for redemption-tail danger; emerald only for verified/proof and safe health. Risk bands are the
  only other place colour appears.
- **Motion with meaning.** Numbers animate on change (200ms ease-out) and the connected trove pulses; there is
  nothing else, and both are disabled under `prefers-reduced-motion`.
- **Identity.** The mark is two interlocking angular steel pylons around a vertical bitcoin-amber axis, shipped
  as favicon, app icon and wordmark, legible at 16px on light and dark browser chrome.

---

## 12. Repository layout (web/)

```text
web/
├── public/                     favicon.svg · icon.svg · apple-icon.svg
├── src/
│   ├── app/
│   │   ├── globals.css         design system: tokens, plates, ledgers, controls, motion
│   │   ├── layout.tsx          self-hosted fonts, metadata, header/footer shell
│   │   ├── page.tsx            terminal: radar (62%) + architect (38%) + capital panels
│   │   ├── reserve/page.tsx    shield pool + mechanics + risk statement
│   │   ├── proofs/page.tsx     ledger, verification guide, deployment manifest
│   │   ├── docs/page.tsx       product documentation + two explanatory diagrams
│   │   └── not-found.tsx
│   ├── components/
│   │   ├── architect/          modes, mechanical slider, limits, X-Ray, action bar
│   │   ├── panels/             reserve, x402, proof ledger
│   │   ├── radar/              depth chart, ledger, inspector, queue maths
│   │   ├── shell/              header, wordmark, connect, instrument bar, footer
│   │   └── ui/                 panel, spec rows, sliders, meters, states, address chips
│   ├── fonts/                  self-hosted variable woff2 (Space Grotesk, Inter, JetBrains Mono)
│   ├── hooks/                  hydration, reduced motion, animated values, copy, clock
│   ├── lib/
│   │   ├── abi.ts              the exact contract surface the terminal touches
│   │   ├── api.ts              typed engine API client
│   │   ├── chain.ts            Mezo Testnet definition, deployed addresses, explorer links
│   │   ├── execution.ts        EIP-712 structs, calldata, nonce/hints, target allowlist
│   │   ├── format.ts           the only integer → text boundary
│   │   ├── rpc.ts              chain reads, queue walk, on-chain quote previews
│   │   ├── static-ledger.ts    frozen deployment ledger (fallback proofs)
│   │   ├── types.ts            domain model
│   │   └── x402.ts             HTTP 402 / EIP-3009 client
│   └── state/                  wagmi config, providers, queries, execution, actions, focus context
├── next.config.ts              output: 'export', unoptimized images
└── package.json
```
