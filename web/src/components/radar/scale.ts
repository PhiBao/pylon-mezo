import type { RadarTrove } from '@/lib/types'

/**
 * Radar geometry.
 *
 * The queue is plotted as a risk-depth chart: x is the trove's position in `SortedTroves` walking from
 * the tail (rank 1 — the first position a redemption consumes) to the head, and bar height is the BTC
 * *drawdown the trove can absorb* before it hits the 110% MCR:
 *
 *     cushion = 1 − MCR / ICR        (0 at liquidation, → 1 as the trove becomes unbounded)
 *
 * A cushion axis is the only honest encoding here. Plotting ICR directly — linearly or in log — makes
 * a 111% trove and a 125% trove differ by a couple of pixels, because the risk region between 110%
 * and 130% is genuinely tiny on a ratio scale that has to cover troves above 10,000%. The cushion is
 * linear in the price move that can be survived, which is the unit a borrower actually manages; a
 * square root spreads the near-liquidation end so the tail does not collapse into the axis while
 * keeping the ordering obvious.
 */

const WAD = 10n ** 18n

interface DrawdownDomain {
  /** Largest absorbed drawdown on the axis, as a fraction (0.25 = 25%). */
  max: number
  mcrWad: bigint
}

const asNumber = (wad: bigint): number => Number(wad) / 1e18

/** Fraction of the current price a trove can lose before reaching the MCR. */
export const cushionOf = (icrWad: bigint, mcrWad: bigint): number => {
  const icr = asNumber(icrWad)
  const mcr = asNumber(mcrWad)
  if (!Number.isFinite(icr) || icr <= mcr || mcr <= 0) return 0
  return Math.max(0, Math.min(0.98, 1 - mcr / icr))
}

/**
 * The axis is sized from the 90th percentile of the plotted rows so a handful of very safe troves
 * cannot flatten the queue, with a 25% floor: a chart that cannot show a 25% drawdown is not useful
 * for judging risk. Rows above the axis are clamped and reported as clipped.
 */
export const domainFrom = (rows: RadarTrove[], mcrWad: bigint): { domain: DrawdownDomain; clipped: number } => {
  const cushions = rows.map((row) => cushionOf(BigInt(row.icrWad), mcrWad)).sort((a, b) => a - b)
  const index = cushions.length === 0 ? 0 : Math.min(cushions.length - 1, Math.floor(cushions.length * 0.9))
  const p90 = cushions[index] ?? 0.25
  const target = Math.min(0.9, Math.max(0.25, p90 * 1.15))
  return {
    domain: { max: target, mcrWad },
    clipped: cushions.filter((value) => value > target).length,
  }
}

/** 0 at the MCR floor (liquidatable), 1 at the top of the axis. */
export const icrToUnit = (icrWad: bigint, domain: DrawdownDomain): number => {
  const cushion = cushionOf(icrWad, domain.mcrWad)
  const unit = Math.sqrt(cushion / domain.max)
  return Math.max(0, Math.min(1, unit))
}

/** Drawdown gridlines inside the axis, each labelled with its percentage and ICR equivalent. */
export const gridlines = (domain: DrawdownDomain): Array<{ unit: number; label: string }> => {
  const candidates = [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7]
  const mcr = asNumber(domain.mcrWad)
  return candidates
    .filter((value) => value <= domain.max)
    .map((value) => ({
      unit: Math.sqrt(value / domain.max),
      label: `${(value * 100).toFixed(value < 0.1 ? 0 : 0)}% · ${((mcr / (1 - value)) * 100).toFixed(0)}% ICR`,
    }))
}

type IcrBand = 'tail' | 'watch' | 'safe'

/**
 * Risk bands are product decisions, not protocol constants:
 *   tail  ≤ 125%  — a redemption or a small price move can reach this trove
 *   watch ≤ 175%  — inside the range Mezo's own 110% MCR makes plausible
 *   safe  above   — comfortable against a single-day move
 */
export const bandOf = (icrWad: bigint): IcrBand => {
  if (icrWad <= (WAD * 125n) / 100n) return 'tail'
  if (icrWad <= (WAD * 175n) / 100n) return 'watch'
  return 'safe'
}

export const bandColor = (band: IcrBand): string =>
  band === 'tail' ? '#E11D48' : band === 'watch' ? '#F7931A' : '#3A4149'

export const BAND_LABEL: Record<IcrBand, string> = {
  tail: 'Redemption tail ≤125%',
  watch: 'Watch ≤175%',
  safe: 'Buffered >175%',
}
