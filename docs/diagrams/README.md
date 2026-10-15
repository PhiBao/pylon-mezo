# Pylon — architecture diagrams

Hand-authored SVG figures for the Mezo Buildathon submission. Each file is standalone: no scripts, no raster
images, no external fonts or network requests. Every label is real `<text>`, so the diagrams stay crisp at any zoom,
remain searchable, and can be diffed in review.

| File | Size | The question it answers |
|---|---|---|
| [`01-atomic-paths.svg`](01-atomic-paths.svg) | 1200 × 800 | *How do Loop, Unwind and Exit happen in one transaction — and what can Pylon actually move?* |
| [`02-redemption-queue.svg`](02-redemption-queue.svg) | 1200 × 520 | *Why is a healthy (135–148% ICR) trove still at risk, and how does the shield change that?* |
| [`03-system-map.svg`](03-system-map.svg) | 1200 × 820 | *What is real on Mezo today, what did Pylon add, and where are the trust boundaries?* |

---

## 1. `01-atomic-paths.svg` — three atomic paths

**What it shows.** One machine (user wallet → Pylon engine → Tigris flash venue → Tigris swap venue → Mezo core →
your native trove), and three routes through it. Each route lives inside a hairline container tagged
`ONE TX · ONE SIGNATURE`: everything in that box happens inside one transaction or the whole thing reverts.

- **Path 1 · Flash Loop** — the user signs `AdjustTrove(collWithdrawal = 0, debtChange = +D, isDebtIncrease = true,
  assetAmount = X)`. The engine borrows `D` MUSD from the flash venue, buys `X` BTC with `D − fees` on the MUSD/BTC
  pool, deposits that BTC through `BorrowerOperationsSignatures`, the minted `D` MUSD returns to the engine, the flash
  is repaid, the 0.20% Pylon fee goes to the reserve, the surplus goes back to the wallet.
- **Path 2 · Flash Unwind** — the user signs `AdjustTrove(collWithdrawal = X, debtChange = −P,
  isDebtIncrease = false, assetAmount = 0)`. The engine flashes `P` MUSD, parks it in the signatures helper (which
  burns it from its own address), the trove's debt falls by `P` and `X` BTC is released, a slice of that BTC is sold
  to repay `P + fees`, the rest returns as BTC. **Requires zero MUSD in the wallet.**
- **Path 3 · Flash Exit** — the engine reads the exact debt after `updateSystemAndTroveInterest`, flashes
  `debt − 200 MUSD`, closes the trove with `closeTroveWithSignature`, sells collateral to repay the flash and returns
  the remainder as BTC.

**The property the diagram is really about.** The EIP-712 signature is the slippage guard: the engine cannot move
more collateral or more debt than the user authorised, and if the swap cannot deliver the signed collateral the
transaction reverts. That is stated in the gradient callout at the bottom.

**Reading the marks.** Amber = a BTC leg, cool grey = a MUSD leg, upward "taps" = value paid back into a venue
(flash repayment, the Pylon fee, the collateral sold to repay the flash), numbered chips = step order, the tall right
panel = the one native trove every path writes to (with the resulting collateral, debt and ICR per path).

## 2. `02-redemption-queue.svg` — the redemption queue

**What it shows.** `SortedTroves` as a horizontal ladder from the 110% MCR tail (vermilion) to the safe head, with
one hairline per trove. MUSD redemptions walk up from the lowest ICR above 110%: everything in front of a borrower is
that borrower's MUSD buffer. A marked trove at 135% ICR is safe from liquidation and still exposed — its buffer is
the total debt of every trove closer to the tail than it is. The emerald route shows `defend()`: the reserve lends
MUSD, the position repays its own debt, and the trove moves back up the queue before a redemption arrives.

The three panels at the bottom contrast the two ways a trove loses collateral — **liquidation** (ICR < 110%, everyone
below the line at once, the price moved, you could see it coming) and **redemption** (the lowest ICR above 110%, one
trove at a time, debt repaid and BTC taken at the oracle price, no warning shot) — plus **the shield**, which is
permissionless and enforced on-chain.

