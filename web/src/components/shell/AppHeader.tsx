'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ConnectButton } from './ConnectButton'
import { Wordmark } from './Wordmark'
import { EXPLORER_URL } from '@/lib/chain'
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

function NetworkBadge() {
  return (
    <span className="chip" title="Mezo Testnet — chain id 31611">
      <span className="inline-block h-[5px] w-[5px] bg-amber" />
      <span className="hidden sm:inline">Mezo Testnet</span>
      <span className="text-ink-3">31611</span>
    </span>
  )
}

function VerifiedChip() {
  return (
    <a
      href={EXPLORER_URL}
      target="_blank"
      rel="noreferrer noopener"
      className="chip chip-link hidden xl:inline-flex"
      title="Every figure and proof in this terminal resolves to Mezo Testnet"
    >
      <svg viewBox="0 0 12 12" className="h-[9px] w-[9px] text-emerald" aria-hidden="true">
        <path d="M1.5 6.5 4.5 9.5 10.5 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
      </svg>
      <span className="text-emerald">Verified on Mezo Testnet</span>
    </a>
  )
}

export function AppHeader() {
  const pathname = usePathname()

  return (
    <header className="sticky top-0 z-20 border-b border-rule bg-canvas">
      <div className="mx-auto flex h-[52px] max-w-[1560px] items-center gap-3 px-3">
        <Link href="/" aria-label="Pylon terminal home" className="shrink-0">
          <Wordmark />
        </Link>
        <span className="h-6 w-px bg-rule" aria-hidden="true" />
        <NetworkBadge />
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
