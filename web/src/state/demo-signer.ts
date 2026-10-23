'use client'

import { useSyncExternalStore } from 'react'
import { createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { useAccount } from 'wagmi'
import { ACTIVE_CHAIN, RPC_URL } from '@/lib/chain'

/**
 * Demo signer.
 *
 * A wallet extension is the right way to sign a trove authorisation, but it is the wrong thing to
 * depend on when recording a demo or running a judge through the flow: the extension may not be
 * installed, may be on the wrong network, or may refuse to open in an automated browser.
 *
 * This is the escape hatch: paste a private key into the tab, and Pylon signs the same EIP-712
 * ballot locally and broadcasts through the same routes. The key lives in this module's memory only
 * — never in localStorage, never in a cookie, never sent anywhere except as a signature. Reloading
 * the page forgets it.
 *
 * It is deliberately a demo affordance, not a custody feature: the UI labels it DEMO KEY, and the
 * dialog says to use a throwaway key.
 */
/**
 * The demo signer is a recording affordance, not a product surface: the production header hides it
 * unless the build opts in with NEXT_PUBLIC_DEMO_SIGNER=1.
 */
export const DEMO_SIGNER_ENABLED = process.env.NEXT_PUBLIC_DEMO_SIGNER === '1'

interface DemoSignerSnapshot {
  address: Address | null
  error: string | null
}

let account: PrivateKeyAccount | null = null
let client: ReturnType<typeof createWalletClient> | null = null
let snapshot: DemoSignerSnapshot = { address: null, error: null }
const listeners = new Set<() => void>()

const publish = (next: DemoSignerSnapshot) => {
  snapshot = next
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getSnapshot = () => snapshot

/** The live local account, for the execution path (not a React value). */
export const demoAccount = (): PrivateKeyAccount | null => account

/** A wallet client that sends from the local account — same chain and RPC as the terminal. */
export const demoWalletClient = () => {
  if (!account) return null
  client ??= createWalletClient({ account, chain: ACTIVE_CHAIN, transport: http(RPC_URL) })
  return client
}

export const connectDemoKey = (raw: string): boolean => {
  const key = raw.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    publish({ address: null, error: 'A private key is 32 bytes of hex, 0x-prefixed.' })
    return false
  }
  try {
    account = privateKeyToAccount(key as Hex)
    client = null
    publish({ address: account.address, error: null })
    return true
  } catch {
    account = null
    client = null
    publish({ address: null, error: 'That key could not be read as a secp256k1 private key.' })
    return false
  }
}

export const disconnectDemoKey = () => {
  account = null
  client = null
  publish({ address: null, error: null })
}

export function useDemoSigner(): DemoSignerSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * The address that signs for this session: the demo key when one is loaded, otherwise the injected
 * wallet. Every panel that decides "whose trove is this?" reads this, so the architect targets the
 * demo account the moment it is connected.
 */
export function useSignerAddress(): Address | null {
  const demo = useDemoSigner()
  const { address } = useAccount()
  return demo.address ?? address ?? null
}
