'use client'

import { useMemo } from 'react'
import type { RadarTrove } from '@/lib/types'
import { fmtBtc, fmtCompact, fmtMusd, fmtWadPct, shortAddress } from '@/lib/format'
import { BAND_LABEL, bandColor, bandOf, cushionOf, domainFrom, gridlines, icrToUnit } from './scale'

const CHART_HEIGHT = 208

/**
 * The Redemption Radar.
 *
 * A depth chart of the live `SortedTroves` queue, ordered from the tail (rank 1 — the first trove a
 * redemption touches) to the head. Height is the trove's ICR on a log axis, so the whole risk
 * region is visible at once. Hovering walks the redemption: the shaded region from the tail to the
 * cursor is exactly the MUSD that must be redeemed before that trove is touched.
 */
export function RedemptionRadar({
  rows,
  mcrWad,
  coverage,
  selected,
  connected,
  hovered,
  onHover,
  onSelect,
}: {
  rows: RadarTrove[]
  mcrWad: bigint
  coverage?: { read: number; total: number }
  selected: string | null
  connected: string | null
  hovered: number | null
  onHover: (rank: number | null) => void
  onSelect: (row: RadarTrove) => void
}) {
  const { domain, clipped } = useMemo(() => domainFrom(rows, mcrWad), [rows, mcrWad])
  const lines = useMemo(() => gridlines(domain), [domain])

  const active = hovered ? rows.find((row) => row.rank === hovered) : undefined
  const connectedRow = connected ? rows.find((row) => row.address === connected) : undefined
  const selectedRow = selected ? rows.find((row) => row.address === selected) : undefined
  const focus = active ?? selectedRow ?? connectedRow
  const focusRank = focus?.rank ?? 0
  const count = rows.length

  const xOf = (rank: number) => (count <= 1 ? 500 : ((rank - 1) / (count - 1)) * 992 + 4)
  const bandWidth = count <= 1 ? 4 : Math.max(0.8, 992 / count - 1.2)

  return (
    <div className="flex flex-col">
      {/* Fixed-height readout: the text changes on hover, so it must never wrap and grow the panel
          (that used to shift the whole chart and the table below it). */}
      <div className="flex h-[34px] items-center justify-between gap-4 overflow-hidden border-b border-rule px-3">
        <span className="etched min-w-0 flex-1 truncate">
          {focus ? (
            <>
              {BigInt(focus.redemptionBufferMusd) === 0n
                ? 'First trove a redemption touches'
                : `Redemption reaches this trove after ${fmtCompact(focus.redemptionBufferMusd)} MUSD`}
              <span className="hidden sm:inline">
                {' '}
                · survives a {(cushionOf(BigInt(focus.icrWad), mcrWad) * 100).toFixed(1)}% BTC drawdown
              </span>
            </>
          ) : (
            'Hover the strip to walk the redemption queue'
          )}
        </span>
        <span className="hidden shrink-0 items-center gap-x-4 md:flex">
          <LegendSwatch color="#E11D48" label={BAND_LABEL.tail} />
          <LegendSwatch color="#F7931A" label={BAND_LABEL.watch} />
          <LegendSwatch color="#3A4149" label={BAND_LABEL.safe} />
          <LegendSwatch color="#E8EAED" label="Your trove" />
        </span>
      </div>

      <div className="relative" style={{ height: CHART_HEIGHT }}>
        {/* y gridlines: hairlines behind the bars, labels in a reading gutter above them */}
        {lines.map((line) => (
          <span
            key={line.label}
            className="pointer-events-none absolute inset-x-0 h-px"
            style={{ bottom: line.unit * (CHART_HEIGHT - 26) + 26, background: 'rgba(42,47,56,0.7)' }}
          />
        ))}

        {/* redemption depth region: everything a redemption consumes before the focus trove */}
        {focusRank > 0 ? (
          <div
            className="pointer-events-none absolute bottom-0 top-0 border-r border-amber/40"
            style={{
              left: 0,
              width: `${((focusRank - 0.5) / Math.max(count, 1)) * 100}%`,
              background: 'linear-gradient(90deg, rgba(247,147,26,0.16), rgba(247,147,26,0.05))',
            }}
          />
        ) : null}

        {/* MCR wall */}
        <div className="pointer-events-none absolute inset-x-0 bottom-[26px] h-px bg-vermilion/70" />
        <span className="pointer-events-none absolute bottom-[30px] left-1 font-mono text-[9px] uppercase tracking-[0.12em] text-vermilion">
          MCR 110% — liquidatable below
        </span>

        <svg
          viewBox="0 0 1000 100"
          preserveAspectRatio="none"
          className="absolute inset-x-0 bottom-[26px] top-0 h-[calc(100%-26px)] w-full"
          role="img"
          aria-label={`Redemption queue: ${count} troves ordered from the 110% liquidation tail to the safest collateral.`}
        >
          {rows.map((row) => {
            const unit = icrToUnit(BigInt(row.icrWad), domain)
            const height = Math.max(1.5, unit * 100)
            const isConnected = connected !== null && row.address === connected
            const isSelected = selected !== null && row.address === selected
            const isHovered = hovered === row.rank
            const fill = isConnected ? '#E8EAED' : bandColor(bandOf(BigInt(row.icrWad)))
            const isClipped = cushionOf(BigInt(row.icrWad), mcrWad) > domain.max
            return (
              <g key={row.address}>
                <rect
                  x={xOf(row.rank)}
                  y={100 - height}
                  width={bandWidth}
                  height={height}
                  fill={fill}
                  opacity={isConnected ? 1 : isSelected || isHovered ? 1 : row.liquidatable ? 0.95 : 0.8}
                  className="cursor-pointer transition-opacity duration-150"
                  onPointerEnter={() => onHover(row.rank)}
                  onPointerLeave={() => onHover(null)}
                  onClick={() => onSelect(row)}
                />
                {isClipped ? (
                  <rect
                    x={xOf(row.rank)}
                    y={0}
                    width={bandWidth}
                    height={1.6}
                    fill="#E8EAED"
                    opacity={0.7}
                    className="pointer-events-none"
                  />
                ) : null}
              </g>
            )
          })}
        </svg>

        {/* scale labels sit above the bars so the queue never hides its own axis */}
        {lines.map((line) => (
          <span
            key={`label-${line.label}`}
            className="pointer-events-none absolute right-1 -translate-y-1/2 bg-canvas px-1.5 figure text-[9px] text-ink-3"
            style={{ bottom: line.unit * (CHART_HEIGHT - 26) + 26 }}
          >
            {line.label}
          </span>
        ))}

        {/* connected trove marker: a pulsing ring, the only motion in the radar */}
        {connectedRow ? (
          <div
            className="pointer-events-none absolute bottom-[26px]"
            style={{ left: `${xOf(connectedRow.rank) / 10}%` }}
            aria-hidden="true"
          >
            <div className="h-2 w-2 -translate-x-1/2 translate-y-1/2 animate-tick-pulse border border-ink bg-canvas" />
          </div>
        ) : null}

        {/* readout for the focused trove */}
        {focus ? (
          <div className="pointer-events-none absolute left-3 top-2 flex max-w-[min(560px,90%)] flex-wrap items-baseline gap-x-4 gap-y-1 plate-raised px-2.5 py-1.5">
            <span className="figure text-meta text-ink-3">#{focus.rank}</span>
            <span className="figure text-meta text-ink">{shortAddress(focus.address)}</span>
            <span className="figure text-meta text-amber">{fmtWadPct(focus.icrWad)}</span>
            <span className="figure text-meta text-ink-2">{fmtBtc(focus.coll)}</span>
            <span className="figure text-meta text-ink-2">{fmtMusd(focus.debt, { fixed: 0 })}</span>
            {focus.liquidatable ? (
              <span className="figure text-meta text-vermilion">liquidatable</span>
            ) : null}
            {connected !== null && focus.address === connected ? (
              <span className="figure text-meta text-ink">your trove</span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* x axis: rank order + coverage */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-rule px-3 py-2">
        <span className="figure text-label text-ink-3">TAIL · rank 1 · redeemed first</span>
        <span className="figure text-label text-ink-3">
          bar height · BTC drawdown absorbed before the 110% MCR
          {clipped > 0 ? ` · ${clipped} above ${(domain.max * 100).toFixed(0)}%` : ''}
        </span>
        <span className="figure text-label text-ink-2">
          {coverage && coverage.read < coverage.total
            ? `coverage ${coverage.read} of ${coverage.total} troves`
            : `${count} troves in view`}
        </span>
        <span className="figure text-label text-ink-3">HEAD · rank {coverage?.total ?? count} · safe</span>
      </div>
    </div>
  )
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="figure flex items-baseline gap-1.5 text-label text-ink-3">
      <span className="inline-block h-[8px] w-[3px]" style={{ background: color }} />
      {label}
    </span>
  )
}
