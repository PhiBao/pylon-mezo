import type { ReactNode } from 'react'

/** Hairline-bounded working plane. Panels are structural: they carry content, not decoration. */
export function Panel({
  label,
  meta,
  children,
  className = '',
  bodyClassName = '',
}: {
  label: string
  meta?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={`plate flex min-w-0 flex-col ${className}`}>
      <header className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-rule px-3">
        <span className="etched truncate">{label}</span>
        <div className="flex shrink-0 items-center gap-2">{meta}</div>
      </header>
      <div className={`min-w-0 flex-1 px-3 py-3 ${bodyClassName}`}>{children}</div>
    </section>
  )
}

/** Etched label + value row used by every spec-style readout in the terminal. */
export function SpecRow({
  label,
  value,
  hint,
  tone = 'default',
  emphasis = false,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'default' | 'muted' | 'amber' | 'vermilion' | 'emerald' | 'caution'
  emphasis?: boolean
}) {
  const toneClass =
    tone === 'amber'
      ? 'text-amber'
      : tone === 'vermilion'
        ? 'text-vermilion'
        : tone === 'emerald'
          ? 'text-emerald'
          : tone === 'caution'
            ? 'text-caution'
            : tone === 'muted'
              ? 'text-ink-2'
              : 'text-ink'

  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 py-[5px]">
      <span className="etched shrink-0">{label}</span>
      <span className="flex min-w-0 items-baseline gap-2 text-right">
        {hint ? <span className="figure text-meta text-ink-3 truncate">{hint}</span> : null}
        <span
          className={`figure text-body ${toneClass} ${emphasis ? 'font-medium' : ''} truncate`}
        >
          {value}
        </span>
      </span>
    </div>
  )
}

/** Label above value — the instrument bar readout. */
export function Readout({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'default' | 'muted' | 'amber' | 'vermilion' | 'emerald' | 'caution'
}) {
  const toneClass =
    tone === 'amber'
      ? 'text-amber'
      : tone === 'vermilion'
        ? 'text-vermilion'
        : tone === 'emerald'
          ? 'text-emerald'
          : tone === 'caution'
            ? 'text-caution'
            : tone === 'muted'
              ? 'text-ink-2'
              : 'text-ink'

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="etched truncate">{label}</span>
      <span className={`figure text-[13px] leading-none ${toneClass}`}>{value}</span>
      {hint ? <span className="figure text-label text-ink-3 truncate">{hint}</span> : null}
    </div>
  )
}

