/**
 * Direct Mezo Testnet reads — the terminal's fallback and its read-only mode.
 *
 * Everything here is a real on-chain read through viem. Two things make the fallback useful rather
 * than a stub:
 *   1. `walkQueue` reconstructs the redemption queue from `SortedTroves.getPrev`, starting at the
 *      tail (the first trove a redemption touches), so the Redemption Radar works with no backend.
 *   2. `localLoopQuote` / `localUnwindQuote` / `localExitQuote` call the engine's own `preview*`
 *      view functions — the exact integer maths that runs inside the transaction.
 */

import { createPublicClient, http, type Address, type PublicClient } from 'viem'
import {
  borrowerOpsAbi,
  erc20Abi,
  oracleAbi,
  poolFactoryAbi,
  pylonEngineAbi,
  pylonPositionAbi,
  pylonReserveAbi,
  sortedTrovesAbi,
  tigrisPoolAbi,
  troveManagerAbi,
} from './abi'
import { ACTIVE_CHAIN, ACTIVE_CHAIN_ID, DEPLOYED, PRICE_ORACLE, RPC_URL } from './chain'
import { mulDiv } from './format'
import type {
  ExitQuote,
  LoopQuote,
  Market,
  PositionState,
  Radar,
  RadarTrove,
  Reserve,
  Trove,
  UnwindQuote,
  WalletChainState,
} from './types'

/** Flash MUSD available in the venue pool — the ceiling for any loop or unwind leg. */
export const readFlashMusdReserve = async (): Promise<bigint> => {
  const reserves = await poolReserves(DEPLOYED.flashPool)
  return reserves.musd
}

export const publicClient: PublicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: http(RPC_URL, { batch: true, retryCount: 2, timeout: 15_000 }),
})

export class RpcReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpcReadError'
  }
}

/**
 * viem types a heterogeneous `allowFailure: true` multicall as a union of every possible result, so
 * the terminal reads each entry through these two helpers and states the expected type at the call
 * site. A failure is loud (`unwrap`) or explicitly defaulted (`or`), never silently zero.
 */
type MultiEntry = { status: 'success'; result: unknown } | { status: 'failure'; error: Error }

const unwrap = <T>(entry: MultiEntry | undefined, label: string): T => {
  if (!entry) throw new RpcReadError(`Missing multicall result for ${label}`)
  if (entry.status === 'failure') throw new RpcReadError(`${label} read failed: ${entry.error.message}`)
  return entry.result as T
}

const or = <T>(entry: MultiEntry | undefined, fallback: T): T =>
  entry && entry.status === 'success' && entry.result !== undefined ? (entry.result as T) : fallback

const WAD = 10n ** 18n
const ZERO = '0x0000000000000000000000000000000000000000'

/* --------------------------------------------------------------- market / price */

export async function readBtcPrice(): Promise<bigint> {
  const [, answer] = await publicClient.readContract({
    address: PRICE_ORACLE,
    abi: oracleAbi,
    functionName: 'latestRoundData',
  })
  if (answer <= 0n) throw new RpcReadError('Mezo price precompile returned a non-positive price')
  return answer
}

const poolReserves = async (pool: Address) => {
  const [token0, reserves] = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { address: pool, abi: tigrisPoolAbi, functionName: 'token0' as const },
      { address: pool, abi: tigrisPoolAbi, functionName: 'getReserves' as const },
    ],
  })
  const [reserve0, reserve1] = reserves
  const musdIsToken0 = token0.toLowerCase() === DEPLOYED.musd.toLowerCase()
  return { musd: musdIsToken0 ? reserve0 : reserve1, other: musdIsToken0 ? reserve1 : reserve0 }
}

