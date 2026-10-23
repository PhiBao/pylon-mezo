'use client'

import { useMemo, useState } from 'react'
import { NETWORK_LABEL } from '@/lib/chain'
import type { Address } from 'viem'
import { Badge } from '@/components/ui/StateBlock'
import { Panel, SpecRow } from '@/components/ui/Panel'
import { StateBlock } from '@/components/ui/StateBlock'
import { fmtCompact, fmtInt, fmtMusd, fmtWadPct } from '@/lib/format'
import type { RadarTrove } from '@/lib/types'
import { useMarket, useRadar, useRuntimeConfig, useTrove } from '@/state/queries'
import { useTerminal } from '@/state/terminal-context'
import { RedemptionRadar } from './RedemptionRadar'
import { TroveInspector } from './TroveInspector'
import { TrovesTable } from './TrovesTable'

/**
 * Left column of the terminal: the live redemption queue, the trove ledger, and the inspector that
 * turns a row into an executable position.
 */
export function RadarPanel({ limit, connectedAddress }: { limit: number; connectedAddress: Address | null }) {
  const radar = useRadar(limit)
  const market = useMarket()
  const config = useRuntimeConfig()
  const { selectedTrove, focusTrove } = useTerminal()
  const [hovered, setHovered] = useState<number | null>(null)

  const payload = radar.data?.value
  const progressRows = radar.progress?.rows ?? []
  const rows = payload?.tail.length ? payload.tail : progressRows
  const selected = selectedTrove?.address ?? null

  const detail = useTrove(selected)
  const ownTrove = useTrove(connectedAddress)

  const mcrWad = BigInt(payload?.mcrWad ?? config.data?.value.mcrWad ?? '1100000000000000000')
  const ccrWad = BigInt(config.data?.value.ccrWad ?? '1500000000000000000')
  const priceWad = market.data?.value.btcPriceWad ?? null

  const ownRow = useMemo(
    () => (connectedAddress ? rows.find((row) => row.address === connectedAddress) ?? null : null),
    [connectedAddress, rows],
  )

  const detailState: 'loading' | 'error' | 'ready' = detail.isError
    ? 'error'
    : detail.isPending && selected
      ? 'loading'
      : 'ready'

  const showEmpty = !radar.isLoading && !radar.isError && payload && payload.tail.length === 0
  const showError = radar.isError && rows.length === 0

  return (
    <Panel
      label="Redemption radar · SortedTroves"
      className="min-h-[620px]"
      bodyClassName="flex flex-col gap-0 p-0"
      meta={
        <>
          {payload ? (
            <>
              <Badge tone="neutral">TCR {fmtWadPct(payload.tcrWad)}</Badge>
              <Badge tone="neutral">{fmtInt(payload.totalTroves)} troves</Badge>
              <Badge tone="neutral">{fmtCompact(payload.redemptionQueueDepthMusd)} MUSD queue</Badge>
            </>
          ) : null}
          <Badge tone={radar.data?.source === 'engine' ? 'emerald' : 'caution'}>
            {radar.data?.source === 'engine' ? 'Engine API' : 'RPC walk'}
          </Badge>
        </>
      }
    >
      {showError ? (
        <div className="px-3 py-3">
          <StateBlock
            state="error"
            title="Queue read failed"
            detail={
              radar.error instanceof Error
                ? radar.error.message
                : 'Neither the Pylon engine API nor the Mezo RPC returned the redemption queue.'
            }
            onRetry={() => void radar.refetch()}
          />
        </div>
      ) : null}

      {!showError && rows.length === 0 ? (
        <div className="px-3 py-3">
          <StateBlock
            state="loading"
            skeletonRows={6}
            title={
              radar.progress
                ? `Walking the queue from the tail — ${radar.progress.read} of ${radar.progress.total} troves`
                : 'Loading the redemption queue'
            }
          />
        </div>
      ) : null}

      {showEmpty ? (
        <div className="px-3 py-3">
          <StateBlock
            state="empty"
            title="No troves in the redemption queue"
            detail={`SortedTroves is empty on ${NETWORK_LABEL} right now, so nothing can be redeemed against a borrow position.`}
          />
        </div>
      ) : null}

      {rows.length > 0 ? (
        <>
          <RedemptionRadar
            rows={rows}
            mcrWad={mcrWad}
            coverage={payload?.coverage}
            selected={selected}
            connected={connectedAddress}
            hovered={hovered}
            onHover={setHovered}
            onSelect={(row: RadarTrove) => focusTrove(row)}
          />

          {ownTrove.data?.value.exists && !ownRow ? (
            <p className="border-t border-rule px-3 py-2 text-body text-ink-2">
              Your trove sits outside the visible tail of the queue. Its ICR is{' '}
              <span className="figure text-ink">{fmtWadPct(ownTrove.data.value.icrWad)}</span> and it is not
              among the {rows.length} cheapest-to-redeem positions below.
            </p>
          ) : null}

          {selectedTrove && detailState !== 'ready' ? (
            <div className="border-t border-rule px-3 py-3">
              <StateBlock
                state={detailState === 'error' ? 'error' : 'loading'}
                compact
                title={detailState === 'error' ? 'Trove detail failed' : 'Reading trove detail'}
                detail={
                  detailState === 'error'
                    ? 'The row above comes from the queue scan; the per-trove read (principal, interest, hints) did not answer.'
                    : undefined
                }
                onRetry={detailState === 'error' ? () => void detail.refetch() : undefined}
              />
            </div>
          ) : null}

          {selectedTrove && detailState === 'ready' ? (
            <TroveInspector
              row={selectedTrove}
              detail={detail.data?.value ?? null}
              detailState={detailState}
              mcrWad={mcrWad}
              ccrWad={ccrWad}
              priceWad={priceWad}
              fees={{
                pylonFeeBps: market.data?.value.flashFeeBps ?? 20,
                flashPoolFeeBps: config.data?.value.flashPoolFeeBps ?? 1,
                swapFeeBps: market.data?.value.swapFeeBps ?? 4,
              }}
              minNetDebt={BigInt(config.data?.value.minNetDebt ?? '1800000000000000000000')}
              isOwn={selectedTrove.address === connectedAddress}
              onRetryDetail={() => void detail.refetch()}
            />
          ) : null}

          <div className="border-t border-rule">
            <TrovesTable
              rows={rows}
              selected={selected}
              connected={connectedAddress}
              onSelect={(row) => focusTrove(row)}
            />
          </div>

          <RadarFooter
            distribution={payload?.distribution ?? []}
            rows={rows}
            coverage={payload?.coverage}
            onRetry={() => void radar.refetch()}
            stale={radar.isError}
          />
        </>
      ) : null}
    </Panel>
  )
}

