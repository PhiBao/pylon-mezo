'use client'

import { useEffect, useRef, useState } from 'react'
import { useAccount, useChainId, useConnect, useConnectors, useDisconnect } from 'wagmi'
import { useHydrated } from '@/hooks'
import { ACTIVE_CHAIN, explorerAddress } from '@/lib/chain'
import { useSwitchToActiveChain } from '@/state/use-auto-network'
import { fmtBtc, fmtMusd, shortAddress } from '@/lib/format'
import { useWalletState } from '@/state/queries'

const Caret = () => (
  <svg viewBox="0 0 8 6" className="h-[5px] w-[8px]" aria-hidden="true">
    <path d="M0 0.5h8L4 5.5Z" fill="currentColor" />
  </svg>
)

/**
 * Compact injected-wallet connect: no hosted wallet SDK, no modal. Disconnected → one button.
 * Connected → address chip with balance, copy, explorer and disconnect.
 */
export function ConnectButton() {
  const hydrated = useHydrated()
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const connectors = useConnectors()
  const { connect, isPending, error } = useConnect()
  const { disconnect } = useDisconnect()
  const [open, setOpen] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const container = useRef<HTMLDivElement | null>(null)
  const wallet = useWalletState(address ?? null)

  // Explicit switch: EIP-3326, then EIP-3085 if the wallet does not know the chain — that is what
  // makes the wallet show its "add network" prompt instead of failing the switch silently.
  const switchToActiveChain = useSwitchToActiveChain()
  const switchNetwork = async () => {
    setSwitchError(null)
    try {
      await switchToActiveChain()
    } catch (error) {
      setSwitchError(
        (error as { message?: string })?.message?.slice(0, 160) ??
          `Could not switch to ${ACTIVE_CHAIN.name}. Add it in your wallet and try again.`,
      )
    }
  }

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (container.current && !container.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  if (!hydrated) {
    return (
      <span className="btn btn-quiet w-[186px] cursor-default" aria-hidden="true">
        Wallet
      </span>
    )
  }

  const wrongChain = isConnected && chainId !== ACTIVE_CHAIN.id

  if (!isConnected || !address) {
    const injected = connectors.filter((connector) => connector.type === 'injected')
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn border-amber/60 text-amber hover:border-amber"
          disabled={isPending || injected.length === 0}
          onClick={() => {
            const [first] = injected
            if (injected.length === 1 && first) connect({ connector: first })
            else setOpen((value) => !value)
          }}
          title={injected.length === 0 ? 'No injected wallet detected — terminal runs read-only' : undefined}
        >
          {isPending ? 'Connecting…' : injected.length === 0 ? 'Read-only' : 'Connect'}
        </button>
        {open && injected.length > 1 ? (
          <div className="plate-raised absolute right-3 top-[46px] z-30 w-[220px] py-1">
            {injected.map((connector) => (
              <button
                key={connector.uid}
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-left font-mono text-meta uppercase tracking-[0.12em] text-ink-2 hover:bg-raised hover:text-ink"
                onClick={() => {
                  connect({ connector })
                  setOpen(false)
                }}
              >
                {connector.name}
              </button>
            ))}
          </div>
        ) : null}
        {error ? (
          <span className="figure hidden text-label text-vermilion lg:inline">
            {error.message.slice(0, 48)}
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <div ref={container} className="relative flex items-center gap-2">
      {wrongChain ? (
        <button
          type="button"
          className="btn border-vermilion/60 text-vermilion"
          onClick={() => void switchNetwork()}
          title={`Switch to ${ACTIVE_CHAIN.name} (${ACTIVE_CHAIN.id})`}
        >
          Switch network
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`btn gap-2 ${wrongChain ? 'border-vermilion/60 text-vermilion' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className={`inline-block h-[6px] w-[6px] ${wrongChain ? 'bg-vermilion' : 'bg-emerald'}`} />
        <span className="figure">{shortAddress(address)}</span>
        <Caret />
      </button>

      {open ? (
        <div
          role="menu"
          className="plate absolute right-0 top-[38px] z-30 w-[268px] p-3"
        >
          <div className="flex flex-col gap-2 pb-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="etched">MUSD balance</span>
              <span className="figure text-body text-ink">
                {wallet.isLoading ? '…' : fmtMusd(wallet.data?.musdBalance.toString() ?? null)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="etched">BTC (gas)</span>
              <span className="figure text-body text-ink">
                {wallet.isLoading ? '…' : fmtBtc(wallet.data?.btcBalance.toString() ?? null)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="etched">Reserve shares</span>
              <span className="figure text-body text-ink">
                {wallet.isLoading ? '…' : fmtMusd(wallet.data?.reserveAssets.toString() ?? null)}
              </span>
            </div>
          </div>

          {switchError ? (
            <p className="pb-2 text-label leading-relaxed text-vermilion">{switchError}</p>
          ) : null}
          <div className="flex flex-col gap-1 border-t border-rule pt-3">
            <a className="link figure text-meta" href={explorerAddress(address)} target="_blank" rel="noreferrer noopener">
              View on Mezo explorer ↗
            </a>
            <button
              type="button"
              className="link figure text-left text-meta"
              onClick={() => void navigator.clipboard.writeText(address)}
            >
              Copy address
            </button>
            {wrongChain ? (
              <button
                type="button"
                className="link figure text-left text-meta text-vermilion"
                onClick={() => void switchNetwork()}
              >
                Switch to {ACTIVE_CHAIN.name} ({ACTIVE_CHAIN.id})
              </button>
            ) : null}
            <button
              type="button"
              className="link figure text-left text-meta"
              onClick={() => {
                disconnect()
                setOpen(false)
              }}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
