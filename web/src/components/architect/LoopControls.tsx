'use client'

import { useMemo, useState } from 'react'
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
import type { Market } from '@/lib/types'
import { useLoopQuote } from '@/state/queries'
import { ActionBar, type Guard } from './ActionBar'
import { ExecutionXRay, type XRayLeg } from './ExecutionXRay'
import {
  collateralValue,
  distanceToLiquidationBps,
  liquidationPrice,
  maxLoopCollAdd,
  venueDeviationBps,
  type FeeModel,
} from './limits'
import { poolRateFrom, type ArchitectSharedProps } from './types'

/**
 * Rate the swap actually achieved: MUSD moved per BTC received. Quoted next to the oracle price so the
 * venue's own spread is visible instead of being buried in "0.04% fee".
 */
const venueRateFor = (musdIn: string, btcOut: string, market: Market | null): bigint => {
  const btc = BigInt(btcOut)
  const musd = BigInt(musdIn)
  if (btc === 0n) return market ? BigInt(market.btcPriceWad) : 0n
  return (musd * 10n ** 18n) / btc
}

/**
 * Flash Loop.
 *
 * A loop borrows MUSD against the trove and buys BTC with it in the same transaction, so the trove
 * ends up with more collateral and more debt but the same equity. The interesting control is
 * therefore *size*, not direction: how much of the same position to add. The honest constraint is
 * Mezo's 150% CCR — a trove at or below it cannot emit new debt without entering recovery mode, so
 * the mode blocks itself and explains the repayment needed instead of building a reverting tx.
 */