export async function readMarketFromRpc(): Promise<Market> {
  const chainId = await publicClient.getChainId()
  if (chainId !== ACTIVE_CHAIN_ID) {
    throw new RpcReadError(
      `RPC ${RPC_URL} reports chain ${chainId}; expected ${ACTIVE_CHAIN.name} (${ACTIVE_CHAIN_ID})`,
    )
  }

  const price = await readBtcPrice()

  const [swap, flash, fees, protocol, blockNumber] = await Promise.all([
    poolReserves(DEPLOYED.swapPool),
    poolReserves(DEPLOYED.flashPool),
    publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: DEPLOYED.poolFactory, abi: poolFactoryAbi, functionName: 'getFee' as const, args: [DEPLOYED.swapPool, false] },
        { address: DEPLOYED.poolFactory, abi: poolFactoryAbi, functionName: 'getFee' as const, args: [DEPLOYED.flashPool, true] },
        { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'flashFeeBps' as const },
      ],
    }),
    publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: DEPLOYED.troveManager, abi: troveManagerAbi, functionName: 'getTCR' as const, args: [price] },
        { address: DEPLOYED.troveManager, abi: troveManagerAbi, functionName: 'checkRecoveryMode' as const, args: [price] },
        { address: DEPLOYED.sortedTroves, abi: sortedTrovesAbi, functionName: 'getSize' as const },
      ],
    }),
    publicClient.getBlockNumber(),
  ])

  const [swapFeeBps, , pylonFlashFeeBps] = fees
  const [tcrWad, recoveryMode, troveCount] = protocol
  const cache = queueCache

  return {
    btcPriceWad: price.toString(),
    musdReserve: swap.musd.toString(),
    btcReserve: swap.other.toString(),
    swapFeeBps: Number(swapFeeBps),
    flashMusdReserve: flash.musd.toString(),
    flashFeeBps: Number(pylonFlashFeeBps),
    tcrWad: tcrWad.toString(),
    recoveryMode,
    troveCount: Number(troveCount),
    systemDebt: cache && isFresh(cache) ? cache.systemDebt.toString() : null,
    systemColl: cache && isFresh(cache) ? cache.systemColl.toString() : null,
    updatedBlock: Number(blockNumber),
  }
}

/* --------------------------------------------------------------------- config */

/**
 * Protocol parameters straight from the contracts. Read-only mode still needs MCR/CCR, the gas
 * compensation, the minimum net debt and the three fee components; all of them are on-chain.
 */
export async function readConfigFromRpc(): Promise<import('./types').EngineConfig> {
  // A stale bundled manifest must fail loudly rather than build a transaction to a dead address.
  const code = await publicClient.getBytecode({ address: DEPLOYED.engine })
  if (!code || code === '0x') {
    throw new RpcReadError(
      `No Pylon engine bytecode at ${DEPLOYED.engine} on chain ${ACTIVE_CHAIN_ID}: the bundled deployment manifest is stale`,
    )
  }

  const results = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { address: DEPLOYED.troveManager, abi: troveManagerAbi, functionName: 'MCR' as const },
      { address: DEPLOYED.troveManager, abi: troveManagerAbi, functionName: 'CCR' as const },
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'gasCompensation' as const },
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'minNetDebt' as const },
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'flashFeeBps' as const },
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'flashPoolFeeBps' as const },
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'swapPoolFeeBps' as const },
    ],
  })

  return {
    chainId: ACTIVE_CHAIN_ID,
    engine: DEPLOYED.engine,
    reserve: DEPLOYED.reserve,
    positionImplementation: DEPLOYED.positionImplementation,
    musd: DEPLOYED.musd,
    btc: DEPLOYED.btc,
    flashPool: DEPLOYED.flashPool,
    swapPool: DEPLOYED.swapPool,
    router: DEPLOYED.router,
    borrowerOpsSignatures: DEPLOYED.borrowerOpsSignatures,
    troveManager: DEPLOYED.troveManager,
    sortedTroves: DEPLOYED.sortedTroves,
    explorer: 'https://explorer.test.mezo.org',
    flashFeeBps: Number(results[4]),
    flashPoolFeeBps: Number(results[5]),
    swapPoolFeeBps: Number(results[6]),
    gasCompensation: results[2].toString(),
    minNetDebt: results[3].toString(),
    mcrWad: results[0].toString(),
    ccrWad: results[1].toString(),
  }
}

