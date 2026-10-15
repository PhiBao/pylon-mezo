/**
 * The Pylon mark: two interlocking angular steel pylons around a vertical bitcoin-amber axis.
 * The same geometry ships as /favicon.svg, /icon.svg and /apple-icon.svg.
 */
export function PylonMark({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 29.5V11L19.5 3.5v9L9.5 18.5v11H3Z" fill="currentColor" />
      <path d="M29 29.5V11L12.5 3.5v9l10 6v11H29Z" fill="currentColor" />
      <rect x="14.5" y="1.5" width="3" height="28" fill="#F7931A" />
    </svg>
  )
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <PylonMark size={compact ? 18 : 22} className="text-ink" />
      <span className="flex flex-col leading-none">
        <span className="font-display text-[15px] font-medium uppercase tracking-[0.26em] text-ink">
          Pylon
        </span>
        {compact ? null : (
          <span className="figure mt-[3px] text-[9px] uppercase tracking-[0.18em] text-ink-3">
            Redemption terminal
          </span>
        )}
      </span>
    </span>
  )
}
