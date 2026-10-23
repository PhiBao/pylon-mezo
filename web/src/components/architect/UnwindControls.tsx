'use client'

import { useEffect, useMemo, useState } from 'react'
import { AmountField } from '@/components/ui/AmountField'
import { MechanicalSlider } from '@/components/ui/MechanicalSlider'
import { SpecRow } from '@/components/ui/Panel'
import { StateBlock } from '@/components/ui/StateBlock'
import { useDebounced } from '@/hooks'
import {
  fmtBps,
  fmtBtc,
  fmtLeverageFromIcr,
  fmtMusd,
  fmtUnits,
  fmtUsd,
  fmtWadPct,
  parseAmount,
} from '@/lib/format'
import { useUnwindQuote } from '@/state/queries'
import { ActionBar, type Guard } from './ActionBar'
import { ExecutionXRay, type XRayLeg } from './ExecutionXRay'
import {
  collateralValue,
  debtFloorHeadroom,
  distanceToLiquidationBps,
  liquidationPrice,
  maxUnwindRepay,
  venueDeviationBps,
  venueRate,
  type FeeModel,
} from './limits'
import { poolRateFrom, type ArchitectSharedProps } from './types'

/** Rate the swap will realise: MUSD produced per BTC sold. */
const saleRate = (quote: { musdNeeded: string; btcInNeeded: string }): bigint => {
  const btc = BigInt(quote.btcInNeeded)
  if (btc === 0n) return 0n
  return (BigInt(quote.musdNeeded) * 10n ** 18n) / btc
}

/**
 * Flash Unwind.
 *
 * Repays debt out of the trove's own collateral with zero MUSD in the wallet: the flash venue
 * supplies MUSD, the trove releases BTC, the swap repays the venue, and the remainder lands in the
 * wallet. With ICR above 100.3% the ratio *improves* as debt is repaid, so the slider's only real
 * ceiling is how much collateral the trove can give up.
 */
