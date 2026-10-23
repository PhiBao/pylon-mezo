'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { ConnectButton } from './ConnectButton'
import { DemoSignerButton } from './DemoSignerButton'
import { DEMO_SIGNER_ENABLED } from '@/state/demo-signer'
import { useAutoNetwork } from '@/state/use-auto-network'
import { Wordmark } from './Wordmark'
import { ACTIVE_CHAIN, EXPLORER_URL, IS_MAINNET, NETWORK_LABEL } from '@/lib/chain'
import { useRuntimeConfig } from '@/state/queries'

const NAV = [
  { href: '/', label: 'Terminal' },
  { href: '/reserve', label: 'Reserve' },
  { href: '/proofs', label: 'Proofs' },
  { href: '/docs', label: 'Docs' },
]

/** Data-provenance pill: the header always states where the numbers come from. */
function SourcePill() {
  const config = useRuntimeConfig()
  const source = config.data?.source
  const label = source === 'engine' ? 'Engine API' : source === 'rpc' ? 'RPC read-only' : 'Resolving…'
  const tone = source === 'engine' ? 'text-emerald' : source === 'rpc' ? 'text-caution' : 'text-ink-3'

  return (
    <span className="chip hidden lg:inline-flex" title={config.data?.note ?? 'Pylon engine API'}>
      <span className={`inline-block h-[5px] w-[5px] ${source === 'engine' ? 'bg-emerald' : 'bg-caution'}`} />
      <span className={tone}>{label}</span>
    </span>
  )
}

function NetworkSwitch() {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (container.current && !container.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Each network is its own prerendered bundle (/ and /mainnet/), so switching is a navigation:
  // the contract set, explorer and RPC all follow the selection. The chip opens a menu instead of
  // hiding the second network behind a link people do not notice.
  const networks = [
    {
      label: 'Mezo Testnet',
      id: 31611,
      href: '/',
      detail: 'Engine API · full product',
      active: !IS_MAINNET,
    },
    {
      label: 'Mezo mainnet',
      id: 31612,
      href: '/mainnet/',
      detail: 'RPC reads · live contracts',
      active: IS_MAINNET,
    },
  ]

  return (
    <div className="relative" ref={container}>
      <button
        type="button"
        className="chip chip-link"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch network"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`inline-block h-[5px] w-[5px] ${IS_MAINNET ? 'bg-emerald' : 'bg-amber'}`} />
        <span className="hidden sm:inline">{NETWORK_LABEL}</span>
        <span className="text-ink-3">{ACTIVE_CHAIN.id}</span>
        <svg viewBox="0 0 8 6" className="h-[5px] w-[8px] text-ink-3" aria-hidden="true">
          <path d="M0 0.5h8L4 5.5Z" fill="currentColor" />
        </svg>
      </button>

      {open ? (
        <div className="plate-raised absolute left-0 top-[32px] z-30 w-[310px] py-1" role="menu" aria-label="Network">
          {networks.map((network) => (
            <a
              key={network.id}
              href={network.href}
              role="menuitemradio"
              aria-checked={network.active}
              onClick={() => setOpen(false)}
              className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-raised ${
                network.active ? 'text-ink' : 'text-ink-2'
              }`}
            >
              <span className="flex flex-col gap-0.5">
                <span className="figure text-meta">{network.label}</span>
                <span className="text-label text-ink-3">{network.detail}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="figure text-label text-ink-3">{network.id}</span>
                {network.active ? (
                  <svg viewBox="0 0 12 12" className="h-[11px] w-[11px] text-emerald" aria-hidden="true">
                    <path d="M1.5 6.5 4.5 9.5 10.5 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
                  </svg>
                ) : (
                  <span className="text-label text-ink-3">switch</span>
                )}
              </span>
            </a>
          ))}
          <p className="border-t border-rule px-3 py-2 text-label leading-relaxed text-ink-3">
            Each network is its own build: addresses, explorer and RPC follow the selection.
          </p>
        </div>
      ) : null}
    </div>
  )
}

function VerifiedChip() {
  return (
    <a
      href={EXPLORER_URL}
      target="_blank"
      rel="noreferrer noopener"
      className="chip chip-link hidden xl:inline-flex"
      title={`Every figure and proof in this terminal resolves to ${NETWORK_LABEL}`}
    >
      <svg viewBox="0 0 12 12" className="h-[9px] w-[9px] text-emerald" aria-hidden="true">
        <path d="M1.5 6.5 4.5 9.5 10.5 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
      </svg>
      <span className="text-emerald">Verified on {NETWORK_LABEL}</span>
    </a>
  )
}

export function AppHeader() {
  const pathname = usePathname()
  useAutoNetwork()

  return (
    <header className="sticky top-0 z-20 border-b border-rule bg-canvas">
      <div className="mx-auto flex h-[52px] max-w-[1560px] items-center gap-3 px-3">
        <Link href="/" aria-label="Pylon terminal home" className="shrink-0">
          <Wordmark />
        </Link>
        <span className="h-6 w-px bg-rule" aria-hidden="true" />
        <NetworkSwitch />
        <VerifiedChip />

        <nav className="ml-1 hidden items-center gap-0 md:flex" aria-label="Sections">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="nav-link"
              data-active={pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <SourcePill />
          {DEMO_SIGNER_ENABLED ? <DemoSignerButton /> : null}
          <ConnectButton />
        </div>
      </div>

      <nav className="flex items-center overflow-x-auto border-t border-rule md:hidden" aria-label="Sections">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="nav-link h-10"
            data-active={pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  )
}