/* ----------------------------------------------------------------- queue walk */

interface QueueSnapshot {
  rows: RadarTrove[]
  total: number
  fetchedAt: number
  price: bigint
  systemDebt: bigint
  systemColl: bigint
}

let queueCache: QueueSnapshot | null = null

const isFresh = (snapshot: QueueSnapshot): boolean => Date.now() - snapshot.fetchedAt < 90_000

interface TroveDetail {
  coll: bigint
  debt: bigint
  icr: bigint
  nicr: bigint
  rate: number
}

const CHUNK = 20

/**
 * Walks the sorted list from the tail upwards. Each hop needs the previous trove's address, so the
 * walk is inherently sequential: the terminal streams progress into the radar instead of showing a
 * spinner, and lets the user extend coverage on demand.
 */
export async function walkQueue(options: {
  limit: number
  price?: bigint
  onProgress?: (rows: RadarTrove[], discovered: number, total: number) => void
}): Promise<Radar> {
  const { limit, onProgress } = options
  const price = options.price ?? (await readBtcPrice())

  const [totalRaw, mcrWad] = await Promise.all([
    publicClient.readContract({ address: DEPLOYED.sortedTroves, abi: sortedTrovesAbi, functionName: 'getSize' }),
    publicClient.readContract({ address: DEPLOYED.troveManager, abi: troveManagerAbi, functionName: 'MCR' }),
  ])

  const count = Number(totalRaw)
  const target = Math.max(1, Math.min(limit, count))
  const addresses: Address[] = []
  const detail = new Map<Address, TroveDetail>()
  let read = 0

  let cursor = await publicClient.readContract({
    address: DEPLOYED.sortedTroves,
    abi: sortedTrovesAbi,
    functionName: 'getLast',
  })

  while (addresses.length < target && cursor !== ZERO) {
    addresses.push(cursor)
    if (addresses.length % CHUNK === 0) {
      await readDetails(addresses.slice(read), price, detail)
      read = addresses.length
      onProgress?.(assemble(addresses, detail, mcrWad), addresses.length, count)
    }
    const next = await publicClient.readContract({
      address: DEPLOYED.sortedTroves,
      abi: sortedTrovesAbi,
      functionName: 'getPrev',
      args: [cursor],
    })
    if (next === cursor) break
    cursor = next
  }

  if (read < addresses.length) {
    await readDetails(addresses.slice(read), price, detail)
  }
  const rows = assemble(addresses, detail, mcrWad)
  onProgress?.(rows, addresses.length, count)

  if (addresses.length >= count) {
    queueCache = {
      rows,
      total: count,
      fetchedAt: Date.now(),
      price,
      systemColl: rows.reduce((sum, row) => sum + BigInt(row.coll), 0n),
      systemDebt: rows.reduce((sum, row) => sum + BigInt(row.debt), 0n),
    }
  }

  const tcrWad = await publicClient.readContract({
    address: DEPLOYED.troveManager,
    abi: troveManagerAbi,
    functionName: 'getTCR',
    args: [price],
  })

  return {
    tcrWad: tcrWad.toString(),
    mcrWad: mcrWad.toString(),
    totalTroves: count,
    redemptionQueueDepthMusd: rows.reduce((sum, row) => sum + BigInt(row.debt), 0n).toString(),
    distribution: bucketize(rows),
    tail: rows,
    head: [],
    coverage: { read: rows.length, total: count },
  }
}

