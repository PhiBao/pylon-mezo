'use client'

import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { Address } from 'viem'
import { api, describeError, shouldFallBack, type LoopQuoteWire, type UnwindQuoteWire } from '@/lib/api'
import { DEPLOYED } from '@/lib/chain'
import {
  localExitQuote,
  localLoopQuote,
  readFlashMusdReserve,
  localUnwindQuote,
  readBtcPrice,
  readConfigFromRpc,
  readMarketFromRpc,
  readPositionFromRpc,
  readReserveFromRpc,
  readTroveFromRpc,
  readWalletFromRpc,
  walkQueue,
  findPositions,
  RpcReadError,
} from '@/lib/rpc'
import { STATIC_LEDGER } from '@/lib/static-ledger'
import type {
  EngineConfig,
  ExitQuote,
  LoopQuote,
  Market,
  PositionState,
  Proof,
  ProofKind,
  ProofLedger,
  Radar,
  RadarTrove,
  Reserve,
  Sourced,
  Trove,
  UnwindQuote,
  WalletChainState,
} from '@/lib/types'

/** Milliseconds between automatic re-reads per data domain. */
const POLL = {
  market: 20_000,
  radar: 30_000,
  trove: 20_000,
  reserve: 30_000,
  proofs: 45_000,
  wallet: 15_000,
} as const

/**
 * The engine records operations by their opcode (`flash-loop`, `keeper-defend`), while the terminal's
 * ledger filters and labels use a smaller display taxonomy. Normalise at the fetch boundary so the
 * KIND column and the filter chips agree with what the engine actually ran — a keeper defence is a
 * shield action, and it should appear under the shield filter.
 */
const PROOF_KIND: Record<string, ProofKind> = {
  'flash-loop': 'loop',
  'position-loop': 'loop',
  loop: 'loop',
  'flash-unwind': 'unwind',
  'position-unwind': 'unwind',
  unwind: 'unwind',
  'flash-exit': 'exit',
  'position-exit': 'exit',
  exit: 'exit',
  'shield-defend': 'shield',
  'keeper-defend': 'shield',
  'shield-configured': 'shield',
  shield: 'shield',
  'reserve-approve': 'reserve',
  'reserve-deposit': 'reserve',
  'reserve-withdraw': 'reserve',
  reserve: 'reserve',
  'position-created': 'deploy',
  'position-open': 'deploy',
  deploy: 'deploy',
}

const normalizeProofKind = (kind: string): ProofKind => PROOF_KIND[kind] ?? 'deploy'

const normalizeLedger = (ledger: ProofLedger): ProofLedger => ({
  ...ledger,
  proofs: ledger.proofs.map((proof: Proof) => ({ ...proof, kind: normalizeProofKind(proof.kind) })),
})

export interface RuntimeConfig extends EngineConfig {
  /** Needed for self-broadcast hint computation; published by the engine service. */
  hintHelpers: Address
  /** Provenance of the effective configuration. */
  source: 'engine' | 'rpc'
}

const deployedConfig = (): EngineConfig & { hintHelpers: Address } => ({
  chainId: DEPLOYED.chainId,
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
  flashFeeBps: 20,
  flashPoolFeeBps: 1,
  swapPoolFeeBps: 4,
  gasCompensation: '200000000000000000000',
  minNetDebt: '1800000000000000000000',
  mcrWad: '1100000000000000000',
  ccrWad: '1500000000000000000',
  hintHelpers: DEPLOYED.hintHelpers,
})