**Data honesty.** `245 troves live` is chain state. The density silhouette is illustrative — it is drawn to show the
shape of a queue (thin tail, a cluster above 150%), not to claim a measured distribution. The marked borrower is an
example, not an account.

## 3. `03-system-map.svg` — Pylon system map

**What it shows.** Four columns read left to right:

1. **Wallets** — EVM wallet (signs EIP-712 intents), BTC wallet (funds and receives BTC), x402 agent (pays MUSD for
   on-chain truth). Keys never leave this column.
2. **Terminal (Next.js)** — atomic paths UI, position + queue view, signing surface (renders the EIP-712 payload,
   never holds a key).
3. **Service (Rust)** — indexer (walks `SortedTroves`, rank + MUSD buffer per trove), solver (exact flash amount, fee
   split, insert hints), keeper (calls `defend()` on the trigger ICR), x402 gateway (MUSD-priced telemetry).
4. **Mezo Testnet** — the live third-party contracts grouped as **Mezo core**, **Tigris**, and **Pylon** (the three
   contracts we deployed).

A dashed vermilion boundary separates off-chain from on-chain, carrying three numbered markers that are spelled out
underneath: **1 no key custody**, **2 reserve lending caps**, **3 collateral release locked while a shield loan is
outstanding**. The bottom lane is the x402 path: `GET /api/v1/x402/trove-report/:address` → `402 PAYMENT-REQUIRED`
with a MUSD price → the caller returns an `X-PAYMENT-TX` hash (or a facilitator `PAYMENT-SIGNATURE`) → the gateway
verifies the MUSD transfer on-chain and serves the trove report; the report (ICR, queue rank, MUSD buffer) comes back
on the dashed lane. The keeper's auto-defend loop lives in the service column, not in this lane.

---

## Visual system

All three diagrams use the active Pylon skin (dark engineering instrument), defined in one place per file:

| Role | Value | Used for |
|---|---|---|
| canvas | `#0A0B0D` | page ground |
| panel / raised | `#101216` / `#14171C` | containers, nodes, step chips |
| hairline | `#1F232B` (grid `#171A21`, structure `#2A3038`) | borders, queue ticks |
| text | `#E8EAED` primary · `#9AA1AC` secondary · `#6B7280` tertiary | labels |
| BTC amber | `#F7931A` | collateral legs, the contracts Pylon touches |
| MUSD grey | `#C2C9D4` | debt legs |
| Mezo vermilion | `#E11D48` | redemption tail, trust boundary |
| emerald | `#10B981` | verified / shield defence |

**Type.** Headings and UI labels: `Space Grotesk, Inter, system-ui, sans-serif`. Every number, address, hash and fee
figure: `JetBrains Mono, ui-monospace, monospace`. The fallback chains are explicit, so a machine without the two
display faces still renders a monospaced-aligned figure without clipping (the diagrams are laid out with the narrow
Space Grotesk metrics, so fallbacks only ever add air, never overlap).

**Shape language.** Containers (panels, lanes, transaction boundaries) are hairline rectangles. Pools and contracts
are dense text rows with right-aligned abbreviated addresses. Steps are numbered chips *sitting on* the flow line,
not boxes. Value movement is the line; the shape of the line is the information. No drop shadows, no icon wallpaper,
one gradient only (the amber → vermilion exactness bar in diagram 01, where the colour carries meaning).

Accessibility: every file carries `role="img"`, a prefixed `<title>`/`<desc>` pair, and no raster content.

---

## Regenerating the PNG previews

The repository ships the SVGs. Previews are generated artefacts — build them with any renderer that can resolve the
two font families (or let the fallbacks take over).

**resvg (Node, what these were checked with):**