async function readDetails(
  addresses: Address[],
  price: bigint,
  into: Map<Address, TroveDetail>,
): Promise<void> {
  if (addresses.length === 0) return
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: addresses.flatMap((address) => [
      {
        address: DEPLOYED.troveManager,
        abi: troveManagerAbi,
        functionName: 'getEntireDebtAndColl' as const,
        args: [address] as const,
      },
      {
        address: DEPLOYED.troveManager,
        abi: troveManagerAbi,
        functionName: 'getCurrentICR' as const,
        args: [address, price] as const,
      },
      {
        address: DEPLOYED.troveManager,
        abi: troveManagerAbi,
        functionName: 'getNominalICR' as const,
        args: [address] as const,
      },
      {
        address: DEPLOYED.troveManager,
        abi: troveManagerAbi,
        functionName: 'getTroveInterestRate' as const,
        args: [address] as const,
      },
    ]),
  })

  addresses.forEach((address, index) => {
    const entire = results[index * 4]
    if (entire?.status !== 'success') return
    const [coll, principal, interest, pendingColl, pendingPrincipal, pendingInterest] = entire.result as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ]
    into.set(address, {
      coll: coll + pendingColl,
      debt: principal + interest + pendingPrincipal + pendingInterest,
      icr: or<bigint>(results[index * 4 + 1], 0n),
      nicr: or<bigint>(results[index * 4 + 2], 0n),
      rate: Number(or<number>(results[index * 4 + 3], 0)),
    })
  })
}

function assemble(addresses: Address[], detail: Map<Address, TroveDetail>, mcrWad: bigint): RadarTrove[] {
  const rows: RadarTrove[] = []
  let cumulative = 0n
  addresses.forEach((address, index) => {
    const entry = detail.get(address)
    if (!entry) return
    rows.push({
      rank: index + 1,
      address,
      coll: entry.coll.toString(),
      debt: entry.debt.toString(),
      icrWad: entry.icr.toString(),
      nicr: entry.nicr.toString(),
      interestRateBps: entry.rate,
      redemptionBufferMusd: cumulative.toString(),
      liquidatable: entry.icr > 0n && entry.icr < mcrWad,
    })
    cumulative += entry.debt
  })
  return rows
}

/** ICR bands behind the radar's distribution strip — stable order, human-readable labels. */
export const ICR_BANDS: Array<{ label: string; lowerWad: bigint; upperWad: bigint | null }> = [
  { label: '1.10–1.25', lowerWad: (WAD * 110n) / 100n, upperWad: (WAD * 125n) / 100n },
  { label: '1.25–1.50', lowerWad: (WAD * 125n) / 100n, upperWad: (WAD * 150n) / 100n },
  { label: '1.50–2.00', lowerWad: (WAD * 150n) / 100n, upperWad: (WAD * 200n) / 100n },
  { label: '2.00–3.00', lowerWad: (WAD * 200n) / 100n, upperWad: (WAD * 300n) / 100n },
  { label: '3.00+', lowerWad: (WAD * 300n) / 100n, upperWad: null },
]

export const bucketize = (rows: RadarTrove[]): Array<{ bucket: string; count: number }> => {
  const counts = ICR_BANDS.map(() => 0)
  for (const row of rows) {
    const icr = BigInt(row.icrWad)
    const index = ICR_BANDS.findIndex(
      (band) => icr >= band.lowerWad && (band.upperWad === null || icr < band.upperWad),
    )
    if (index >= 0) counts[index] = (counts[index] ?? 0) + 1
  }
  return ICR_BANDS.map((band, index) => ({ bucket: band.label, count: counts[index] ?? 0 }))
}

/* ---------------------------------------------------------------------- trove */

export const healthOf = (icrWad: bigint): Trove['healthLabel'] => {
  if (icrWad < (WAD * 125n) / 100n) return 'danger'
  if (icrWad < (WAD * 175n) / 100n) return 'watch'
  return 'safe'
}

