/**
 * The terminal's domain model. Wire shapes mirror the engine API contract exactly; the terminal
 * adds only provenance (`source`) so a panel can never present a locally computed estimate as an
 * authoritative engine quote.
 */

export type Address = `0x${string}`
/** Raw on-chain integer as a decimal string. Never rendered directly — see lib/format.ts. */
export type Wei = string
/** 1e18 fixed point (ICRs, ratios). */
export type Wad = string

export type DataSource = 'engine' | 'rpc'
export type QuoteSource = 'engine' | 'local'

/** A value plus where it came from, so provenance is visible in the UI. */
export interface Sourced<T> {
  value: T
  source: DataSource
  note?: string
}

/* ------------------------------------------------------------------- protocol */

export interface EngineConfig {
  chainId: number
  engine: Address
  reserve: Address
  positionImplementation: Address
  musd: Address
  btc: Address
  flashPool: Address
  swapPool: Address
  router: Address
  borrowerOpsSignatures: Address
  troveManager: Address
  sortedTroves: Address
  explorer: string
  flashFeeBps: number
  flashPoolFeeBps: number
  swapPoolFeeBps: number
  gasCompensation: Wei
  minNetDebt: Wei
  mcrWad: Wad
  ccrWad: Wad
}

export interface Market {
  btcPriceWad: Wad
  musdReserve: Wei
  btcReserve: Wei
  swapFeeBps: number
  flashMusdReserve: Wei
  flashFeeBps: number
  tcrWad: Wad
  recoveryMode: boolean
  troveCount: number
  systemDebt: Wei | null
  systemColl: Wei | null
  updatedBlock: number | null
}

/* ---------------------------------------------------------------------- radar */

export interface RadarTrove {
  rank: number
  address: Address
  coll: Wei
  debt: Wei
  icrWad: Wad
  nicr: Wei
  interestRateBps: number
  redemptionBufferMusd: Wei
  liquidatable: boolean
}

export interface RadarBucket {
  bucket: string
  count: number
}

export interface Radar {
  tcrWad: Wad
  mcrWad: Wad
  totalTroves: number
  redemptionQueueDepthMusd: Wei
  distribution: RadarBucket[]
  tail: RadarTrove[]
  head: RadarTrove[]
  /** Coverage of the tail when the radar was reconstructed from RPC instead of the engine API. */
  coverage?: { read: number; total: number }
}

export interface Trove {
  address: Address
  exists: boolean
  coll: Wei
  debt: Wei
  principal: Wei
  interest: Wei
  icrWad: Wad
  nicr: Wei
  interestRateBps: number
  rank: number | null
  redemptionBufferMusd: Wei | null
  healthLabel: 'safe' | 'watch' | 'danger'
  hints?: { upper: Address; lower: Address }
}

/* --------------------------------------------------------------------- quotes */

export interface LoopQuote {
  collAdd: Wei
  debtDelta: Wei
  pylonFee: Wei
  flashFee: Wei
  swapIn: Wei
  btcOut: Wei
  musdBorrowed: Wei
  borrowingFee: Wei
  postColl: Wei
  postDebt: Wei
  postIcrWad: Wad
  minMusdOut: Wei
  source: QuoteSource
  pylonFeeBps?: number
  flashFeeBps?: number
}

export interface UnwindQuote {
  repay: Wei
  musdNeeded: Wei
  btcInNeeded: Wei
  suggestedCollOut: Wei
  postColl: Wei
  postDebt: Wei
  postIcrWad: Wad
  redemptionBufferAfterMusd: Wei
  source: QuoteSource
}

export interface ExitQuote {
  debt: Wei
  flashAmount: Wei
  btcInNeeded: Wei
  btcBackToOwner: Wei
  feeMusd: Wei
  source: QuoteSource
}

/* -------------------------------------------------------------------- reserve */

export interface ReserveLoan {
  position: Address
  loan: Wei
  owner?: Address
  icrWad?: Wad
  shieldEnabled?: boolean
}

export interface Reserve {
  totalAssets: Wei
  idle: Wei
  outstanding: Wei
  feesReceived: Wei
  utilizationBps: number
  sharePrice: Wad
  maxLendPerCall: Wei
  maxLendPerPosition: Wei
  utilizationCapBps: number
  loans: ReserveLoan[]
}

/* --------------------------------------------------------------------- shield */

export interface PositionState {
  address: Address
  owner: Address
  registered: boolean
  policy: {
    enabled: boolean
    triggerIcrWad: Wad
    targetIcrWad: Wad
    maxPerCall: Wei
  }
  reserveDebt: Wei
  availableToLend: Wei
  coll: Wei
  debt: Wei
  icrWad: Wad
  priceWad: Wad
}

/* -------------------------------------------------------------------- proofs */

export type ProofKind = 'loop' | 'unwind' | 'exit' | 'shield' | 'reserve' | 'deploy'

export interface Proof {
  id: string
  kind: ProofKind
  txHash: string
  explorerUrl: string
  actor: string
  note: string
  musd: Wei | null
  btc: Wei | null
  feeMusd: Wei | null
  block: number | null
  timestamp: number | null
}

export interface ProofLedger {
  proofs: Proof[]
}

/* ------------------------------------------------------------------- wallet */

export interface WalletChainState {
  musdBalance: bigint
  btcBalance: bigint
  reserveShares: bigint
  reserveAssets: bigint
}
