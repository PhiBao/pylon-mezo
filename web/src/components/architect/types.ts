'use client'

import type { Address } from 'viem'
import type { Market, Sourced, Trove } from '@/lib/types'
import type { BroadcastRoute, AtomicExecution } from '@/state/execution'
import type { RuntimeConfig } from '@/state/queries'

/** MUSD per BTC implied by the Tigris pool, WAD — the rate operations actually trade at. */
export const poolRateFrom = (market: Market | null): bigint | null => {
  if (!market) return null
  const musd = BigInt(market.musdReserve)
  const btc = BigInt(market.btcReserve)
  if (btc === 0n || musd === 0n) return null
  return (musd * 10n ** 18n) / btc
}

export interface ArchitectSharedProps {
  /** Trove owner the operation acts on (wallet address or a trove picked in the radar). */
  owner: Address | null
  trove: Sourced<Trove> | null | undefined
  troveState: { coll: bigint; debt: bigint } | null
  market: Market | null
  config: RuntimeConfig
  engineAvailable: boolean
  walletAvailable: boolean
  execution: AtomicExecution
  route: BroadcastRoute
  onRouteChange: (route: BroadcastRoute) => void
}
