# Pylon — product demo (1:45)

`pylon-demo.mp4` — 1920×1080, 30 fps, narrated, subtitles burned in plus a sidecar
`pylon-demo.srt`. Recorded against the **live** terminal with the hosted engine connected, and it
contains a **real execution**: a 0.0005 BTC loop signed in the browser and relayed on Mezo Testnet.

```
tx 0xe198fb3b11160c2fd489c636da87e247d2d2c760d120c20fd54491a3c0b90861
```

## Beats

| # | Time | Beat | On screen |
|---|------|------|-----------|
| 1 | 0:00 | Hook | title card — leverage, deleverage or defend a loan, one transaction each |
| 2 | 0:12 | The queue | live redemption radar: ~300 troves, 429M MUSD of depth, hover walks the queue, tail rows with ICR and buffer-ahead |
| 3 | 0:30 | Connect | the wallet that owns the trove is connected and the position is read live |
| 4 | 0:36 | Execute | 0.0005 BTC sized, the x-ray prices flash / swap / debt delta, Execute → engine relay → **confirmed** with the hash |
| 5 | 0:50 | The shield | reserve page: 1,107 MUSD of assets, the 332.17 MUSD loan against the armed position, the claim that blocks collateral release |
| 6 | 1:04 | Proof | 14 explorer-linked ledger rows with kind badges, including the autonomous keeper defence (172.00% → 181.00%) |
| 7 | 1:20 | Networks | the header dropdown switches to **Mezo mainnet** (31612): RPC reads, mainnet contracts, the mainnet reserve |
| 8 | 1:31 | Close | thesis, links, tests, review, "executed live" |

## The execution

The relayed loop moved the live position to **0.046202 BTC / 2,090.85 MUSD / 180.4% ICR**, and the
reserve's fee took it to **2.70 MUSD** of fees and a **1.002442** share price.

Recording it also exposed a product bug worth naming: the Engine Relay route asked the server for
`/api/v1/build/*`, which did not exist, so the relay could never execute. It is fixed — Pylon
positions are driven directly by the engine (their owner authorises it through `canExecute`), while
native troves still take the borrower's EIP-712 ballot.

## How it was produced

Rendered with the `demo-video-template` pipeline (Playwright scenes, `edge-tts` narration, `ffmpeg`
assembly, word-timed subtitles, −16 LUFS). The source is committed next to this file:

```
source/story.json   narration + scene actions (page selectors, typing, scrolls, hovers)
source/video.json   branding, theme, voice, subtitle style
```

The execution beats (segments 3–4) are cut from one real Playwright take of that transaction. Their
frames are cropped to the working surface (the 52px header is out of shot) so the recording controls
used to drive the take never appear in the product story — the video says "connect the wallet",
because that is the product flow, and the connect step itself is not staged on camera.

## Honest notes

* The execution footage was captured **before** the loop landed, so its frames read 0.0457 BTC /
  2,051.36 MUSD / 181.8% — the state the signature was authorised against. The reserve, proof and
  mainnet scenes were recorded after it, so the reserve panel shows the post-execution fee (2.70
  MUSD).
* The engine's ledger does not include the relayed execution (the relay does not append proof rows);
  the transaction is explorer-verifiable at the hash above.
* Live numbers drift with the Mezo oracle; the ICR reads 180–181% across the cut.
