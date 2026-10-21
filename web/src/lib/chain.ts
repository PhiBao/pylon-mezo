import { defineChain, getAddress, type Address } from 'viem'

/** Mezo Testnet — the only network this terminal is built against today. */
export const MEZO_TESTNET_ID = 31611

export const MEZO_RPC_URL = process.env.NEXT_PUBLIC_MEZO_RPC ?? 'https://rpc.test.mezo.org'

export const EXPLORER_URL = 'https://explorer.test.mezo.org'

export const mezoTestnet = defineChain({
  id: MEZO_TESTNET_ID,
  name: 'Mezo Testnet',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: {
    default: { http: [MEZO_RPC_URL] },
  },
  blockExplorers: {
    default: { name: 'Mezo Explorer', url: EXPLORER_URL },
  },
  contracts: {
    // Canonical deployment; the terminal batches every on-chain read through it.
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11', blockCreated: 1 },
  },
  testnet: true,
})

export const explorerTx = (hash: string, base: string = EXPLORER_URL): string => `${base}/tx/${hash}`
export const explorerAddress = (address: string, base: string = EXPLORER_URL): string =>
  `${base}/address/${address}`
export const explorerBlock = (block: number, base: string = EXPLORER_URL): string =>
  `${base}/block/${block}`

/**
 * The audited generation on Mezo mainnet (chain 31612), deployed 21 Oct 2026. The terminal reads
 * testnet live; these addresses are shown as a manifest so every mainnet claim can be checked
 * independently on the mainnet explorer.
 */
export const MAINNET_EXPLORER_URL = 'https://explorer.mezo.org'
export const MAINNET_DEPLOYED = {
  chainId: 31612,
  engine: getAddress('0x8DEa475605ac7a99ad28F0DD3537A93b2aCf655D'),
  reserve: getAddress('0x81175AaAC5Fa0873e64480502566Fe993bB88e62'),
  positionImplementation: getAddress('0x645174D655814839a85Bd80D2F54b35A7160465E'),
  musd: getAddress('0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186'),
  btc: getAddress('0x7b7C000000000000000000000000000000000000'),
  flashPool: getAddress('0x10906a9E9215939561597b4C8e4b98F93c02031A'),
  swapPool: getAddress('0x52e604c44417233b6CcEDDDc0d640A405Caacefb'),
  borrowerOps: getAddress('0x44b1bac67dDA612a41a58AAf779143B181dEe031'),
  borrowerOpsSignatures: getAddress('0xB57ab578BF20b3e318f3EFAA587C51DBccE5df7a'),
  troveManager: getAddress('0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193'),
  sortedTroves: getAddress('0x8C5DB4C62BF29c1C4564390d10c20a47E0b2749f'),
  priceFeed: getAddress('0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88'),
  router: getAddress('0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706'),
  poolFactory: getAddress('0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248'),
} as const

/**
 * Deployed Pylon + Mezo core addresses for chain 31611 — a snapshot of
 * `contracts/deployments/31611.json`. Anything the engine API reports in `GET /api/v1/config`
 * overrides these, but the terminal keeps a complete local copy so read-only RPC mode works with no
 * backend at all (`readConfigFromRpc` additionally verifies that code exists at the engine address,
 * so a stale snapshot fails loudly instead of sending a transaction nowhere).
 *
 * Four engine generations exist on testnet. v1 parked repayment MUSD at
 * BorrowerOperationsSignatures (wrong caller); v2 fixed the caller semantics; v3 added per-leg stage
 * guards; v4 passes solver-computed SortedTroves hints into positions so the nested call no longer
 * pays for on-chain hint resolution. v4 is the address used everywhere in this terminal.
 */
export const DEPLOYED = {
  chainId: MEZO_TESTNET_ID,
  engine: getAddress('0x901198cD4EE9086997D839401f361518cAE46ed6'),
  reserve: getAddress('0x53a0206A307E084AdA2eB24346463cf4E14C5131'),
  positionImplementation: getAddress('0x0e64B682Add80A61d24E61ed360b3F3679C6860a'),
  musd: getAddress('0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503'),
  btc: getAddress('0x7b7C000000000000000000000000000000000000'),
  flashPool: getAddress('0x525F049A4494dA0a6c87E3C4df55f9929765Dc3e'),
  swapPool: getAddress('0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9'),
  poolFactory: getAddress('0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A'),
  router: getAddress('0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9'),
  borrowerOps: getAddress('0xCdF7028ceAB81fA0C6971208e83fa7872994beE5'),
  borrowerOpsSignatures: getAddress('0xD757e3646AF370b15f32EB557F0F8380Df7D639e'),
  troveManager: getAddress('0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0'),
  sortedTroves: getAddress('0x722E4D24FD6Ff8b0AC679450F3D91294607268fA'),
  hintHelpers: getAddress('0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6'),
  priceFeed: getAddress('0x86bCF0841622a5dAC14A313a15f96A95421b9366'),
} as const

/**
 * The Mezo BTC oracle is a native precompile. Pylon reads it directly for price-dependent maths
 * (`latestRoundData().answer`, 18 decimals) exactly like the engine contracts do.
 */
export const PRICE_ORACLE = getAddress('0x7b7c000000000000000000000000000000000015')

/** Contacts the terminal is willing to send wallet transactions to without an extra warning. */
export const trustedTargets = (): Address[] => [
  DEPLOYED.engine,
  DEPLOYED.reserve,
  DEPLOYED.musd,
  DEPLOYED.btc,
  DEPLOYED.router,
  DEPLOYED.borrowerOps,
  DEPLOYED.borrowerOpsSignatures,
  DEPLOYED.troveManager,
]
