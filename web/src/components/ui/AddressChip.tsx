'use client'

import { useCopy } from '@/hooks'
import { explorerAddress, explorerTx } from '@/lib/chain'
import { shortAddress, shortHash } from '@/lib/format'

const ExternalGlyph = () => (
  <svg viewBox="0 0 12 12" className="h-[10px] w-[10px]" aria-hidden="true">
    <path
      d="M4.5 2H2v8h8V7.5M7 2h3v3M10 2 5.5 6.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="square"
    />
  </svg>
)

const CopyGlyph = ({ copied }: { copied: boolean }) =>
  copied ? (
    <svg viewBox="0 0 12 12" className="h-[10px] w-[10px]" aria-hidden="true">
      <path d="M2 6.5 4.5 9 10 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
    </svg>
  ) : (
    <svg viewBox="0 0 12 12" className="h-[10px] w-[10px]" aria-hidden="true">
      <rect x="1.5" y="1.5" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4.5 10.5h6v-6" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )

/**
 * Address/hash display: shortened for scanning, click-to-copy for use, and always paired with an
 * explorer link so any claim in this terminal can be checked independently.
 */
export function AddressChip({
  address,
  kind = 'address',
  label,
  size = 4,
}: {
  address: string
  kind?: 'address' | 'tx'
  label?: string
  size?: number
}) {
  const { state, copy } = useCopy()
  const href = kind === 'tx' ? explorerTx(address) : explorerAddress(address)
  const text = kind === 'tx' ? shortHash(address) : shortAddress(address, size)

  return (
    <span className="inline-flex items-center gap-1.5">
      {label ? <span className="etched">{label}</span> : null}
      <button
        type="button"
        onClick={() => copy(address)}
        className="figure chip chip-link h-[20px] gap-1.5 text-meta text-ink-2"
        title={`Copy ${address}`}
        aria-label={`Copy ${address}`}
      >
        {text}
        <CopyGlyph copied={state === 'copied'} />
      </button>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-ink-3 transition-colors hover:text-amber"
        title="Open in Mezo explorer"
        aria-label="Open in Mezo explorer"
      >
        <ExternalGlyph />
      </a>
    </span>
  )
}

export function HashLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label ? <span className="etched">{label}</span> : null}
      <a
        href={explorerTx(hash)}
        target="_blank"
        rel="noreferrer noopener"
        className="figure text-meta text-amber underline decoration-rule-3 underline-offset-2 transition-colors hover:decoration-amber"
      >
        {shortHash(hash)}
      </a>
      <ExternalGlyph />
    </span>
  )
}
