# Pylon — product demo (1:47)

`pylon-demo.mp4` — 1920×1080, 30 fps, narrated, subtitles burned in plus a sidecar
`pylon-demo.srt`. Recorded against the **live** terminal (`pylon-mezo.vercel.app`) with the hosted
engine (`pylon-mezo-api.fly.dev`) connected, and it contains a **real execution**: a 0.0005 BTC loop
signed in the tab by the demo signer and relayed on Mezo Testnet.

```
tx 0xe198fb3b11160c2fd489c636da87e247d2d2c760d120c20fd54491a3c0b90861
```

## Beats

| # | Time | Beat | On screen |
|---|------|------|-----------|
| 1 | 0:00 | Hook | title card — leverage, deleverage or defend a loan, one transaction each |
| 2 | 0:11 | The queue | live redemption radar: 298 troves, 429.1M MUSD of depth, hover walks the queue, tail rows with ICR and buffer-ahead |
| 3 | 0:29 | Demo key | no extension: the key is pasted (masked), the terminal becomes that account, the live position loads at 0.0457 BTC / 2,051.36 MUSD / 181.8% |
| 4 | 0:38 | Execute | 0.0005 BTC sized, the x-ray prices flash / swap / debt delta, Execute → engine relay → **confirmed** with the hash |
| 5 | 0:51 | The shield | reserve page: 1,107 MUSD of assets, the 332.17 MUSD loan against the armed position, the claim that blocks collateral release |
| 6 | 1:05 | Proof | 14 explorer-linked ledger rows with kind badges, including the autonomous keeper defence (172.00% → 181.00%) |
| 7 | 1:20 | Networks | the mainnet bundle at `/mainnet/`: chain 31612, RPC reads, real mainnet reserve (10 MUSD) |
| 8 | 1:31 | Close | thesis, links, tests, review, "executed live" |

## The execution

The relayed loop moved the live position to **0.046202 BTC / 2,090.85 MUSD / 180.4% ICR**, and the
reserve's fee took it to **2.70 MUSD** of fees and a **1.002442** share price. Those are the figures
in the deck and README.

Recording it also exposed a product bug worth naming: the Engine Relay route asked the server for
`/api/v1/build/*`, which did not exist, so the relay could never execute. It is fixed — Pylon
positions are driven directly by the engine (their owner authorises it through `canExecute`), while
native troves still take the borrower's EIP-712 ballot.

## How it was produced

The video is rendered with the `demo-video-template` pipeline (Playwright scenes, `edge-tts`
narration, `ffmpeg` assembly, word-timed subtitles, −16 LUFS). The source is committed next to this
file:

```
source/story.json   narration + scene actions (page selectors, typing, scrolls, hovers)
source/video.json   branding, theme, voice, subtitle style
```

One scene is not live-recorded: the execution beats (key entry → trove → x-ray → execute → receipt)
come from a single real Playwright take of that transaction, injected as the clip for segments 3–4
so the cut shows the actual signature, relay and confirmation rather than a reconstruction. The key
was read from the operator's env file at record time and never written to the story file, the repo,
or the frame — the field is a password input.

To re-render from `~/demo-video-template`:

```bash
./scripts/new.sh pylon
cp <repo>/docs/video/source/story.json videos/pylon/script/story.json
cp <repo>/docs/video/source/video.json videos/pylon/config/video.json
./scripts/run.sh --project pylon
```

## Honest notes

* The execution footage was captured **before** the loop landed, so its frames read 0.0457 BTC /
  2,051.36 MUSD / 181.8% — that is the state the signature was authorised against. The reserve and
  proof scenes were recorded after it, so the reserve panel shows the post-execution fee (2.70 MUSD).
* The engine's ledger does not include the relayed execution (the relay does not append proof rows);
  the transaction is explorer-verifiable at the hash above, and the ledger shows the operator-run
  history it was designed to record.
* Live numbers drift with the Mezo oracle; the ICR reads 180–181% across the cut.