```bash
# one-off helper
mkdir -p /tmp/pylon-render && cd /tmp/pylon-render
npm init -y >/dev/null && npm i @resvg/resvg-js
cat > render.mjs <<'EOF'
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
const [input, output] = process.argv.slice(2);
const resvg = new Resvg(readFileSync(input, 'utf8'), {
  fitTo: { mode: 'zoom', value: 2 },          // 2x for a retina-quality preview
  background: '#0A0B0D',
  font: { loadSystemFonts: true, defaultFontFamily: 'sans-serif' },
});
writeFileSync(output, resvg.render().asPng());
EOF

# then, from this directory:
cd /path/to/repo/docs/diagrams
for f in 01-atomic-paths 02-redemption-queue 03-system-map; do
  node /tmp/pylon-render/render.mjs "$f.svg" "/tmp/$f.png"
done
```

**cairosvg (Python):**

```bash
python3 -m pip install --user cairosvg
python3 -m cairosvg 01-atomic-paths.svg -o 01-atomic-paths.png --output-width 2400 --background '#0A0B0D'
```

**rsvg-convert (librsvg) or Inkscape:**

```bash
rsvg-convert -w 2400 -b '#0A0B0D' -o 03-system-map.png 03-system-map.svg
inkscape --export-type=png --export-width=2400 --export-background='#0A0B0D' 02-redemption-queue.svg
```

Fonts: install Space Grotesk and JetBrains Mono for a pixel-faithful preview. Without them, the explicit fallbacks
(Inter / system-ui / ui-monospace) keep every label inside its reserved box.

---

## Verifying a change

```bash
# 1. well-formed XML
for f in *.svg; do python3 -c "import xml.dom.minidom,sys;xml.dom.minidom.parse(sys.argv[1])" "$f"; done

# 2. render and look at it (any of the commands above)

# 3. check the geometry rules before shipping a layout change
python3 ~/.opencode/skills/diagram-design/scripts/self_check.py 03-system-map.svg
```

House rules these files are drawn to: orthogonal connectors only (quarter-arc elbows at `r=8`, never diagonals);
every arrow label sits on its own opaque mask with a 6–10px gap from the stroke; no connector runs behind a box that
is not its endpoint; a distinct fan-out port per connector on a shared edge (≥12px apart); one gradient; no shadows;
the legend is a bottom strip inside the frame, never floating in the drawing area.

---

## Verification status

| Claim in the diagrams | Status |
|---|---|
| Contract addresses, chain id, pool reserves, pool fees | live values read from Mezo Testnet (`contracts/deployments/31611.json`) |
| 245 live troves, SortedTroves ordering, 110% MCR | live chain state |
| Fee arithmetic in diagram 01 (`0.20%` Pylon origination fee) | matches `PylonFlashEngine.flashFeeBps` (max 100 bps) |
| Reserve caps (per call · per position · utilisation ceiling) | matches `PylonReserve.setLimits` / `utilizationCapBps` (90% initial, 95% ceiling) |
| Collateral lock while a shield loan is open | matches `PylonPosition.withdrawCollateral`, which reverts while a reserve loan is outstanding |
| `defend()` is permissionless | matches `PylonPosition.defend()` (no owner gate) |
| Trove density shape in diagram 02 | **illustrative** — the shape is drawn, not measured |
| The 135% borrower in diagram 02 | **an example**, not a specific account |
| `X`, `D`, `P` amounts in diagram 01 | symbolic — placeholders for the signed numbers |
| The Next.js terminal column in diagram 03 | the designed client surface; confirm the `web/` client is in place before publishing the figure as shipped |

---

## Limitations

- The diagrams are text-dense by design; they read best at 100% zoom on a laptop or printed at A3. Below ~900px wide
  the smallest labels (6.5px) stop being comfortable — scale the raster instead of reflowing.
- Diagram 02's queue is one-dimensional: it shows nominal collateral ratio ordering and ignores the per-trove weights
  that a full redemption walk also depends on.
- Diagram 03 collapses the x402 payment scheme, the light client, and the observability surface into single rows.
  They are intentionally out of scope here; the README carries the details.