export async function readTroveFromRpc(address: Address, price?: bigint): Promise<Trove> {
  const mark = price ?? (await readBtcPrice())
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { address: DEPLOYED.troveManager, abi: troveManagerAbi, functionName: 'getTroveStatus' as const, args: [address] },
      { address: DEPLOYED.troveManager, abi: troveManagerAbi, functionName: 'getEntireDebtAndColl' as const, args: [address] },
      { address: DEPLOYED.troveManager, abi: troveManagerAbi, functionName: 'getCurrentICR' as const, args: [address, mark] },
      { address: DEPLOYED.troveManager, abi: troveManagerAbi, functionName: 'getNominalICR' as const, args: [address] },
      { address: DEPLOYED.troveManager, abi: troveManagerAbi, functionName: 'getTroveInterestRate' as const, args: [address] },
      { address: DEPLOYED.sortedTroves, abi: sortedTrovesAbi, functionName: 'contains' as const, args: [address] },
    ],
  })

  const status = Number(unwrap<number>(results[0], 'getTroveStatus'))
  const [coll, principal, interest, pendingColl, pendingPrincipal, pendingInterest] = unwrap<
    readonly [bigint, bigint, bigint, bigint, bigint, bigint]
  >(results[1], 'getEntireDebtAndColl')
  const icr = unwrap<bigint>(results[2], 'getCurrentICR')
  const inQueue = or<boolean>(results[5], false)

  const cached = queueCache
  const cachedRow = cached && isFresh(cached) ? cached.rows.find((row) => row.address === address) : undefined

  return {
    address,
    exists: status === 1 && inQueue,
    coll: (coll + pendingColl).toString(),
    debt: (principal + interest + pendingPrincipal + pendingInterest).toString(),
    principal: (principal + pendingPrincipal).toString(),
    interest: (interest + pendingInterest).toString(),
    icrWad: icr.toString(),
    nicr: unwrap<bigint>(results[3], 'getNominalICR').toString(),
    interestRateBps: Number(or<number>(results[4], 0)),
    rank: cachedRow?.rank ?? null,
    redemptionBufferMusd: cachedRow?.redemptionBufferMusd ?? null,
    healthLabel: healthOf(icr),
  }
}

/* -------------------------------------------------------------------- reserve */

export async function readReserveFromRpc(): Promise<Reserve> {
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { address: DEPLOYED.reserve, abi: pylonReserveAbi, functionName: 'totalAssets' as const },
      { address: DEPLOYED.reserve, abi: pylonReserveAbi, functionName: 'idleLiquidity' as const },
      { address: DEPLOYED.reserve, abi: pylonReserveAbi, functionName: 'outstanding' as const },
      { address: DEPLOYED.reserve, abi: pylonReserveAbi, functionName: 'feesReceived' as const },
      { address: DEPLOYED.reserve, abi: pylonReserveAbi, functionName: 'maxLendPerCall' as const },
      { address: DEPLOYED.reserve, abi: pylonReserveAbi, functionName: 'maxLendPerPosition' as const },
      { address: DEPLOYED.reserve, abi: pylonReserveAbi, functionName: 'utilizationCapBps' as const },
      { address: DEPLOYED.reserve, abi: pylonReserveAbi, functionName: 'convertToAssets' as const, args: [WAD] },
    ],
  })

  const totalAssets = unwrap<bigint>(results[0], 'totalAssets')
  const idle = unwrap<bigint>(results[1], 'idleLiquidity')
  const outstanding = unwrap<bigint>(results[2], 'outstanding')
  const utilizationBps = totalAssets === 0n ? 0 : Number(mulDiv(outstanding, 10_000n, totalAssets))

  return {
    totalAssets: totalAssets.toString(),
    idle: idle.toString(),
    outstanding: outstanding.toString(),
    feesReceived: unwrap<bigint>(results[3], 'feesReceived').toString(),
    utilizationBps,
    sharePrice: unwrap<bigint>(results[7], 'convertToAssets').toString(),
    maxLendPerCall: unwrap<bigint>(results[4], 'maxLendPerCall').toString(),
    maxLendPerPosition: unwrap<bigint>(results[5], 'maxLendPerPosition').toString(),
    utilizationCapBps: Number(unwrap<bigint>(results[6], 'utilizationCapBps')),
    loans: [],
  }
}

/* ------------------------------------------------------------ position / shield */

