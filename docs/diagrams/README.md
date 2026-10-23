# Pylon — architecture diagrams

Three figures for the submission, each answering one question. They ship as **PNG at 3200px wide**
(rendered at 2× from a 1600px canvas) because the previous hand-authored SVGs carried 6.5–9.5px text and
were unreadable when zoomed. Every label is drawn at 16–46px on the canvas, so it stays legible in a
browser, on a phone, and in a slide.

| File | Size | The question it answers |
| --- | --- | --- |
| [`01-atomic-paths.png`](01-atomic-paths.png) | 3200 × 2000 | *How do Loop, Unwind and Exit happen in one transaction — and what can Pylon actually move?* |
| [`02-redemption-queue.png`](02-redemption-queue.png) | 3200 × 1800 | *Why is a 135% trove still at risk, and what does the shield change?* |
| [`03-system-map.png`](03-system-map.png) | 3200 × 1800 | *What is whose: what Pylon adds, what Mezo owns, and where the trust boundary sits?* |

Sources live in [`src/`](src/): one self-contained HTML file per figure with an inline SVG, the
product's own tokens, and the product's own fonts (Space Grotesk, Inter, JetBrains Mono — loaded from
`web/src/fonts`, no network). Redraw, don't convert: the layout is deliberate, not generated.

## Regenerating

```bash
cd docs/diagrams
for d in 01-atomic-paths 02-redemption-queue 03-system-map; do
  chromium --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --force-device-scale-factor=2 --window-size=1600,900 \
    --screenshot=$d.png --default-background-color=00000000 \
    "file://$PWD/src/$d.html"
done
```

`01` is 1600 × 1000; the other two are 1600 × 900. Bump `--force-device-scale-factor` to 3 for print.

## What each figure says

**01 · Atomic paths.** A live trove on the left (0.045 BTC, 2,058 MUSD, 180% ICR); three single-
transaction paths on the right, each with the change it produces. The footer states the property the
figure exists for: the EIP-712 signature carries the exact collateral and debt deltas, and if a swap
cannot deliver them the whole transaction reverts. Amber means a BTC leg, grey a MUSD leg, green what the
user ends up with.

**02 · The redemption queue.** Troves ordered by collateral ratio, redemptions consuming from the low
end. The 135% band is marked; a dashed arrow shows a defence repaying debt and moving that trove out of
reach. The two cards carry the numbers that make the point: 429M MUSD of queue depth against ~294
troves, and a reserve that can only ever repay debt.

**03 · The system map.** The trust boundary (dashed) contains the user's wallet and the user's trove.
The engine executes inside one transaction and holds nothing between them. Both venues are named with
their real mainnet depth and fee, and the MUSD reserve sits beside Mezo core because that is the only
place its money can go.

## Design notes

* Palette and type come from the terminal (`web/src/app/globals.css`): canvas `#0a0b0d`, ink `#e8eaed`,
  amber `#f7931a`, emerald `#10b981`. The dark card is intentional — it reads correctly on GitHub's
  light and dark themes.
* Coral/amber appears on **one** element per figure (the focal path or the focal trove), not as a
  signalling system.
* Nodes, gaps and padding sit on a 4px grid; the type ramp is 15 (eyebrow) · 17 (body) · 23–24 (heading)
  · 46 (title) on the 1600px canvas.
* Every figure is under the diagram budget (≤9 nodes, ≤12 connectors). If a fourth idea is needed, it
  belongs in a new figure, not in a denser one.
