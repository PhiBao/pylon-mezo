# Pylon — demo videos

Two narrated cuts, both recorded against the **live** terminal:

| file | length | what it shows |
|---|---|---|
| `pylon-wave2.mp4` (+ `.srt`) | **1:44** | Wave 2: the hardened v6 generation, an outside user driving their own position, and a **real flash loop confirmed on camera** |
| `pylon-demo.mp4` (+ `.srt`) | 1:45 | Wave 1: the original terminal walkthrough and the first live relayed loop |

---

## Wave 2 — `pylon-wave2.mp4`

Recorded 6 Nov 2026 against `https://pylon-mezo.vercel.app` with the injected key of an **outside
user** (user1 from `docs/USERS.md`, position `0x1027ac4a…1833`) — nobody from the team.

```
loop 1 (on camera)  0xe51075996c33d1b39dc44ede50f74363e59d266323d8e5613a0d7d88520571d1
loop 2 (final take)  0x6302e779b2dfeb89f5bd12f8b20878e6bd6b295ce0e2358b8b7d24fd09fbcc77
```

### Beats

| # | Time | Beat | On screen |
|---|---|---|---|
| 1 | 0:00 | Hook | title card: borrow against Bitcoin without the queue taking your collateral unasked |
| 2 | 0:10 | The queue | live radar: 368 troves, 429.4M MUSD queued, tail / watch / buffered bands |
| 3 | 0:24 | The architect | four modes, one signature; hover walks Loop / Unwind / Exit / Shield |
| 4 | 0:34 | Outside user | user1's position pasted and read live: 0.0465 BTC, 2,320 MUSD debt, 150.7% ICR |
| 5 | 0:48 | Execute | 0.001 BTC sized, the x-ray prices every leg, Engine Relay, **confirmed** with the hash |
| 6 | 1:20 | Proof | `forge test`: 52 passed, 0 failed |
| 7 | 1:26 | Close | live links, "watch your place in line" |

### What the execution beat proves

The take runs the actual product: paste the position, pick a size, watch the x-ray (flash borrow →
swap → trove adjust → repay), click once, the injected wallet signs the Mezo ballot, the engine
relays it, and the receipt lands. On chain that loop moved the position from
`0.0465 BTC / 2,320.34 MUSD / 152.6%` to `0.0475 BTC / 2,399.24 MUSD / 150.9%` — both loops above
are in the engine's proof ledger and on the explorer.

Two things the recording exposed, both fixed in the same push:

- **Engine relay needed the owner's authorisation.** `PylonPosition.setExecutor` defaults to the
  zero address; the relay route only works after the position owner authorises the relay address.
  user1 signed that one-time authorisation (`setExecutor(0x3bEe06fA…)`) — it is revocable with
  `setExecutor(address(0))` and cannot move collateral.
- **Position-mode hints went stale between quote and execution.** The relay now passes empty
  SortedTroves hints so the position resolves them inside the execution block; precomputed hints
  reverted on a moving ICR.

### How it was produced

Same `open-video-demo` pipeline as Wave 1 (Playwright scenes, edge-tts narration, ffmpeg assembly,
word-timed subtitles, −16 LUFS). The story and branding are committed next to this file:

```
pylon-wave2-story.json    narration + scene actions (selectors, typing, waits)
pylon-wave2-config.json   branding, theme, voice, subtitle style
```

Record against the production URL with the injected wallet:

```bash
cd ~/open-video-demo
EVM_CHAIN_ID=31611 EVM_RPC_URL=https://pylon-mezo-api.fly.dev/api/v1/rpc \
EVM_PRIVATE_KEY=<user1 test key> WALLET_BROADCAST=1 \
./scripts/run.sh --project pylon-wave2
```

### Honest notes

- The on-camera loop is real and cost real testnet MUSD; the position now sits at **150.9% ICR**,
  just above the 150% CCR line. The UI flags exactly that ("leaves little room").
- The Wave 2 cut has **one execution** on camera. The confirmed frame is the last 10 s of the
  execution beat; the clip was trimmed there so the video does not sit on a frozen frame.
- The injected wallet is a throwaway test key that exists only on this machine
  (`~/.pylon-demo/users.json`, mode 0600). The video shows its address because a public testnet
  actor's address is public by definition.
- Test counts in the narration: **52 Foundry** (the suite at recording time).

---

## Wave 1 — `pylon-demo.mp4`

The original 1:45 cut. It contains a real relayed loop
(`0xe198fb3b11160c2fd489c636da87e247d2d2c760d120c20fd54491a3c0b90861`) recorded against the
previous (v5) generation, plus the shield reserve, the proof ledger and the mainnet bundle.

Beats: hook → live queue → connect → execute → shield reserve → proof ledger → networks → close.

Honest notes carried over: its close card and narration say **43 contract tests**, the count when
it was recorded; the suite is 52 today. The execution frames read the pre-execution state
(0.0457 BTC / 2,051.36 MUSD / 181.8%), because the loop landed after capture.