export async function readPositionFromRpc(position: Address): Promise<PositionState> {
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { address: position, abi: pylonPositionAbi, functionName: 'owner' as const },
      { address: position, abi: pylonPositionAbi, functionName: 'policy' as const },
      { address: position, abi: pylonPositionAbi, functionName: 'reserveDebt' as const },
      { address: position, abi: pylonPositionAbi, functionName: 'health' as const },
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'isPosition' as const, args: [position] },
      { address: DEPLOYED.reserve, abi: pylonReserveAbi, functionName: 'availableToLend' as const, args: [position] },
    ],
  })

  if (results[0]?.status !== 'success') {
    throw new RpcReadError(`${position} is not a Pylon position`)
  }

  const [enabled, triggerICR, targetICR, maxPerCall] = or<
    readonly [boolean, bigint, bigint, bigint]
  >(results[1], [false, 0n, 0n, 0n] as const)
  const [coll, debt, icr, price] = or<readonly [bigint, bigint, bigint, bigint]>(
    results[3],
    [0n, 0n, 0n, 0n] as const,
  )

  return {
    address: position,
    owner: unwrap<Address>(results[0], 'owner'),
    registered: or<boolean>(results[4], false),
    policy: {
      enabled,
      triggerIcrWad: triggerICR.toString(),
      targetIcrWad: targetICR.toString(),
      maxPerCall: maxPerCall.toString(),
    },
    reserveDebt: or<bigint>(results[2], 0n).toString(),
    availableToLend: or<bigint>(results[5], 0n).toString(),
    coll: coll.toString(),
    debt: debt.toString(),
    icrWad: icr.toString(),
    priceWad: price.toString(),
  }
}

const positionCreatedEvent = {
  type: 'event',
  name: 'PositionCreated',
  inputs: [
    { name: 'owner', type: 'address', indexed: true },
    { name: 'position', type: 'address', indexed: true },
  ],
} as const

/** Position addresses owned by `account`, discovered from the engine's creation logs. */
export async function findPositions(account: Address): Promise<Address[]> {
  try {
    const logs = await publicClient.getLogs({
      address: DEPLOYED.engine,
      event: positionCreatedEvent,
      args: { owner: account },
      fromBlock: 0n,
      toBlock: 'latest',
    })
    return logs
      .map((log) => log.args.position)
      .filter((value): value is Address => typeof value === 'string')
  } catch {
    return []
  }
}

/* --------------------------------------------------------------------- wallet */

export async function readWalletFromRpc(account: Address): Promise<WalletChainState> {
  const results = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { address: DEPLOYED.musd, abi: erc20Abi, functionName: 'balanceOf' as const, args: [account] },
      { address: DEPLOYED.btc, abi: erc20Abi, functionName: 'balanceOf' as const, args: [account] },
      { address: DEPLOYED.reserve, abi: pylonReserveAbi, functionName: 'shares' as const, args: [account] },
    ],
  })

  const shares = or<bigint>(results[2], 0n)
  const assets =
    shares === 0n
      ? 0n
      : await publicClient.readContract({
          address: DEPLOYED.reserve,
          abi: pylonReserveAbi,
          functionName: 'convertToAssets',
          args: [shares],
        })

  return {
    musdBalance: or<bigint>(results[0], 0n),
    btcBalance: or<bigint>(results[1], 0n),
    reserveShares: shares,
    reserveAssets: assets,
  }
}

/* --------------------------------------------------------------- local quotes */

export interface TroveState {
  coll: bigint
  debt: bigint
}

/** Swap floor assumed by local previews when the engine API is unavailable (50 bps). */
const LOCAL_SLIPPAGE_BPS = 50n

