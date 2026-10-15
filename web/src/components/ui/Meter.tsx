'use client'

/** Horizontal meter with an optional limit marker (utilisation cap, MCR, …). */
export function Meter({
  valueBps,
  capBps,
  tone = 'amber',
  height = 6,
  marker,
}: {
  valueBps: number
  capBps?: number
  tone?: 'amber' | 'vermilion' | 'emerald' | 'caution'
  height?: number
  marker?: { positionBps: number; label: string }
}) {
  const clamped = Math.max(0, Math.min(10_000, valueBps))
  const fill =
    tone === 'vermilion'
      ? '#E11D48'
      : tone === 'emerald'
        ? '#10B981'
        : tone === 'caution'
          ? '#F59E0B'
          : '#F7931A'

  return (
    <div className="relative w-full" style={{ height }}>
      <div className="absolute inset-0 border border-rule bg-canvas" />
      <div className="absolute inset-y-0 left-0" style={{ width: `${clamped / 100}%`, background: fill }} />
      {capBps !== undefined ? (
        <div
          className="absolute -top-1 -bottom-1 w-px bg-ink-2"
          style={{ left: `${Math.max(0, Math.min(100, capBps / 100))}%` }}
          title={`Cap ${capBps / 100}%`}
        />
      ) : null}
      {marker ? (
        <div
          className="absolute -top-[3px] -bottom-[3px] w-px bg-ink-3"
          style={{ left: `${Math.max(0, Math.min(100, marker.positionBps / 100))}%` }}
          title={marker.label}
        />
      ) : null}
    </div>
  )
}
