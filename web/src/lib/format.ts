/**
 * One module owns every figure the terminal prints.
 *
 * Formatting is intentionally deterministic — no `Intl` / locale lookups — so a table renders
 * identically in SSR, in the browser, and in a screenshot. Values are always fed in as raw
 * on-chain integers (wei / wad) and never shown raw:
 *
 *   987650000000000000000     → "987.65 MUSD"
 *   45100000000000000         → "0.0451 BTC"
 *   1724000000000000000       → "172.4%"
 *   1850000000000000000       → "1.85×"
 *   20                        → "0.20%"
 */

export type Source = string | bigint | number | null | undefined

const numeric = (value: Source): bigint | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.trunc(value)) : null
  const trimmed = value.trim()
  if (!/^-?\d+$/.test(trimmed)) return null
  return BigInt(trimmed)
}

const groupDigits = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const splitUnits = (value: bigint, decimals: number) => {
  const negative = value < 0n
  const abs = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = (abs / base).toString()
  const frac = (abs % base).toString().padStart(decimals, '0')
  return { negative, whole, frac }
}

const trimFrac = (frac: string, min: number, max: number): string => {
  let out = frac.slice(0, max)
  while (out.length > min && out.endsWith('0')) out = out.slice(0, -1)
  return out
}

interface Precision {
  /** decimals kept when the value is below 1 (default 4) */
  small?: number
  /** decimals kept for values in [1, 1000) (default 2) */
  normal?: number
  /** minimum decimals even if they are zeros (default 2) */
  min?: number
  /** always round to this many decimals, disabling the adaptive ladder */
  fixed?: number
}

/** Adaptive decimal ladder: small amounts keep precision, large ones stay scannable. */
export const formatUnits = (value: bigint, decimals = 18, precision: Precision = {}): string => {
  const { negative, whole, frac } = splitUnits(value, decimals)
  const normal = precision.normal ?? 2
  const small = precision.small ?? 4
  const min = precision.fixed ?? precision.min ?? 2
  let keep: number
  if (precision.fixed !== undefined) keep = precision.fixed
  else if (whole === '0') keep = small
  else if (whole.length <= 3) keep = normal
  else keep = Math.min(normal, 2)
  const digits = trimFrac(frac, min, Math.max(keep, min))
  const body = digits.length > 0 ? `${groupDigits(whole)}.${digits}` : groupDigits(whole)
  return negative && /[1-9]/.test(body) ? `-${body}` : body
}

/** Same as `formatUnits` but tolerant of API payloads that arrive as strings / numbers. */
export const fmtUnits = (value: Source, decimals = 18, precision: Precision = {}): string => {
  const v = numeric(value)
  if (v === null) return '—'
  return formatUnits(v, decimals, precision)
}

/** Exact decimal expansion, no grouping or rounding — used for copy-to-clipboard. */
export const rawDecimal = (value: Source, decimals = 18): string => {
  const v = numeric(value)
  if (v === null) return ''
  const { negative, whole, frac } = splitUnits(v, decimals)
  const trimmed = frac.replace(/0+$/, '')
  const body = trimmed.length > 0 ? `${whole}.${trimmed}` : whole
  return negative ? `-${body}` : body
}

export const toNumber = (value: Source, decimals = 18): number => {
  const v = numeric(value)
  if (v === null) return Number.NaN
  return Number(rawDecimal(v, decimals))
}

/** MUSD amounts: fees and dust keep 3-6 decimals, balances stay scannable. */
export const fmtMusd = (value: Source, precision: Precision = {}): string =>
  `${fmtUnits(value, 18, precision)} MUSD`

/** BTC amounts: sub-millibitcoin legs need more significant digits than balances. */
export const fmtBtc = (value: Source, precision: Precision = {}): string =>
  `${fmtUnits(value, 18, { small: 6, normal: 4, min: 4, ...precision })} BTC`

export const fmtUsd = (value: Source, precision: Precision = { fixed: 2 }): string =>
  `$${fmtUnits(value, 18, precision)}`

