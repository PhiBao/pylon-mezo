'use client'

import { useEffect, useRef } from 'react'
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi'
import { ACTIVE_CHAIN } from '@/lib/chain'

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
export function useAutoNetwork() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { data: walletClient } = useWalletClient()
  const attempted = useRef<string | null>(null)

  useEffect(() => {
    if (!isConnected || !address || chainId === ACTIVE_CHAIN.id) return
    const key = `${address}:${chainId}:${ACTIVE_CHAIN.id}`
    if (attempted.current === key) return
    attempted.current = key

    const run = async () => {
      try {
        await switchChainAsync({ chainId: ACTIVE_CHAIN.id })
      } catch {
        try {
          await walletClient?.addChain({ chain: ACTIVE_CHAIN })
          await switchChainAsync({ chainId: ACTIVE_CHAIN.id })
        } catch {
          // Declined or unsupported — ConnectButton still offers the manual switch.
        }
      }
    }

    void run()
  }, [isConnected, address, chainId, switchChainAsync, walletClient])
}
