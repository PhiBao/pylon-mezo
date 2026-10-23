'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useAccount, useConfig } from 'wagmi'
import { ACTIVE_CHAIN, EXPLORER_URL } from '@/lib/chain'
import { ensureChain, type Eip1193Provider } from '@/lib/wallet'

/**
 * Keep the wallet on the chain this bundle serves.
 *
 * Pylon ships as two prerendered bundles — testnet at `/`, mainnet at `/mainnet/` — and a wallet
 * does not follow a page navigation. Without this, switching networks (or connecting while the
 * wallet sits on the other chain) would leave the terminal reading one chain while the wallet signs
 * for another. It switches once per (address, chain) pair; if the wallet does not know the chain it
 * adds it first (EIP-3085) and retries. A rejection leaves the manual switch in the connect menu, so
 * the prompt never loops.
 */
/**
 * Switch to the active chain and, when the wallet does not announce the change itself, update the
 * wagmi store so the header stops offering a switch it already performed. Mirrors the store shape
 * wagmi's own `change` handler writes (connection chainId + active chainId).
 */
export function useSwitchToActiveChain() {
  const { connector } = useAccount()
  const config = useConfig()

  return useCallback(async () => {
    const provider = (await connector?.getProvider()) as Eip1193Provider | undefined
    if (!provider) return
    await ensureChain(provider, ACTIVE_CHAIN, EXPLORER_URL)
    const actual = Number(await provider.request({ method: 'eth_chainId' }))
    if (actual !== ACTIVE_CHAIN.id) return
    config.setState((state) => {
      const connections = new Map(state.connections)
      const existing = connector ? connections.get(connector.uid) : undefined
      if (connector && existing) connections.set(connector.uid, { ...existing, chainId: ACTIVE_CHAIN.id })
      return { ...state, chainId: ACTIVE_CHAIN.id, connections }
    })
  }, [connector, config])
}

export function useAutoNetwork() {
  const { address, chainId, isConnected } = useAccount()
  const switchToActiveChain = useSwitchToActiveChain()
  const attempted = useRef<string | null>(null)

  useEffect(() => {
    if (!isConnected || !address || chainId === ACTIVE_CHAIN.id) return
    const key = `${address}:${chainId}:${ACTIVE_CHAIN.id}`
    if (attempted.current === key) return
    attempted.current = key

    const run = async () => {
      try {
        await switchToActiveChain()
      } catch {
        // Declined or unsupported — the header keeps a manual switch, and signing enforces it again.
      }
    }

    void run()
  }, [isConnected, address, chainId, switchToActiveChain])
}
