'use client'

import type { ReactNode } from 'react'
import { SpecRow } from '@/components/ui/Panel'

export interface XRayLeg {
  index: number
  name: string
  amount: ReactNode
  detail?: ReactNode
  tone?: 'default' | 'amber' | 'vermilion' | 'emerald' | 'caution' | 'muted'
}

/**
 * The Atomic Execution X-Ray: the exact leg sequence the transaction will run, in order, with live
 * numbers. This is the trust surface of the product — an atomic operation should never be a black
 * box, so every leg is listed with its venue and its fee.
 */
export function ExecutionXRay({
  legs,
  post,
  note,
}: {
  legs: XRayLeg[]
  post: Array<{ label: string; value: ReactNode; tone?: 'default' | 'amber' | 'vermilion' | 'emerald' | 'caution' | 'muted'; hint?: ReactNode }>
  note?: ReactNode
}) {
  const toneClass = (tone: XRayLeg['tone']) =>
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
    <div className="flex flex-col border-t border-rule">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <span className="etched">Atomic execution x-ray</span>
        <span className="figure text-label text-ink-3">one transaction · no custody</span>
      </div>

      <ol className="flex flex-col px-3">
        {legs.map((leg, position) => (
          <li key={`${leg.index}-${leg.name}`} className="relative flex gap-3 pb-3 last:pb-2">
            {/* hairline rail connecting the legs */}
            {position < legs.length - 1 ? (
              <span className="absolute left-[7px] top-4 h-[calc(100%-8px)] w-px bg-rule" aria-hidden="true" />
            ) : null}
            <span className="relative z-10 mt-[3px] flex h-[15px] w-[15px] shrink-0 items-center justify-center border border-rule-2 bg-canvas">
              <span className="figure text-[8px] text-ink-3">{leg.index}</span>
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-baseline justify-between gap-3">
                <span className="etched">{leg.name}</span>
                <span className={`figure text-body ${toneClass(leg.tone)}`}>{leg.amount}</span>
              </span>
              {leg.detail ? <span className="figure text-label text-ink-3">{leg.detail}</span> : null}
            </span>
          </li>
        ))}
      </ol>

      <div className="border-t border-rule px-3 py-2">
        {post.map((entry) => (
          <SpecRow key={entry.label} label={entry.label} value={entry.value} tone={entry.tone} hint={entry.hint} />
        ))}
      </div>

      {note ? <div className="border-t border-rule px-3 py-2 text-body text-ink-2">{note}</div> : null}
    </div>
  )
}