/** Distribution strip + readouts: how the whole book is stacked, not just the visible tail. */
function RadarFooter({
  distribution,
  rows,
  coverage,
  onRetry,
  stale,
}: {
  distribution: Array<{ bucket: string; count: number }>
  rows: RadarTrove[]
  coverage?: { read: number; total: number }
  onRetry: () => void
  stale: boolean
}) {
  const max = distribution.reduce((peak, entry) => Math.max(peak, entry.count), 0)
  const tailCount = rows.filter((row) => BigInt(row.icrWad) < (10n ** 18n * 125n) / 100n).length
  const tailDebt = rows
    .filter((row) => BigInt(row.icrWad) < (10n ** 18n * 125n) / 100n)
    .reduce((sum, row) => sum + BigInt(row.debt), 0n)

  return (
    <div className="grid gap-x-6 gap-y-4 border-t border-rule px-3 py-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="etched">
          ICR distribution ·{' '}
          {coverage && coverage.read < coverage.total ? `troves read (${coverage.read} of ${coverage.total})` : 'whole book'}
        </span>
        <div className="flex items-end gap-2">
          {distribution.map((entry) => (
            <div key={entry.bucket} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              <span className="figure text-label text-ink-2">{entry.count}</span>
              <div className="flex h-[36px] w-full items-end bg-canvas">
                <div
                  className="w-full"
                  style={{
                    height: `${max === 0 ? 0 : Math.max(2, (entry.count / max) * 100)}%`,
                    background: entry.bucket.startsWith('1.10') ? '#E11D48' : '#F7931A',
                    opacity: entry.bucket.startsWith('1.10') ? 0.9 : 0.55,
                  }}
                />
              </div>
              <span className="figure text-[9px] text-ink-3">{entry.bucket}</span>
            </div>
          ))}
        </div>
        <span className="etched">ICR buckets</span>
      </div>

      <div className="flex min-w-0 flex-col">
        <SpecRow label="Troves in tail ≤125%" value={fmtInt(tailCount)} tone={tailCount > 0 ? 'vermilion' : 'muted'} />
        <SpecRow label="Debt in tail" value={fmtMusd(tailDebt)} tone={tailCount > 0 ? 'vermilion' : 'muted'} />
        <SpecRow
          label="Cheapest to redeem"
          value={rows[0] ? fmtWadPct(rows[0].icrWad) : '—'}
          hint={rows[0] ? `#${rows[0].rank}` : undefined}
        />
        <div className="pt-2">
          <button type="button" className="btn btn-quiet" onClick={onRetry}>
            {stale ? 'Retry queue read' : 'Refresh queue'}
          </button>
        </div>
      </div>
    </div>
  )
}
