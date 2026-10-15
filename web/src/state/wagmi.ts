import { createConfig, http, injected } from 'wagmi'
import { MEZO_RPC_URL, mezoTestnet } from '@/lib/chain'

/**
 * Deliberately minimal wallet layer: injected connectors only, no hosted wallet SDK.
 *
 * The terminal must work with no wallet at all (read-only terminal mode driven by RPC reads), so
 * the connector is a convenience rather than a requirement. Self-broadcast is the only reason a
 * wallet is needed; the engine relay route can execute for wallets that cannot send EVM
 * transactions themselves.
 */
export const wagmiConfig = createConfig({
  chains: [mezoTestnet],
  connectors: [injected({ shimDisconnect: true })],
  multiInjectedProviderDiscovery: true,
  transports: {
    [mezoTestnet.id]: http(MEZO_RPC_URL, { batch: true, retryCount: 2, timeout: 15_000 }),
  },
  ssr: false,
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