export function useRuntimeConfig(): UseQueryResult<Sourced<RuntimeConfig>> {
  return useQuery({
    queryKey: ['config'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Sourced<RuntimeConfig>> => {
      try {
        const config = await api.config()
        const withExtras = config as EngineConfig & { hintHelpers?: Address; borrowerOps?: Address }
        return {
          value: {
            ...config,
            hintHelpers: withExtras.hintHelpers ?? DEPLOYED.hintHelpers,
            source: 'engine',
          },
          source: 'engine',
        }
      } catch (error) {
        if (!shouldFallBack(error)) throw error
        try {
          const onChain = await readConfigFromRpc()
          return {
            value: { ...onChain, hintHelpers: DEPLOYED.hintHelpers, source: 'rpc' },
            source: 'rpc',
            note: describeError(error),
          }
        } catch {
          // The bundled deployment manifest is still a truthful configuration: every address and
          // parameter below was read from chain 31611 at deploy time.
          return {
            value: { ...deployedConfig(), source: 'rpc' },
            source: 'rpc',
            note: describeError(error),
          }
        }
      }
    },
  })
}

export function useMarket(): UseQueryResult<Sourced<Market>> {
  return useQuery({
    queryKey: ['market'],
    refetchInterval: POLL.market,
    queryFn: async (): Promise<Sourced<Market>> => {
      try {
        return { value: await api.market(), source: 'engine' }
      } catch (error) {
        if (!shouldFallBack(error)) throw error
        return { value: await readMarketFromRpc(), source: 'rpc', note: describeError(error) }
      }
    },
  })
}

export type RadarResult = UseQueryResult<Sourced<Radar>> & {
  /** Live walk progress when the radar is being reconstructed from RPC. */
  progress: { rows: RadarTrove[]; read: number; total: number } | null
}

export function useRadar(limit: number): RadarResult {
  const [progress, setProgress] = useState<RadarResult['progress']>(null)

  const query = useQuery({
    queryKey: ['radar', limit],
    refetchInterval: POLL.radar,
    queryFn: async (): Promise<Sourced<Radar>> => {
      try {
        const radar = await api.radar(limit)
        setProgress(null)
        return { value: radar, source: 'engine' }
      } catch (error) {
        if (!shouldFallBack(error)) throw error
        const market = await readBtcPrice().then((price) => ({ price }))
        const radar = await walkQueue({
          limit,
          price: market.price,
          onProgress: (rows, read, total) => setProgress({ rows, read, total }),
        })
        setProgress(null)
        return { value: radar, source: 'rpc', note: describeError(error) }
      }
    },
  })

  return { ...query, progress } as RadarResult
}

export function useTrove(address: Address | null): UseQueryResult<Sourced<Trove> | null> {
  return useQuery({
    queryKey: ['trove', address],
    enabled: address !== null,
    refetchInterval: POLL.trove,
    queryFn: async (): Promise<Sourced<Trove> | null> => {
      if (!address) return null
      try {
        return { value: await api.trove(address), source: 'engine' }
      } catch (error) {
        if (!shouldFallBack(error)) throw error
        const trove = await readTroveFromRpc(address)
        return { value: trove, source: 'rpc', note: describeError(error) }
      }
    },
  })
}

export function useReserve(): UseQueryResult<Sourced<Reserve>> {
  return useQuery({
    queryKey: ['reserve'],
    refetchInterval: POLL.reserve,
    queryFn: async (): Promise<Sourced<Reserve>> => {
      try {
        return { value: await api.reserve(), source: 'engine' }
      } catch (error) {
        if (!shouldFallBack(error)) throw error
        return { value: await readReserveFromRpc(), source: 'rpc', note: describeError(error) }
      }
    },
  })
}

export function useProofs(): UseQueryResult<Sourced<ProofLedger>> {
  return useQuery({
    queryKey: ['proofs'],
    refetchInterval: POLL.proofs,
    queryFn: async (): Promise<Sourced<ProofLedger>> => {
      try {
        const ledger = await api.proofs()
        return { value: normalizeLedger(ledger), source: 'engine' }
      } catch (error) {
        if (!shouldFallBack(error)) throw error
        return {
          value: normalizeLedger({ proofs: STATIC_LEDGER }),
          source: 'rpc',
          note: `Engine API offline — showing the frozen deployment ledger. ${describeError(error)}`,
        }
      }
    },
  })
}

export function useWalletState(account: Address | null): UseQueryResult<WalletChainState | null> {
  return useQuery({
    queryKey: ['wallet', account],
    enabled: account !== null,
    refetchInterval: POLL.wallet,
    queryFn: async (): Promise<WalletChainState | null> => {
      if (!account) return null
      return readWalletFromRpc(account)
    },
  })
}

export function usePosition(address: Address | null): UseQueryResult<PositionState | null> {
  return useQuery({
    queryKey: ['position', address],
    enabled: address !== null,
    refetchInterval: POLL.wallet,
    queryFn: async (): Promise<PositionState | null> => {
      if (!address) return null
      try {
        return await readPositionFromRpc(address)
      } catch (error) {
        if (error instanceof RpcReadError) return null
        throw error
      }
    },
  })
}

export function useOwnedPositions(account: Address | null): UseQueryResult<Address[]> {
  return useQuery({
    queryKey: ['positions', account],
    enabled: account !== null,
    staleTime: 60_000,
    queryFn: async (): Promise<Address[]> => (account ? findPositions(account) : []),
  })
}

/* --------------------------------------------------------------------- quotes */

/**
 * Engine quotes carry the post-state as a nested `trove` object (`coll`, `debt`, `icrWad`), while the
 * terminal's quote contract wants those as top-level fields. Reading the engine payload as-is left
 * `postIcrWad` undefined, and the next render threw "Cannot convert undefined to a BigInt" — so a
 * successful quote was worse than a failed one. Normalise both shapes here, and compute the swap
 * floor the same way the on-chain preview does.
 */
interface QuotePostState {
  coll?: string
  debt?: string
  icrWad?: string
  redemptionBufferMusd?: string
}

type WireQuote<T> = Partial<T> & {
  trove?: QuotePostState | null
  // The engine publishes its fee rates even though the terminal's wire contract omits them.
  pylonFeeBps?: number
  flashFeeBps?: number
}

const SWAP_SLIPPAGE_BPS = 50n

const normalizeLoopQuote = (
  wire: WireQuote<LoopQuoteWire>,
  collAdd: bigint,
  trove: { coll: bigint; debt: bigint } | null,
): LoopQuote => {
  const swapIn = BigInt(wire.swapIn ?? '0')
  return {
    collAdd: wire.collAdd ?? collAdd.toString(),
    debtDelta: wire.debtDelta ?? '0',
    pylonFee: wire.pylonFee ?? '0',
    flashFee: wire.flashFee ?? '0',
    swapIn: swapIn.toString(),
    btcOut: wire.btcOut ?? collAdd.toString(),
    musdBorrowed: wire.musdBorrowed ?? wire.debtDelta ?? '0',
    borrowingFee: wire.borrowingFee ?? '0',
    postColl:
      wire.postColl ??
      wire.trove?.coll ??
      (trove ? (trove.coll + collAdd).toString() : collAdd.toString()),
    postDebt:
      wire.postDebt ??
      wire.trove?.debt ??
      (trove
        ? (trove.debt + BigInt(wire.debtDelta ?? '0') + BigInt(wire.borrowingFee ?? '0')).toString()
        : '0'),
    postIcrWad: wire.postIcrWad ?? wire.trove?.icrWad ?? '0',
    minMusdOut: wire.minMusdOut ?? (swapIn - (swapIn * SWAP_SLIPPAGE_BPS) / 10_000n).toString(),
    source: 'engine',
    pylonFeeBps: wire.pylonFeeBps,
    flashFeeBps: wire.flashFeeBps,
  }
}

const normalizeUnwindQuote = (wire: WireQuote<UnwindQuoteWire>): UnwindQuote => ({
  repay: wire.repay ?? '0',
  musdNeeded: wire.musdNeeded ?? '0',
  btcInNeeded: wire.btcInNeeded ?? '0',
  suggestedCollOut: wire.suggestedCollOut ?? '0',
  postColl: wire.postColl ?? wire.trove?.coll ?? '0',
  postDebt: wire.postDebt ?? wire.trove?.debt ?? '0',
  postIcrWad: wire.postIcrWad ?? wire.trove?.icrWad ?? '0',
  redemptionBufferAfterMusd:
    wire.redemptionBufferAfterMusd ?? wire.trove?.redemptionBufferMusd ?? '0',
  source: 'engine',
})

export function useLoopQuote(
  collAdd: bigint | null,
  trove: { coll: bigint; debt: bigint } | null,
  owner?: string | null,
): UseQueryResult<LoopQuote | null> {
  return useQuery({
    queryKey: ['quote', 'loop', collAdd?.toString() ?? 'none', owner ?? 'any'],
    enabled: collAdd !== null && collAdd > 0n,
    staleTime: 5_000,
    queryFn: async (): Promise<LoopQuote | null> => {
      if (collAdd === null || collAdd <= 0n) return null
      try {
        // `owner` makes the engine compute post-state for the real trove rather than generically.
        const quote = (await api.loopQuote(collAdd.toString(), owner ?? undefined)) as WireQuote<LoopQuoteWire>
        return normalizeLoopQuote(quote, collAdd, trove)
      } catch (error) {
        if (!shouldFallBack(error)) throw error
        const [price, flash] = await Promise.all([readBtcPrice(), readFlashMusdReserve()])
        return localLoopQuote(collAdd, trove, price, flash)
      }
    },
  })
}

export function useUnwindQuote(
  address: Address | null,
  repay: bigint | null,
  trove: { coll: bigint; debt: bigint } | null,
): UseQueryResult<UnwindQuote | null> {
  return useQuery({
    queryKey: ['quote', 'unwind', address, repay?.toString() ?? 'none'],
    enabled: address !== null && repay !== null && repay > 0n,
    staleTime: 5_000,
    queryFn: async (): Promise<UnwindQuote | null> => {
      if (!address || repay === null || repay <= 0n) return null
      try {
        const quote = (await api.unwindQuote(address, repay.toString())) as WireQuote<UnwindQuoteWire>
        return normalizeUnwindQuote(quote)
      } catch (error) {
        if (!shouldFallBack(error)) throw error
        if (!trove) throw error
        const price = await readBtcPrice()
        return localUnwindQuote(repay, trove, price)
      }
    },
  })
}

export function useExitQuote(
  address: Address | null,
  trove: { coll: bigint; debt: bigint } | null,
): UseQueryResult<ExitQuote | null> {
  return useQuery({
    queryKey: ['quote', 'exit', address],
    enabled: address !== null,
    staleTime: 10_000,
    queryFn: async (): Promise<ExitQuote | null> => {
      if (!address) return null
      try {
        const quote = await api.exitQuote(address)
        return { ...quote, source: 'engine' as const }
      } catch (error) {
        if (!shouldFallBack(error)) throw error
        if (!trove) throw error
        return localExitQuote(address, trove)
      }
    },
  })
}

/* --------------------------------------------------------------- derived views */

export function useTroveState(trove: Sourced<Trove> | null | undefined): { coll: bigint; debt: bigint } | null {
  return useMemo(() => {
    if (!trove) return null
    try {
      return { coll: BigInt(trove.value.coll), debt: BigInt(trove.value.debt) }
    } catch {
      return null
    }
  }, [trove])
}