/** wad (1e18 = 100%) → percent. Above 1000% we stop pretending decimal precision matters. */
export const fmtWadPct = (value: Source, precision: Precision = {}): string => {
  const v = numeric(value)
  if (v === null) return '—'
  const percent = v / 10n ** 16n // 1e18 wad → percent with two decimals of headroom
  const fixed = precision.fixed ?? (percent >= 1_000n ? 0 : 1)
  return `${formatUnits(v, 16, { ...precision, fixed })}%`
}

/**
 * Position leverage implied by a collateralisation ratio: lev = 1 / (1 − 1/ICR).
 * 172.4% → "1.38×", 300% → "1.50×", and it collapses toward 1× as the trove gets safer.
 */
export const fmtLeverageFromIcr = (icrWad: Source): string => {
  const icr = toNumber(icrWad, 18)
  if (!Number.isFinite(icr) || icr <= 1) return '—'
  return `${(1 / (1 - 1 / icr)).toFixed(2)}×`
}

export const fmtBps = (bps: Source, precision: Precision = { fixed: 2 }): string => {
  const v = numeric(bps)
  if (v === null) return '—'
  return `${formatUnits(v, 2, precision)}%`
}

export const fmtInt = (value: Source): string => {
  const v = numeric(value)
  if (v === null) return '—'
  return groupDigits(v.toString())
}

const SUFFIXES: Array<{ threshold: bigint; suffix: string; decimals: number }> = [
  { threshold: 10n ** 27n, suffix: 'S', decimals: 27 },
  { threshold: 10n ** 24n, suffix: 'M', decimals: 24 },
  { threshold: 10n ** 21n, suffix: 'K', decimals: 21 },
]

/** Compact magnitude for narrow readouts: 102591762… → "102.6M". */
export const fmtCompact = (value: Source, dp = 1): string => {
  const v = numeric(value)
  if (v === null) return '—'
  const abs = v < 0n ? -v : v
  for (const { threshold, suffix, decimals } of SUFFIXES) {
    if (abs >= threshold) return `${formatUnits(v, decimals, { fixed: dp })}${suffix}`
  }
  return formatUnits(v, 18, { fixed: abs > 0n && abs < 10n ** 18n ? 4 : dp })
}

export const shortAddress = (address: string | null | undefined, size = 4): string => {
  if (!address) return '—'
  if (address.length <= size * 2 + 2) return address
  return `${address.slice(0, 2 + size)}\u2026${address.slice(-size)}`
}

export const shortHash = (hash: string | null | undefined, head = 6, tail = 4): string => {
  if (!hash) return '—'
  return `${hash.slice(0, 2 + head)}\u2026${hash.slice(-tail)}`
}

/** Timestamp → "3m ago" / "2h ago" / "14 Oct 12:04Z". Deterministic, UTC-based. */
export const fmtAge = (timestamp: number | null | undefined, now = Date.now()): string => {
  if (!timestamp) return '—'
  const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp
  const diff = Math.max(0, now - ms)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * User input → wei. Returns null (never a partial value) when the text is not a plain decimal with
 * at most `decimals` fraction digits, so callers can disable an action instead of guessing.
 */
export const parseAmount = (input: string, decimals = 18): bigint | null => {
  const text = input.trim().replace(/,/g, '')
  if (text === '' || text === '.' || text === '-') return null
  if (!/^\d*\.?\d*$/.test(text)) return null
  const [whole = '', frac = ''] = text.split('.')
  if (frac.length > decimals) return null
  const padded = frac.padEnd(decimals, '0')
  try {
    return BigInt(`${whole === '' ? '0' : whole}${padded}`)
  } catch {
    return null
  }
}

/** mulDiv that never overflows for the magnitudes in this product. */
export const mulDiv = (a: bigint, b: bigint, denominator: bigint): bigint => {
  if (denominator === 0n) return 0n
  return (a * b) / denominator
}
