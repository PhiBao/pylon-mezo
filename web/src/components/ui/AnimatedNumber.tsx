'use client'

import { useAnimatedValue } from '@/hooks'
import { toNumber } from '@/lib/format'

/**
 * Animates a raw on-chain integer into a formatted figure.
 *
 * The animation runs on the numeric form of the value and the formatter is applied every frame, so
 * a MUSD balance counts up through real intermediate values instead of cross-fading strings.
 */
export function AnimatedNumber({
  wei,
  decimals = 18,
  format,
  className = '',
}: {
  wei: string | bigint | null | undefined
  decimals?: number
  format: (value: bigint) => string
  className?: string
}) {
  const raw = wei === null || wei === undefined ? null : BigInt(wei)
  const target = raw === null ? 0 : toNumber(raw, decimals)
  const animated = useAnimatedValue(target)

  if (raw === null) {
    return <span className={className}>—</span>
  }

  const scale = 10 ** decimals
  const value = BigInt(Math.max(0, Math.round(animated * scale)))
  return (
    <span className={className} title={format(raw)}>
      {format(value)}
    </span>
  )
}

/** Animates plain numbers (percentages, counts, ratios already in human units). */
export function AnimatedScalar({
  value,
  format,
  className = '',
}: {
  value: number | null
  format: (value: number) => string
  className?: string
}) {
  const animated = useAnimatedValue(value ?? 0)
  if (value === null) return <span className={className}>—</span>
  return <span className={className}>{format(animated)}</span>
}