export function UnwindControls({
  owner,
  troveState,
  market,
  config,
  engineAvailable,
  walletAvailable,
  execution,
  route,
  onRouteChange,
}: ArchitectSharedProps) {
  const [repay, setRepay] = useState<bigint>(0n)
  const [text, setText] = useState('')

  const price = market ? BigInt(market.btcPriceWad) : null
  const poolRate = poolRateFrom(market)
  const fees: FeeModel = {
    pylonFeeBps: market ? market.flashFeeBps : config.flashFeeBps,
    flashPoolFeeBps: config.flashPoolFeeBps,
    swapFeeBps: market ? market.swapFeeBps : config.swapPoolFeeBps,
    marginBps: 5,
    poolRateWad: poolRate,
  }
  const mcrWad = BigInt(config.mcrWad)
  const minNetDebt = BigInt(config.minNetDebt)

  /**
   * The slider's ceiling is the smaller of what the collateral can fund and what keeps a valid trove:
   * emptying the debt to a few MUSD is not a deleverage, it is a trove that can only be closed.
   */
  const maxRepay = useMemo(() => {
    if (!troveState || !price) return 0n
    const fundable = maxUnwindRepay({ coll: troveState.coll, debt: troveState.debt, price, fees })
    const floorRoom = debtFloorHeadroom(troveState.debt, minNetDebt)
    return floorRoom > 0n && floorRoom < fundable ? floorRoom : fundable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [troveState?.coll, troveState?.debt, price, minNetDebt])

  useEffect(() => {
    if (repay === 0n && maxRepay > 0n) {
      const initial = maxRepay / 4n
      setRepay(initial)
      setText(fmtUnits(initial, 18, { fixed: 2 }))
    }
  }, [maxRepay, repay])

  // Debounced repayment: each quote costs two chain reads, so the slider coalesces them.
  const debouncedRepay = useDebounced(repay, 250)
  const quote = useUnwindQuote(owner, debouncedRepay > 0n ? debouncedRepay : null, troveState)
  const data = quote.data ?? null
  const resizing = debouncedRepay !== repay

  if (!troveState || !price) {
    return (
      <div className="px-3 py-3">
        <StateBlock
          state="empty"
          title="No trove loaded"
          detail="Select a trove in the Redemption Radar or connect the wallet that owns it."
        />
      </div>
    )
  }

  const collValue = collateralValue(troveState.coll, price)
  const icrNow = (collValue * 10n ** 18n) / troveState.debt
  const shareBps = troveState.debt > 0n ? Number((repay * 10_000n) / troveState.debt) : 0
  const postColl = data ? BigInt(data.postColl) : troveState.coll
  const postDebt = data ? BigInt(data.postDebt) : troveState.debt
  const postIcr = data ? BigInt(data.postIcrWad) : icrNow
  const btcBack = data ? BigInt(data.suggestedCollOut) - BigInt(data.btcInNeeded) : 0n

  const deviation = venueDeviationBps(fees, price)
  const guards: Guard[] = []
  if (deviation !== null && deviation <= -150) {
    guards.push({
      level: 'warn',
      message: `The MUSD/BTC pool is trading ${fmtBps(Math.abs(deviation))} below the Mezo oracle (${fmtUsd(
        venueRate(fees, price),
        { fixed: 0 },
      )} per BTC). This unwind sells BTC at that discount, so the collateral cost is higher than the oracle price implies.`,
    })
  }
  if (postIcr < mcrWad) {
    guards.push({
      level: 'block',
      message: `Post-unwind ICR ${fmtWadPct(postIcr)} would fall below the 110% MCR and the trove could be liquidated. Reduce the repayment.`,
    })
  }
  if (maxRepay > 0n && maxRepay === debtFloorHeadroom(troveState.debt, minNetDebt)) {
    guards.push({
      level: 'warn',
      message: `The ceiling stops at ${fmtMusd(minNetDebt, { fixed: 0 })} of remaining debt — Mezo's minimum per trove. To retire the rest, use Flash Exit and close the trove entirely.`,
    })
  }
  if (postColl === 0n && postDebt > 0n) {
    guards.push({ level: 'block', message: 'This repayment would consume the entire collateral backing the trove.' })
  }

  const legs: XRayLeg[] = [
    {
      index: 1,
      name: 'Withdraw collateral',
      amount: data ? fmtBtc(data.suggestedCollOut) : '—',
      detail: 'released from the trove to fund the repayment, no wallet MUSD required',
    },
    {
      index: 2,
      name: 'Swap to MUSD',
      amount: data ? fmtMusd(data.musdNeeded) : '—',
      detail: data
        ? `sells ${fmtBtc(data.btcInNeeded)} BTC · effective ${fmtUsd(saleRate(data), { fixed: 0 })} per BTC · pool mid ${fmtUsd(
            venueRate(fees, price),
            { fixed: 0 },
          )} · ${fmtBps(market?.swapFeeBps ?? config.swapPoolFeeBps)}`
        : 'MUSD/BTC pool · sells only what is needed',
    },
    {
      index: 3,
      name: 'Repay trove debt',
      amount: data ? fmtMusd(data.repay) : '—',
      detail: data ? `flash leg ${fmtMusd(data.musdNeeded)} repaid in the same transaction` : undefined,
      tone: 'emerald',
    },
    {
      index: 4,
      name: 'Return BTC',
      amount: data ? fmtBtc(btcBack) : '—',
      detail: 'surplus collateral swept to your wallet',
      tone: 'amber',
    },
  ]

  return (
    <>
      <div className="flex flex-col gap-4 px-3 py-3">
        <MechanicalSlider
          ariaLabel="Repayment · share of debt"
          value={Math.min(10_000, shareBps)}
          min={0}
          max={10_000}
          step={25}
          format={(value) => `${(value / 100).toFixed(2)}% of debt`}
          onChange={(value) => {
            const next = (troveState.debt * BigInt(value)) / 10_000n
            const bounded = next > maxRepay ? maxRepay : next
            setRepay(bounded)
            setText(fmtUnits(bounded, 18, { fixed: 2 }))
          }}
          captionLeft="no repayment"
          captionRight={`safe ceiling ${fmtMusd(maxRepay, { fixed: 0 })}`}
          marks={[
            { value: 0, label: '0' },
            { value: 2_500, label: '25%' },
            { value: 5_000, label: '50%' },
            { value: 7_500, label: '75%' },
            { value: 10_000, label: '100%' },
          ]}
        />

        <AmountField
          label="MUSD to repay"
          unit="MUSD"
          value={text}
          onChange={(value) => {
            setText(value)
            const parsed = parseAmount(value, 18)
            if (parsed !== null) setRepay(parsed)
          }}
          onMax={() => {
            setRepay(maxRepay)
            setText(fmtUnits(maxRepay, 18, { fixed: 2 }))
          }}
          error={
            repay > maxRepay && maxRepay > 0n
              ? `Above the safe ceiling of ${fmtMusd(maxRepay)} — the trove cannot release that much collateral`
              : repay === 0n && text !== ''
                ? 'Enter a MUSD amount'
                : null
          }
          hint="nothing is needed in the wallet: the flash venue funds this leg"
        />

        <div className="flex flex-col">
          <SpecRow label="Trove now" value={`${fmtBtc(troveState.coll)} · ${fmtMusd(troveState.debt)}`} tone="muted" />
          <SpecRow label="ICR now" value={fmtWadPct(icrNow)} tone={icrNow < mcrWad * 120n / 100n ? 'vermilion' : 'default'} />
          <SpecRow
            label="Post-unwind ICR"
            value={data ? fmtWadPct(postIcr) : '—'}
            tone={postIcr >= mcrWad ? 'emerald' : 'vermilion'}
            hint={quote.isFetching ? 'quoting' : undefined}
          />
          <SpecRow label="Post-unwind debt" value={data ? fmtMusd(postDebt) : '—'} />
          <SpecRow
            label="Position leverage"
            value={data ? fmtLeverageFromIcr(data.postIcrWad) : '—'}
            hint="collateral value ÷ equity"
            tone="muted"
          />
          <SpecRow
            label="Liquidation price after"
            value={fmtUsd(liquidationPrice(postColl, postDebt, mcrWad))}
            hint={`${fmtBps(distanceToLiquidationBps(price, liquidationPrice(postColl, postDebt, mcrWad)))} buffer`}
          />
        </div>
      </div>

      <ExecutionXRay
        legs={legs}
        post={[
          { label: 'MUSD needed up front', value: '0.00 MUSD', tone: 'emerald' },
          { label: 'BTC returned', value: data ? fmtBtc(btcBack) : '—', tone: 'amber' },
          {
            label: 'Redemption shield gained',
            value: data ? fmtMusd(data.redemptionBufferAfterMusd) : '—',
            tone: 'muted',
            hint: 'extra redemption volume before this trove is reached',
          },
          { label: 'Quote source', value: data?.source === 'engine' ? 'engine service' : 'on-chain preview', tone: 'muted' },
        ]}
        note="The engine sells exactly the BTC required for the flash repayment and the fees; everything else stays in your wallet, so a partial unwind never leaves you with a debt you cannot service."
      />

      {quote.isError ? (
        <div className="px-3 py-2">
          <StateBlock
            state="error"
            compact
            title="Quote failed"
            detail={quote.error instanceof Error ? quote.error.message : 'The unwind quote did not return.'}
            onRetry={() => void quote.refetch()}
          />
        </div>
      ) : null}

      <ActionBar
        label="Execute flash unwind"
        guards={guards}
        disabledReason={
          !owner
            ? 'Connect a wallet or select a trove in the radar.'
            : repay === 0n
              ? 'Set a repayment above zero.'
              : resizing || quote.isFetching
                ? 'Waiting for the quote.'
                : !data
                  ? 'No quote available for this repayment.'
                  : null
        }
        route={route}
        onRouteChange={onRouteChange}
        engineAvailable={engineAvailable}
        walletAvailable={walletAvailable}
        state={execution.state}
        onReset={execution.reset}
        onRun={() => {
          if (!owner || !data) return
          if (route === 'engine' && engineAvailable) {
            void execution.runUnwind(
              {
                owner,
                repay,
                collOut: BigInt(data.suggestedCollOut),
                targetIcrWad: postIcr,
                hints: null,
                postColl,
                postDebt,
              },
              'engine',
            )
            return
          }
          void execution.runUnwind(
            {
              owner,
              repay,
              collOut: BigInt(data.suggestedCollOut),
              targetIcrWad: postIcr,
              hints: null,
              postColl,
              postDebt,
            },
            'wallet',
          )
        }}
      />

    </>
  )
}
