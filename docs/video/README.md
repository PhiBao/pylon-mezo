# Pylon — product demo (1:57)

`pylon-demo.mp4` — 1920×1080, 30 fps, narrated, subtitles burned in plus a sidecar `pylon-demo.srt`
for uploads. Recorded against the **live** terminal (`pylon-mezo.vercel.app`) with the hosted engine
(`pylon-mezo-api.fly.dev`) connected, so every figure is a real Mezo Testnet read at record time.

## What it shows

| # | Beat | On screen |
|---|------|-----------|
| 1 | Hook | title card — leverage, deleverage or defend a Mezo loan, one transaction each |
| 2 | The queue | live redemption radar: 296 troves, 429.1M MUSD of redemption depth, hover walks the queue, tail rows with ICR and buffer-ahead |
| 3 | Any trove | the live shielded position pasted into the architect: 0.0457 BTC, 2,051 MUSD debt, 181.7% ICR, “active trove”, one EIP-712 signature |
| 4 | Flash loop | 0.004 BTC sized against the 150% CCR line, then the atomic x-ray: 315.57 MUSD flashed, 0.0040 BTC out, +315.89 MUSD debt incl. the Mezo fee, 315.60 repaid, post-loop ICR 171.2% |
| 5 | The shield | reserve page: 1,107 MUSD of assets, 29.98% utilisation, the 332.17 MUSD loan against the armed position, and the claim that blocks collateral release |
| 6 | Proof | 14 explorer-linked ledger rows with kind badges, including the autonomous keeper defence (ICR 172.00% → 181.00%), then the mainnet manifest on chain 31612 |
| 7 | Close | thesis, links, 43 tests, 12-lens review |

## Execution clip (48 s)

`pylon-execution.mp4` — the demo-signer path end to end, recorded in one take against the live
terminal: the key pasted into the header (masked), the architect targeting that account, the live
position at 0.0457 BTC / 2,051.35 MUSD, a 0.0005 BTC loop priced in the x-ray, Execute, and the
confirmed receipt.

The transaction is real: **`0xe198fb3b11160c2fd489c636da87e247d2d2c760d120c20fd54491a3c0b90861`**
([explorer](https://explorer.test.mezo.org/tx/0xe198fb3b11160c2fd489c636da87e247d2d2c760d120c20fd54491a3c0b90861)).
It moved the position to **0.046202 BTC / 2,090.85 MUSD / 180.4% ICR**; the reserve earned its
0.20% fee (fees 2.62 → 2.70 MUSD, share price 1.002370 → 1.002442). The deck and README carry the
post-execution figures; the 1:57 pitch video was recorded before it, so its narration still says
0.0457 BTC / 2,051 MUSD — the live drift is the execution itself.

The key never appears in the clip: the field is a password input, and the key was read from the
operator's env file at record time, never written to the story file or the repo.

The recording also exposed a real product bug: the Engine Relay route asked the server for
`/api/v1/build/*`, which did not exist, so the relay could never execute. That is fixed — positions
are driven directly by the engine (their owner authorises it) and native troves still take the
borrower's ballot.

## How it was produced

The video was rendered with the `demo-video-template` pipeline — Playwright records real HTML pages,
`edge-tts` narrates, `ffmpeg` assembles, trims, burns subtitles and normalises to −16 LUFS. The
project source is committed next to this file:

```
source/story.json   narration + scene actions (page selectors, typing, scrolls, hovers)
source/video.json   branding, theme, voice, subtitle style
```

To re-render (from `~/demo-video-template`):

```bash
./scripts/new.sh pylon
cp <repo>/docs/video/source/story.json videos/pylon/script/story.json
cp <repo>/docs/video/source/video.json videos/pylon/config/video.json
./scripts/run.sh --project pylon
```

The two card templates are the shared `title-left` / `close-left` templates with Pylon's fonts
(Space Grotesk, Inter, JetBrains Mono) embedded and the theme set in `source/video.json`.

## Honest notes

* The ledger mixes generations by design: the terminal shows what the engine recorded, and the
  deployment's earlier generation is part of that record. The row the video highlights — the
  autonomous keeper defence — is on the **audited** generation, as are the reserve rows.
* Live numbers drift with the Mezo oracle. The ICR reads 181.5–181.8% across the scenes; the
  narration says 181.7%, the value recorded in the deployment file.
* `qa/report.txt` from the render carries one warning: scene 5's clip is 0.7 s shorter than the
  template's conservative `trim + narration + 1 s` check. The build freeze-pads the tail, and the
  render has no black frames or audio gaps; the warning is a measurement artefact of the 5.5 s page
  lead-in, not a missing beat.