export function LoopControls({
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
  const [collAdd, setCollAdd] = useState<bigint>(0n)
  const [text, setText] = useState('')

  const price = market ? BigInt(market.btcPriceWad) : null
  const fees: FeeModel = {
    pylonFeeBps: market ? market.flashFeeBps : config.flashFeeBps,
    flashPoolFeeBps: config.flashPoolFeeBps,
    swapFeeBps: market ? market.swapFeeBps : config.swapPoolFeeBps,
    marginBps: 5,
    poolRateWad: poolRateFrom(market),
  }

  const ccrWad = BigInt(config.ccrWad)

  /**
   * Three independent ceilings decide how much collateral a loop can add:
   *   1. the CCR floor — emitting debt must not push the trove into recovery mode;
   *   2. flash venue liquidity — the borrowed MUSD comes from a finite Tigris pool;
   *   3. swap-pool depth — buying more than a few percent of the pool's BTC side would move the price
   *      against the borrower, so the terminal refuses to size a loop beyond 5% of it.
   * `limit` records which one binds, because "why can't I loop more?" is the only question this
   * control ever raises.
   */
  const limits = useMemo(() => {
    if (!troveState || !price) {
      return { max: 0n, reason: 'no trove loaded', venueMusd: 0n }
    }
    const fBps = BigInt(fees.pylonFeeBps + fees.flashPoolFeeBps + fees.swapFeeBps + (fees.marginBps ?? 5))
    const rate = poolRateFrom(market) ?? price
    const venueMusd = BigInt(market?.flashMusdReserve ?? '0')
    const ccrBound = maxLoopCollAdd({
      coll: troveState.coll,
      debt: troveState.debt,
      price,
      floorWad: ccrWad,
      fees,
    })
    // Collateral the venue can fund, in BTC wei: venueMusd·(1−f) / rate
    const venueBound =
      rate === 0n ? 0n : (venueMusd * (10_000n - fBps) * 10n ** 18n) / (10_000n * rate)
    // Never buy more than 5% of the pool's BTC side in one loop.
    const depthBound = BigInt(market?.btcReserve ?? '0') / 20n

    const candidates: Array<{ value: bigint; reason: string }> = [
      { value: ccrBound, reason: 'the 150% CCR line' },
      { value: venueBound, reason: 'flash venue liquidity' },
      { value: depthBound, reason: 'swap-pool depth' },
    ].filter((candidate) => candidate.value > 0n)

    if (candidates.length === 0) return { max: 0n, reason: 'no available capacity', venueMusd }
    const binding = candidates.reduce((smallest, candidate) =>
      candidate.value < smallest.value ? candidate : smallest,
    )
    return { max: binding.value, reason: binding.reason, venueMusd }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [troveState?.coll, troveState?.debt, price, market?.flashMusdReserve, market?.btcReserve, ccrWad])

  const maxCollAdd = limits.max

  // Quote on a debounced size: dragging the slider must not fire a read per pixel.
  const debouncedCollAdd = useDebounced(collAdd, 250)
  const quote = useLoopQuote(debouncedCollAdd > 0n ? debouncedCollAdd : null, troveState, owner)
  const data = quote.data ?? null
  const resizing = debouncedCollAdd !== collAdd

  const setAmount = (value: bigint) => {
    const bounded = value > maxCollAdd ? maxCollAdd : value
    setCollAdd(bounded)
    setText(bounded === 0n ? '' : fmtUnits(bounded, 18, { small: 6, normal: 6, min: 4 }))
  }

  // The slider works on a milli-BTC grid: fine enough for any real trove, integer-exact for quotes.
  const markFixed = maxCollAdd < 10n ** 16n ? 4 : maxCollAdd < 10n ** 17n ? 3 : 2
  const sliderValue = Number(collAdd / 10n ** 15n)
  const sliderMax = Math.max(1, Number(maxCollAdd / 10n ** 15n))

  if (!troveState || !price) {
    return (
      <div className="px-3 py-3">
        <StateBlock
          state="empty"
          title="No trove loaded"
          detail="Pick a trove in the Redemption Radar, or connect the wallet that owns the Mezo trove you want to loop."
        />
      </div>
    )
  }

  const liqBefore = liquidationPrice(troveState.coll, troveState.debt, 1_100_000_000_000_000_000n)
  const postColl = data ? BigInt(data.postColl) : troveState.coll + collAdd
  const postDebt = data ? BigInt(data.postDebt) : troveState.debt
  const postLiq = liquidationPrice(postColl, postDebt, 1_100_000_000_000_000_000n)
  const blockers: Guard[] = []

  if (maxCollAdd === 0n) {
    const required = troveState.debt - (collateralValue(troveState.coll, price) * 10n) / 15n
    blockers.push({
      level: 'block',
      message: `This trove sits at ${fmtWadPct((BigInt(troveState.coll) * price) / BigInt(troveState.debt))}, at or below the 150% CCR floor. Emitting new debt would throw it into recovery mode. Unwind ${
        required > 0n ? fmtMusd(required) : 'debt'
      } or post collateral directly before looping.`,
    })
  }
  if (data && BigInt(data.debtDelta) > BigInt(market?.flashMusdReserve ?? '0')) {
    blockers.push({
      level: 'block',
      message: `The flash venue holds ${fmtMusd(market?.flashMusdReserve ?? null)} — this loop needs ${fmtMusd(
        data.debtDelta,
      )}.`,
    })
  }
  if (data && BigInt(data.postIcrWad) < ccrWad) {
    blockers.push({
      level: 'block',
      message: `Post-loop ICR ${fmtWadPct(data.postIcrWad)} would sit below the 150% CCR line. Reduce the loop size.`,
    })
  }
  const deviation = venueDeviationBps(fees, price ?? 0n)
  if (deviation !== null && deviation <= -150) {
    blockers.push({
      level: 'warn',
      message: `The MUSD/BTC pool is trading ${fmtBps(Math.abs(deviation))} below the Mezo oracle: this loop buys BTC at that discount, which works in your favour, but the same pool prices every unwind and exit at the same discount.`,
    })
  }
  if (data && BigInt(data.postIcrWad) < ccrWad * 130n / 100n) {
    blockers.push({
      level: 'warn',
      message: `Post-loop ICR ${fmtWadPct(data.postIcrWad)} leaves little room: a single 10% BTC drawdown would put this trove under the CCR.`,
    })
  }

  const legs: XRayLeg[] = [
    {
      index: 1,
      name: 'Flash borrow',
      amount: data ? fmtMusd(data.debtDelta) : '—',
      detail: `Tigris MUSD/mUSDC · ${fmtBps(config.flashFeeBps)} Pylon + ${fmtBps(config.flashPoolFeeBps)} venue`,
      tone: 'amber',
    },
    {
      index: 2,
      name: 'Swap to BTC',
      amount: data ? fmtBtc(data.btcOut) : '—',
      detail: data
        ? `${fmtMusd(data.swapIn)} MUSD in · venue rate ${fmtUsd(venueRateFor(data.swapIn, data.btcOut, market), {
            fixed: 0,
          })} · ${fmtBps(market?.swapFeeBps ?? config.swapPoolFeeBps)}`
        : 'MUSD/BTC pool',
    },
    {
      index: 3,
      name: 'Trove adjust',
      amount: data ? `+${fmtBtc(data.collAdd)}` : '—',
      detail: data ? `debt +${fmtMusd(BigInt(data.debtDelta) + BigInt(data.borrowingFee))} incl. Mezo fee` : undefined,
    },
    {
      index: 4,
      name: 'Repay flash',
      amount: data ? fmtMusd(BigInt(data.debtDelta) + BigInt(data.flashFee)) : '—',
      detail: 'principal + venue fee, inside the same transaction',
      tone: 'muted',
    },
  ]

  const totalFees = data ? BigInt(data.pylonFee) + BigInt(data.flashFee) + BigInt(data.borrowingFee) : null

  return (
    <>
      <div className="flex flex-col gap-4 px-3 py-3">
        <MechanicalSlider
          ariaLabel="Loop size · BTC collateral added"
          value={sliderValue}
          min={0}
          max={sliderMax}
          step={1}
          format={(value) => `${(value / 1000).toFixed(3)} BTC added`}
          onChange={(value) => setAmount(BigInt(value) * 10n ** 15n)}
          disabled={maxCollAdd === 0n}
          captionLeft="no loop"
          captionRight={maxCollAdd === 0n ? 'blocked below CCR' : `max ${fmtBtc(maxCollAdd)}`}
          marks={[
            { value: 0, label: '0' },
            // Precision follows the ceiling: a 0.01 BTC trove must not label its quarter as "0.00".
            { value: Math.max(1, Math.round(sliderMax / 4)), label: fmtBtc(BigInt(Math.round(sliderMax / 4)) * 10n ** 15n, { fixed: markFixed }) },
            { value: Math.max(1, Math.round(sliderMax / 2)), label: fmtBtc(BigInt(Math.round(sliderMax / 2)) * 10n ** 15n, { fixed: markFixed }) },
            { value: sliderMax, label: fmtBtc(maxCollAdd, { fixed: markFixed }) },
          ]}
        />

        <AmountField
          label="Collateral to add"
          unit="BTC"
          value={text}
          onChange={(value) => {
            setText(value)
            const parsed = parseAmount(value, 18)
            if (parsed !== null) setCollAdd(parsed > maxCollAdd ? maxCollAdd : parsed)
          }}
          onMax={() => setAmount(maxCollAdd)}
          error={
            parseAmount(text, 18) !== null && parseAmount(text, 18)! > maxCollAdd && maxCollAdd > 0n
              ? `Capped at ${fmtBtc(maxCollAdd)} to hold the 150% CCR line`
              : text !== '' && parseAmount(text, 18) === null
                ? 'Enter a BTC amount'
                : null
          }
          hint={price ? `at ${fmtUsd(price)} per BTC` : undefined}
          disabled={maxCollAdd === 0n}
        />

        <div className="flex flex-col">
          <SpecRow label="Trove now" value={`${fmtBtc(troveState.coll)} · ${fmtMusd(troveState.debt)}`} tone="muted" />
          <SpecRow label="Size ceiling" value={fmtBtc(maxCollAdd)} hint={`set by ${limits.reason}`} tone="caution" />
          <SpecRow
            label="Venue liquidity"
            value={fmtMusd(limits.venueMusd, { fixed: 0 })}
            hint="total MUSD the flash pool holds"
            tone="muted"
          />
          <SpecRow label="Liquidation price now" value={fmtUsd(liqBefore)} tone="muted" />
          <SpecRow
            label="Post-loop ICR"
            value={data ? fmtWadPct(data.postIcrWad) : '—'}
            hint={quote.isFetching ? 'quoting' : undefined}
            tone={data && BigInt(data.postIcrWad) < ccrWad ? 'vermilion' : 'emerald'}
          />
          <SpecRow label="Post-loop debt" value={data ? fmtMusd(data.postDebt) : '—'} />
          <SpecRow
            label="Position leverage"
            value={data ? fmtLeverageFromIcr(data.postIcrWad) : '—'}
            hint="collateral value ÷ equity"
            tone="muted"
          />
          <SpecRow
            label="Liquidation price after"
            value={fmtUsd(postLiq)}
            hint={`${fmtBps(distanceToLiquidationBps(price, postLiq))} buffer`}
          />
        </div>
      </div>

      <ExecutionXRay
        legs={legs}
        post={[
          {
            label: 'Total cost',
            value: totalFees === null ? '—' : fmtMusd(totalFees),
            tone: 'muted',
            hint: 'Pylon + venue + Mezo',
          },
          { label: 'Swap floor', value: data ? fmtMusd(data.minMusdOut) : '—', tone: 'muted' },
          {
            label: 'Quote source',
            value: data === null ? '—' : data.source === 'engine' ? 'engine service' : 'on-chain preview',
            tone: 'muted',
          },
        ]}
        note={
          data
            ? `Excess BTC from rounding is swept to your wallet at the end of the same transaction. Minimum post ICR is enforced on chain.`
            : undefined
        }
      />

      {quote.isError ? (
        <div className="px-3 py-2">
          <StateBlock
            state="error"
            compact
            title="Quote failed at this size"
            detail={
              quote.error instanceof Error && /reverted/i.test(quote.error.message)
                ? 'The engine rejected this size: either the trove cannot absorb the extra debt or the venue cannot fund it. Reduce the loop and try again.'
                : quote.error instanceof Error
                  ? quote.error.message
                  : 'The loop quote did not return.'
            }
            onRetry={() => void quote.refetch()}
          />
        </div>
      ) : null}

      <ActionBar
        label="Execute flash loop"
        guards={blockers}
        disabledReason={
          !owner
            ? 'Connect a wallet or select a trove in the radar.'
            : collAdd === 0n
              ? 'Set a loop size above zero.'
              : resizing || quote.isFetching
                ? 'Waiting for the quote.'
                : !data
                  ? 'No quote available for this size.'
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
          const hints = {
            upper: '0x0000000000000000000000000000000000000000' as const,
            lower: '0x0000000000000000000000000000000000000000' as const,
          }
          const debtAmount = BigInt(data.debtDelta)
          void execution.runLoop(
            { owner, collAdd, debtAmount, targetIcrWad: BigInt(data.postIcrWad), hints },
            route === 'engine' && engineAvailable ? 'engine' : 'wallet',
          )
        }}
      />

    </>
  )
}
