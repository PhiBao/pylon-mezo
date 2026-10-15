'use client'

import type { ReactNode } from 'react'

export type Tone = 'neutral' | 'amber' | 'vermilion' | 'emerald' | 'caution' | 'danger'

const toneClasses: Record<Tone, string> = {
  neutral: 'text-ink-2 border-rule-2',
  amber: 'text-amber border-amber/45',
  vermilion: 'text-vermilion border-vermilion/50',
  emerald: 'text-emerald border-emerald/45',
  caution: 'text-caution border-caution/45',
  danger: 'text-danger border-danger/50',
}

export function Badge({
  children,
  tone = 'neutral',
  className = '',
  title,
}: {
  children: ReactNode
  tone?: Tone
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={`chip ${toneClasses[tone]} ${className}`}
      style={{ background: 'transparent' }}
    >
      {children}
    </span>
  )
}

/**
 * Loading / empty / error surface. Every panel in this terminal has all three states, and the error
 * state always offers a retry — no panel is allowed to spin forever.
 */
export function StateBlock({
  state,
  title,
  detail,
  onRetry,
  retryLabel = 'Retry',
  skeletonRows = 3,
  compact = false,
}: {
  state: 'loading' | 'empty' | 'error'
  title: string
  detail?: ReactNode
  onRetry?: () => void
  retryLabel?: string
  skeletonRows?: number
  compact?: boolean
}) {
  if (state === 'loading') {
    return (
      <div className={`flex flex-col gap-2 ${compact ? 'py-2' : 'py-4'}`} role="status" aria-live="polite">
        {Array.from({ length: skeletonRows }).map((_, index) => (
          <div key={index} className="relative h-[10px] w-full overflow-hidden bg-raised">
            <div
              className="absolute inset-y-0 w-1/3 animate-sweep"
              style={{ background: 'linear-gradient(90deg, transparent, #1F232B, transparent)' }}
            />
          </div>
        ))}
        <span className="etched mt-1">{title}</span>
      </div>
    )
  }

  if (state === 'empty') {
    return (
      <div className={`flex flex-col gap-2 ${compact ? 'py-2' : 'py-4'}`}>
        <span className="etched">{title}</span>
        {detail ? <p className="max-w-[52ch] text-body text-ink-2">{detail}</p> : null}
      </div>
    )
  }

  return (
    <div className={`flex flex-col gap-2 border-l-2 border-vermilion pl-3 ${compact ? 'py-2' : 'py-3'}`}>
      <span className="etched text-vermilion">{title}</span>
      {detail ? <p className="max-w-[56ch] text-body text-ink-2">{detail}</p> : null}
      {onRetry ? (
        <button type="button" className="btn btn-quiet mt-1 self-start" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  )
}
