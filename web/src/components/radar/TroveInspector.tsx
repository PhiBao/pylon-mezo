'use client'

import { AddressChip } from '@/components/ui/AddressChip'
import { SpecRow } from '@/components/ui/Panel'
import { StateBlock } from '@/components/ui/StateBlock'
import {
  debtFloorHeadroom,
  maxUnwindRepay,
  venueDeviationBps,
  venueRate,
  type FeeModel,
} from '@/components/architect/limits'
import { fmtBps, fmtBtc, fmtMusd, fmtUsd, fmtWadPct } from '@/lib/format'
import type { RadarTrove, Trove } from '@/lib/types'
import { useTerminal } from '@/state/terminal-context'

const HEALTH_COPY: Record<Trove['healthLabel'], { label: string; className: string }> = {
  safe: { label: 'buffered', className: 'text-emerald' },
  watch: { label: 'watch', className: 'text-caution' },
  danger: { label: 'redemption tail', className: 'text-vermilion' },
}

/**
 * Inspector for a single trove.
 *
 * The point of this panel is the sentence at the bottom: how much MUSD redemption volume has to be
 * absorbed by the troves ahead before this position starts losing collateral. Everything above it is
 * the evidence for that number.
 */
export function TroveInspector({
  row,
  detail,
  detailState,
  mcrWad,
  ccrWad,
  priceWad,
  fees,
  minNetDebt,
  isOwn,
  onRetryDetail,
}: {
  row: RadarTrove
  detail: Trove | null
  detailState: 'loading' | 'error' | 'ready'
  mcrWad: bigint
  ccrWad: bigint
  priceWad: string | null
  fees: FeeModel
  minNetDebt: bigint
  isOwn: boolean
  onRetryDetail: () => void
}) {
  const { focusTrove } = useTerminal()
  const health = HEALTH_COPY[detail?.healthLabel ?? 'watch']
  const icr = BigInt(row.icrWad)
  const buffer = BigInt(row.redemptionBufferMusd)

  /**
   * What the flash unwind can actually do to this trove: the largest repayment its own collateral can
   * fund, and the ICR that repayment leaves behind. Repaying removes collateral at the same time as
   * debt, so both sides of the ratio move — the bound is collateral (see architect/limits.ts).
   */
  const unwind = (() => {
    if (priceWad === null) return null
    const coll = BigInt(row.coll)
    const debt = BigInt(row.debt)
    const price = BigInt(priceWad)
    const fundable = maxUnwindRepay({ coll, debt, price, fees })
    const floorRoom = debtFloorHeadroom(debt, minNetDebt)
    const repaying = floorRoom > 0n && floorRoom < fundable ? floorRoom : fundable
    if (repaying <= 0n) return null
    const rate = venueRate(fees, price)
    const collValue = (coll * rate) / 10n ** 18n
    const feeBps = BigInt(fees.pylonFeeBps + fees.flashPoolFeeBps + fees.swapFeeBps + (fees.marginBps ?? 5))
    const collateralSold = (repaying * (10_000n + feeBps)) / 10_000n
    const postDebt = debt - repaying
    const postCollValue = collValue - collateralSold
    const postIcr = postDebt > 0n && postCollValue > 0n ? (postCollValue * 10n ** 18n) / postDebt : 0n
    return {
      repaying,
      postDebt,
      postIcr,
      belowFloor: postDebt > 0n && postDebt < minNetDebt,
      rate,
      deviation: venueDeviationBps(fees, price),
    }
  })()

  return (
    <div className="border-t border-rule bg-raised/40">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="etched">Trove #{row.rank}</span>
          <AddressChip address={row.address} size={6} />
          {isOwn ? (
            <span className="chip border-ink/40 text-ink">Your trove</span>
          ) : null}
          <span className={`figure text-meta ${health.className}`}>{health.label}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn" onClick={() => focusTrove(row, 'unwind')}>
            Flash unwind
          </button>
          <button type="button" className="btn" onClick={() => focusTrove(row, 'loop')}>
            Flash loop
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => focusTrove(row, 'shield')}>
            Shield
          </button>
        </div>
      </div>

      <div className="grid gap-x-8 gap-y-4 px-3 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <IcrScale icrWad={icr} mcrWad={mcrWad} ccrWad={ccrWad} />
          <div className="flex flex-col">
            <SpecRow label="Collateral" value={fmtBtc(row.coll)} tone="amber" />
            <SpecRow label="Debt" value={fmtMusd(row.debt)} />
            <SpecRow label="Interest rate" value={fmtBps(row.interestRateBps)} />
            <SpecRow
              label="Nominal ICR"
              value={detail ? fmtWadPct(detail.nicr) : '—'}
              hint={detailState === 'loading' ? 'reading…' : undefined}
            />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-col">
            <SpecRow
              label="Buffer ahead"
              value={fmtMusd(row.redemptionBufferMusd)}
              hint="MUSD redeemed before this trove is touched"
              tone={buffer < 250_000n * 10n ** 18n ? 'vermilion' : 'default'}
            />
            <SpecRow label="Principal" value={detail ? fmtMusd(detail.principal) : '—'} tone="muted" />
            <SpecRow label="Accrued interest" value={detail ? fmtMusd(detail.interest) : '—'} tone="muted" />
            <SpecRow label="Queue rank" value={`#${detail?.rank ?? row.rank}`} tone="muted" />
          </div>

          {detailState === 'error' ? (
            <StateBlock
              state="error"
              compact
              title="Trove detail unavailable"
              detail="The engine API rejected this trove read; the row above still reflects the last successful queue scan."
              onRetry={onRetryDetail}
            />
          ) : null}

          {detail?.hints ? (
            <div className="flex flex-col gap-1.5">
              <span className="etched">Insertion hints (recomputed at execution)</span>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <AddressChip address={detail.hints.upper} label="upper" />
                <AddressChip address={detail.hints.lower} label="lower" />
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <p className="border-t border-rule px-3 py-3 text-body text-ink-2">
        {unwind && priceWad !== null ? (
          <>
            This trove&apos;s own collateral can fund a repayment of{' '}
            <span className="figure text-ink">{fmtMusd(unwind.repaying)}</span>, which takes the ICR from{' '}
            <span className="figure text-ink">{fmtWadPct(row.icrWad)}</span> to{' '}
            <span className="figure text-ink">{fmtWadPct(unwind.postIcr)}</span> and needs{' '}
            <span className="figure text-ink">0 MUSD</span> in the wallet — the flash venue supplies the MUSD
            and the released BTC repays it inside the same transaction.
            {unwind.belowFloor
              ? ` That leaves ${fmtMusd(unwind.postDebt)} of debt, below Mezo's ${fmtMusd(minNetDebt, { fixed: 0 })} minimum: use Flash Exit to close the trove instead of unwinding it part-way.`
              : ` It leaves ${fmtMusd(unwind.postDebt)} of debt outstanding.`}{' '}
            The ceiling is collateral, not health: this trove can only ever give up the BTC it holds, and the
            pool buys it at {fmtUsd(unwind.rate, { fixed: 0 })} per BTC rather than the oracle's{' '}
            {fmtUsd(priceWad)}{unwind.deviation !== null && unwind.deviation < -150
              ? ` — a ${fmtBps(Math.abs(unwind.deviation))} discount that dominates the cost of any unwind`
              : ''}
            .
          </>
        ) : (
          <>
            Nothing can be repaid out of this trove&apos;s collateral at the current price: its debt already
            absorbs everything the collateral is worth. A redemption of{' '}
            <span className="figure text-ink">{fmtMusd(row.redemptionBufferMusd)}</span> against the system
            would still have to absorb every cheaper-to-redeem trove ahead of it first.
            {row.liquidatable ? ' It currently sits below the 110% MCR.' : ''}
          </>
        )}
      </p>
    </div>
  )
}

/** ICR against the protocol's two thresholds: MCR (liquidatable) and CCR (recovery mode). */
function IcrScale({ icrWad, mcrWad, ccrWad }: { icrWad: bigint; mcrWad: bigint; ccrWad: bigint }) {
  const ceiling = icrWad > ccrWad * 2n ? icrWad * 5n / 4n : ccrWad * 2n
  const unit = (value: bigint) => Math.max(0, Math.min(1, Number((value * 10_000n) / ceiling) / 10_000))
  const fill = unit(icrWad)
  const tail = icrWad <= (10n ** 18n * 125n) / 100n

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="etched">Collateralisation</span>
        <span className={`figure text-lede ${tail ? 'text-vermilion' : 'text-ink'}`}>{fmtWadPct(icrWad)}</span>
      </div>
      <div className="relative h-[10px] border border-rule bg-canvas">
        <div
          className="absolute inset-y-0 left-0"
          style={{ width: `${fill * 100}%`, background: tail ? '#E11D48' : '#F7931A', opacity: 0.75 }}
        />
        <div className="absolute -top-1 -bottom-1 w-px bg-vermilion" style={{ left: `${unit(mcrWad) * 100}%` }} />
        <div className="absolute -top-1 -bottom-1 w-px bg-ink-2" style={{ left: `${unit(ccrWad) * 100}%` }} />
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="figure text-label text-vermilion">MCR {fmtWadPct(mcrWad, { fixed: 0 })}</span>
        <span className="figure text-label text-ink-3">CCR {fmtWadPct(ccrWad, { fixed: 0 })}</span>
        <span className="figure text-label text-ink-3">{fmtWadPct(ceiling, { fixed: 0 })}</span>
      </div>
    </div>
  )
}
