# Outside users on the hardened generation

Five wallets, funded from the Mezo testnet faucet (0.05 BTC each), each running the full Pylon flow on
the **v6 engine** (`0xa1780be8f3c6e07714F51e5063839D6a6c61EE0b`) — no shared operator key, no
privileged path. Each wallet: creates a position (clone of the v6 template), opens a trove with
0.045 BTC / 2,000 MUSD, arms the Redemption Shield (170% trigger → 185% target), and runs one flash
loop of 0.0005 BTC.

| Wallet | Address | Position | Create | Open | Loop | Shield |
|---|---|---|---|---|---|---|
| user1 | `0x59CeF3BAd46a24B330D957df41197f81e4d18A6B` | `0x1027ac4af1b08a975a6101f5bb2b07b8f4c71833` | [create](https://explorer.test.mezo.org/tx/0x8acdb5e9e379e6afbf644f880b15f51a4997b152af238f20d178500906df0631) | [open](https://explorer.test.mezo.org/tx/0x851167a94ecd8a0105c0e4ff5c83b2feaa9c0633553b8fa058d47678fc18286e) | [loop](https://explorer.test.mezo.org/tx/0x008eb7a8d769a030fb40c1dbedcb77148beaca01dc2956e114f20ee8ef018d19) | [shield](https://explorer.test.mezo.org/tx/0xc783872871d0b75620b61e0176dd9258e964d1bb59c44610c31a22a27e40e5af) |
| user2 | `0x9B0Bc4029Ed50Be1a5E55FA76152E319958600F1` | `0x6a1a86876f890418fa9b1b6503a7c64f48758176` | [create](https://explorer.test.mezo.org/tx/0x89812cbf57d0733f7d192aac1f162d74c2ef992aea5a53c39010658ea1439970) | [open](https://explorer.test.mezo.org/tx/0xd4d2c4bead66c58870ca02ade382d5c334e235fea12017216f50fa15499009e9) | [loop](https://explorer.test.mezo.org/tx/0xf5c79eefe0fbcae29cf0fa02013f5034f3284f0369e7ca51e621799fcc8b39af) | [shield](https://explorer.test.mezo.org/tx/0x6f85700b437cae1da564866830a8821b8fabea433c3231d694b2c196a9339376) |
| user3 | `0x86c4510F98A49F758D125Fa08fA0DF22E314BDF3` | `0x131c80bffd82d61634ce96fe37790901f85d324b` | [create](https://explorer.test.mezo.org/tx/0xed587ca3b05176a847c6499dbae417611fe44365b85426cc91ed954be96c29aa) | [open](https://explorer.test.mezo.org/tx/0xda893bf627aadded69eaf73539a63a98c4e04ab7bdcc4ce1d9ff0e652eaa2efa) | [loop](https://explorer.test.mezo.org/tx/0xf134f9e67c219adf9ef3a94bede68f988ca6995c6553c11b2c46c4b5a00e157a) | [shield](https://explorer.test.mezo.org/tx/0x97e4c9dd5b8d69fc52bb89a1e985c0498d20389f66d0529fb095ba3b67b3547a) |
| user4 | `0x5F94E2b07BffCd44f723F53fC521D2d5c1010d59` | `0x83a17ad85d19dcc8a892dedd4f89a1e2b6b32f32` | [create](https://explorer.test.mezo.org/tx/0x96868d74b611642bc0b94e1384616425c9e22070f8547097668d25cb08100bb2) | [open](https://explorer.test.mezo.org/tx/0xeaa8d1e7006bd3425eaf6d24fa4a464dc48ce1346f9fa73b25bd0dd1aa5e6d97) | [loop](https://explorer.test.mezo.org/tx/0xe75d01e6484473d20e864c9ed9ac8462be44bcba2b692dd2bce9350c2a5e15d5) | [shield](https://explorer.test.mezo.org/tx/0x0675fdf82ff4888edf0577c7f2cbb2d003e954a3dca6bb045cf75242af472f93) |
| user5 | `0x6b5a83c42A6a3D9F31c8236A14771c041f266d4d` | `0x34469872c57a1349a4602a3cdb297d3cd0519181` | [create](https://explorer.test.mezo.org/tx/0x285772b9d419c23120afd46d80fe0ded918acb338aa82544427b39d7786078b3) | [open](https://explorer.test.mezo.org/tx/0x66a1e0e9605d40d9ee222f3926f2314f80c47da2947955a83b4150baaed56323) | [loop](https://explorer.test.mezo.org/tx/0x91f9c5577ef5bbc5ebf0ffd7473c33ced26368c6c291422df44316b386be50ce) | [shield](https://explorer.test.mezo.org/tx/0xb35da83927638efbc13464bdb6f2ca5f0adf5e231a5b7144ca9397c6fcfb6921) |

### On-chain verification (all five positions)

- `engine.isPosition(position)` → `true` · `reserve.positions(position)` → `true`
- `troveManager.getTroveStatus(position)` → `1` (active) — i.e. each trove really holds BTC collateral
- All create / open / loop / shield receipts resolve to `status = 1`
  (user4's open receipt was briefly unresolvable on the flaky public RPC; the trove's active status on-chain is the stronger proof, and the receipt later resolved to `status = 1`)

### Honest notes

- **user1 ran the flow twice** while a tooling bug was being fixed, so user1 created two positions
  (`0x5c2e3b682ee8133f82675ecd4772e9ae8a33e9e5` in the first attempt, and `0x1027ac…1833` in the
  documented run). Both are engine-registered clones owned by user1; only `0x1027ac…1833` carries
  the trove, shield and loop. The other is an empty clone.
- **users 2, 3 and 5 needed one retry on `openTrove`.** Mezo resolves Trove hints approximately;
  three of the five first attempts reverted inside `SortedTroves` with a stale approximate hint. No
  funds moved (a reverted open consumes gas only), and all three succeeded on retry with fresh seeds.
  Shield configuration was also re-sent for those three during the retry (same values:
  170 → 185, max 5,000 MUSD per call). Second shield transactions:
  user2 [`0xa9b4cfb…`](https://explorer.test.mezo.org/tx/0xa9b4cfbff696faa30d54632b17d56c13bafb29a987a7318ee5f35c8c0ab661ea),
  user3 [`0x567f240…`](https://explorer.test.mezo.org/tx/0x567f240c0b177915a60f45d7e24ba7294852090ac563161c62ef2e1f507e6b26),
  user5 [`0x5ec0c16…`](https://explorer.test.mezo.org/tx/0x5ec0c162b6479f7c30a3520040bc5df89f725d0d465c495fb51f785d3279bc6a).
- Wallets were generated for this exercise and funded from the public Mezo faucet; the keys live at
  `~/.pylon-demo/users.json` (mode 0600) on the operator machine and are not part of the repository.
- Testnet only; no real value at risk. Faucet-funded test BTC.

Keys are not committed. The five wallets are public testnet actors whose addresses, positions and
transactions are all independently verifiable on the explorer.
