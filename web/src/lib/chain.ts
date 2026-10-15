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

export const explorerTx = (hash: string): string => `${EXPLORER_URL}/tx/${hash}`
export const explorerAddress = (address: string): string => `${EXPLORER_URL}/address/${address}`
export const explorerBlock = (block: number): string => `${EXPLORER_URL}/block/${block}`

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
  engine: getAddress('0x94b6384F9202F27c3ab1b3b0c6f1A8b7218F45F6'),
  reserve: getAddress('0xcc9dD7197237bbb645978D9A92872C7F82B6b881'),
  positionImplementation: getAddress('0x504DcDD85FD82C2974F27b1f71B6cc116EbE18bE'),
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
