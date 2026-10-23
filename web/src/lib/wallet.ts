import type { Chain } from 'viem'

/** Minimal EIP-1193 surface — what a wallet's injected provider actually exposes. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

const hexId = (chain: Chain) => `0x${chain.id.toString(16)}`

export const addChainParams = (chain: Chain, explorer?: string) => ({
  chainId: hexId(chain),
  chainName: chain.name,
  nativeCurrency: chain.nativeCurrency,
  rpcUrls: chain.rpcUrls.default.http,
  blockExplorerUrls: explorer ? [explorer] : undefined,
})

/** Wallets disagree on how an unknown chain surfaces: 4902, or a message. */
export const isUnknownChain = (error: unknown): boolean => {
  const e = error as { code?: number; message?: string; data?: { originalError?: { code?: number } } }
  const code = e?.code ?? e?.data?.originalError?.code
  return (
    code === 4902 ||
    /unrecognized chain|unknown chain|not added|try adding the chain|chain .* not found/i.test(e?.message ?? '')
  )
}

/** True when the wallet is on a different chain than the one the app is signing for. */
export const isWrongChainError = (error: unknown): boolean => {
  const message = (error as { message?: string })?.message ?? ''
  return /chainid should be same as current chainid|must match the active chainid|wrong network/i.test(message)
}

/**
 * EIP-3326 + EIP-3085.
 *
 * Switch to the chain; if the wallet does not know it, ask the wallet to add it (that is the
 * "add network" prompt) and switch again. Done against the provider directly rather than through a
 * client wrapper, because the add prompt must be a real wallet request with the exact chain
 * parameters — and because some wallets reject an add whose chainId is not the current one, which
 * the wrapper cannot explain.
 */
export async function ensureChain(
  provider: Eip1193Provider,
  chain: Chain,
  explorer?: string,
): Promise<void> {
  const chainId = hexId(chain)
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
    return
  } catch (error) {
    if (!isUnknownChain(error)) throw error
  }
  await provider.request({
    method: 'wallet_addEthereumChain',
    params: [addChainParams(chain, explorer)],
  })
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
}