export async function localLoopQuote(
  collAdd: bigint,
  trove: TroveState | null,
  price: bigint,
  flashMusdReserve: bigint,
): Promise<LoopQuote> {
  const results = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'previewLoopDebtForCollateral' as const, args: [collAdd] },
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'previewMusdIn' as const, args: [collAdd] },
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'flashPoolFeeBps' as const },
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'flashFeeBps' as const },
    ],
  })

  const [debtDelta, pylonFee] = results[0]
  const swapIn = results[1]
  const flashPoolBps = results[2]
  const pylonBps = results[3]

  if (debtDelta > flashMusdReserve) {
    throw new RpcReadError(
      'Flash venue cannot fund this loop: the required MUSD exceeds the flash pool reserve',
    )
  }

  // The venue's flash fee must cover the pool's own fee on (principal + fee).
  const flashFee = (debtDelta * flashPoolBps) / (10_000n - flashPoolBps) + 1n
  const borrowingFee = await publicClient.readContract({
    address: DEPLOYED.borrowerOps,
    abi: borrowerOpsAbi,
    functionName: 'getBorrowingFee',
    args: [debtDelta],
  })

  const postColl = trove ? trove.coll + collAdd : 0n
  const postDebt = trove ? trove.debt + debtDelta + borrowingFee : 0n

  return {
    collAdd: collAdd.toString(),
    debtDelta: debtDelta.toString(),
    pylonFee: pylonFee.toString(),
    flashFee: flashFee.toString(),
    swapIn: swapIn.toString(),
    btcOut: collAdd.toString(),
    musdBorrowed: debtDelta.toString(),
    borrowingFee: borrowingFee.toString(),
    postColl: postColl.toString(),
    postDebt: postDebt.toString(),
    postIcrWad: postDebt > 0n ? mulDiv(postColl, price, postDebt).toString() : '0',
    minMusdOut: (swapIn - mulDiv(swapIn, LOCAL_SLIPPAGE_BPS, 10_000n)).toString(),
    source: 'local',
    pylonFeeBps: Number(pylonBps),
    flashFeeBps: Number(flashPoolBps),
  }
}

export async function localUnwindQuote(repay: bigint, trove: TroveState, price: bigint): Promise<UnwindQuote> {
  const results = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'previewUnwindMusdNeeded' as const, args: [repay] },
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'previewUnwindBtcIn' as const, args: [repay] },
    ],
  })

  const musdNeeded = results[0]
  const btcInNeeded = results[1]
  // The engine sells exactly what it needs and returns the surplus; withdrawing with 5% headroom
  // keeps the swap's own fee covered (same headroom the on-chain proof script uses).
  const suggestedCollOut = btcInNeeded + mulDiv(btcInNeeded, 500n, 10_000n) + 1n
  const postColl = trove.coll > suggestedCollOut ? trove.coll - suggestedCollOut : 0n
  const postDebt = trove.debt > repay ? trove.debt - repay : 0n

  return {
    repay: repay.toString(),
    musdNeeded: musdNeeded.toString(),
    btcInNeeded: btcInNeeded.toString(),
    suggestedCollOut: suggestedCollOut.toString(),
    postColl: postColl.toString(),
    postDebt: postDebt.toString(),
    postIcrWad: postDebt > 0n ? mulDiv(postColl, price, postDebt).toString() : '0',
    redemptionBufferAfterMusd: repay.toString(),
    source: 'local',
  }
}

export async function localExitQuote(owner: Address, trove: TroveState): Promise<ExitQuote> {
  const [previewRaw, gasCompensationRaw, flashFeeBpsRaw] = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'previewClose' as const, args: [owner] },
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'gasCompensation' as const },
      { address: DEPLOYED.engine, abi: pylonEngineAbi, functionName: 'flashFeeBps' as const },
    ],
  })

  const [btcIn, debt] = previewRaw as readonly [bigint, bigint]
  const gasCompensation = gasCompensationRaw as bigint
  const flashFeeBps = flashFeeBpsRaw as number
  const flashAmount = trove.debt > gasCompensation ? trove.debt - gasCompensation : 0n

  return {
    debt: debt.toString(),
    flashAmount: flashAmount.toString(),
    btcInNeeded: btcIn.toString(),
    btcBackToOwner: (trove.coll > btcIn ? trove.coll - btcIn : 0n).toString(),
    feeMusd: ((flashAmount * BigInt(flashFeeBps)) / 10_000n).toString(),
    source: 'local',
  }
}
