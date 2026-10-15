'use client'

import type { RadarTrove } from '@/lib/types'
import { fmtBps, fmtBtc, fmtMusd, fmtWadPct, shortAddress } from '@/lib/format'
import { bandOf } from './scale'

/** Dense monospace ledger of the troves nearest the redemption tail. */
export function TrovesTable({
  rows,
  selected,
  connected,
  onSelect,
  maxHeight = 360,
}: {
  rows: RadarTrove[]
  selected: string | null
  connected: string | null
  onSelect: (row: RadarTrove) => void
  maxHeight?: number
}) {
  return (
    <div className="overflow-auto" style={{ maxHeight }}>
      <table className="ledger">
        <thead>
          <tr>
            <th className="cell-l w-[54px]">Rank</th>
            <th className="cell-l">Trove</th>
            <th>Collateral</th>
            <th>Debt</th>
            <th>ICR</th>
            <th>Rate</th>
            <th>Buffer ahead</th>
            <th className="cell-l w-[92px]">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const band = bandOf(BigInt(row.icrWad))
            const isSelected = selected === row.address
            const isConnected = connected === row.address
            return (
              <tr
                key={row.address}
                data-selectable="true"
                data-selected={isSelected}
                onClick={() => onSelect(row)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelect(row)
                  }
                }}
                aria-label={`Trove ${row.address}, ICR ${fmtWadPct(row.icrWad)}`}
              >
                <td className="cell-l text-ink-3">{row.rank}</td>
                <td className="cell-l">
                  <span className="flex items-center gap-2">
                    <span className={isConnected ? 'text-ink' : 'text-ink-2'}>
                      {shortAddress(row.address, 5)}
                    </span>
                    {isConnected ? (
                      <span className="border border-ink/40 px-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ink">
                        you
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="text-amber">{fmtBtc(row.coll)}</td>
                <td>{fmtMusd(row.debt, { fixed: 0 })}</td>
                <td className={band === 'tail' ? 'text-vermilion' : band === 'watch' ? 'text-caution' : 'text-ink'}>
                  {fmtWadPct(row.icrWad)}
                </td>
                <td className="text-ink-2">{fmtBps(row.interestRateBps)}</td>
                <td className="text-ink-2">{fmtMusd(row.redemptionBufferMusd, { fixed: 0 })}</td>
                <td className="cell-l">
                  <StatusCell band={band} liquidatable={row.liquidatable} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function StatusCell({ band, liquidatable }: { band: 'tail' | 'watch' | 'safe'; liquidatable: boolean }) {
  const tone = liquidatable ? 'vermilion' : band === 'tail' ? 'vermilion' : band === 'watch' ? 'caution' : 'muted'
  const label = liquidatable ? 'liquidatable' : band === 'tail' ? 'tail' : band === 'watch' ? 'watch' : 'buffered'
  const colorClass =
    tone === 'vermilion' ? 'text-vermilion' : tone === 'caution' ? 'text-caution' : 'text-ink-3'
  const dotClass =
    tone === 'vermilion' ? 'bg-vermilion' : tone === 'caution' ? 'bg-caution' : 'bg-ink-3'

  return (
    <span className={`flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.1em] ${colorClass}`}>
      <span className={`inline-block h-[5px] w-[5px] ${dotClass}`} />
      {label}
    </span>
  )
}
