'use client'

import { useState } from 'react'
import { SpecRow } from '@/components/ui/Panel'
import { StateBlock } from '@/components/ui/StateBlock'
import { api, describeError } from '@/lib/api'
import { fmtBps, fmtBtc, fmtMusd, fmtUsd, fmtWadPct } from '@/lib/format'
import { useExitQuote } from '@/state/queries'
import { ActionBar, type Guard } from './ActionBar'
import { ExecutionXRay, type XRayLeg } from './ExecutionXRay'
import { collateralValue, maxUnwindRepay, venueDeviationBps, venueRate, type FeeModel } from './limits'
import { poolRateFrom, type ArchitectSharedProps } from './types'

/**
 * Flash Exit — closes the trove completely with no MUSD in the wallet.
 *
 * The venue flashes the outstanding debt minus Mezo's gas compensation, the trove's own collateral
 * buys that MUSD back, the trove closes, and what is left of the collateral plus the released gas
 * compensation lands in the wallet.
 */
export function ExitControls({
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
  const [buildError, setBuildError] = useState<string | null>(null)
  const quote = useExitQuote(owner, troveState)
  const data = quote.data ?? null
  const price = market ? BigInt(market.btcPriceWad) : null

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

  const fees: FeeModel = {
    pylonFeeBps: market ? market.flashFeeBps : config.flashFeeBps,
    flashPoolFeeBps: config.flashPoolFeeBps,
    swapFeeBps: market ? market.swapFeeBps : config.swapPoolFeeBps,
    marginBps: 5,
    poolRateWad: poolRateFrom(market),
  }
  const collValue = collateralValue(troveState.coll, price)
  const icr = (collValue * 10n ** 18n) / troveState.debt
  const btcIn = data ? BigInt(data.btcInNeeded) : 0n
  const insufficientCollateral = data !== null && btcIn > troveState.coll

  const guards: Guard[] = []
  if (insufficientCollateral) {
    guards.push({
      level: 'block',
      message: `A flash exit needs ${fmtBtc(btcIn)} of collateral at ${fmtUsd(price)} to buy back ${fmtMusd(
        data?.debt ?? null,
      )} of debt, but the trove only holds ${fmtBtc(troveState.coll)}. Unwind what you can first, or wait for a better BTC price.`,
    })
  }
  const deviation = venueDeviationBps(fees, price)
  if (deviation !== null && deviation <= -150) {
    guards.push({
      level: 'warn',
      message: `The MUSD/BTC pool is trading ${fmtBps(Math.abs(deviation))} below the Mezo oracle (${fmtUsd(
        venueRate(fees, price),
        { fixed: 0 },
      )} per BTC), which is the dominant cost of this exit: the pool buys your BTC at that discount.`,
    })
  }
  guards.push({
    level: 'warn',
    message: `A flash exit closes the trove permanently. The alternative — a partial unwind — can retire at most ${fmtMusd(
      maxUnwindRepay({ coll: troveState.coll, debt: troveState.debt, price, fees }),
    )} of this debt before Mezo's minimum-debt floor stops it.`,
  })

  const legs: XRayLeg[] = [
    {
      index: 1,
      name: 'Flash borrow',
      amount: data ? fmtMusd(data.flashAmount) : '—',
      detail: `outstanding debt less Mezo's ${fmtMusd(config.gasCompensation, { fixed: 0 })} gas compensation`,
      tone: 'amber',
    },
    {
      index: 2,
      name: 'Swap to MUSD',
      amount: data ? fmtMusd(data.flashAmount) : '—',
      detail: data ? `sells ${fmtBtc(data.btcInNeeded)} through the MUSD/BTC pool` : undefined,
    },
    {
      index: 3,
      name: 'Close trove',
      amount: data ? fmtMusd(data.debt) : '—',
      detail: 'debt cleared in full, collateral released to the engine',
      tone: 'vermilion',
    },
    {
      index: 4,
      name: 'Return to wallet',
      amount: data ? fmtBtc(data.btcBackToOwner) : '—',
      detail: 'remaining BTC plus the released gas compensation',
      tone: 'emerald',
    },
  ]

  return (
    <>
      <div className="flex flex-col gap-3 px-3 py-3">
        <div className="flex flex-col">
          <SpecRow label="Trove" value={`${fmtBtc(troveState.coll)} · ${fmtMusd(troveState.debt)}`} tone="muted" />
          <SpecRow label="ICR now" value={fmtWadPct(icr)} tone={icr < BigInt(config.mcrWad) ? 'vermilion' : 'default'} />
          <SpecRow
            label="Debt to clear"
            value={data ? fmtMusd(data.debt) : '—'}
            hint={quote.isFetching ? 'quoting' : undefined}
          />
          <SpecRow
            label="Collateral required"
            value={data ? fmtBtc(data.btcInNeeded) : '—'}
            tone={insufficientCollateral ? 'vermilion' : 'default'}
          />
          <SpecRow label="BTC back to you" value={data ? fmtBtc(data.btcBackToOwner) : '—'} tone="amber" />
          <SpecRow label="Pylon fee" value={data ? fmtMusd(data.feeMusd) : '—'} tone="muted" />
        </div>
        <p className="text-body text-ink-2">
          No MUSD is required in the wallet: the flash venue fronts the debt, the trove&apos;s own BTC buys it
          back, and the transaction either does all of that or nothing at all.
        </p>
      </div>

      <ExecutionXRay
        legs={legs}
        post={[
          { label: 'Wallet after', value: data ? fmtBtc(data.btcBackToOwner) : '—', tone: 'amber' },
          {
            label: 'MUSD needed up front',
            value: '0.00 MUSD',
            tone: 'emerald',
          },
          { label: 'Quote source', value: data?.source === 'engine' ? 'engine service' : 'on-chain preview', tone: 'muted' },
        ]}
      />

      {quote.isError ? (
        <div className="px-3 py-2">
          <StateBlock
            state="error"
            compact
            title="Quote failed"
            detail={quote.error instanceof Error ? quote.error.message : 'The exit quote did not return.'}
            onRetry={() => void quote.refetch()}
          />
        </div>
      ) : null}

      <ActionBar
        label="Execute flash exit"
        guards={guards}
        disabledReason={
          !owner
            ? 'Connect a wallet or select a trove in the radar.'
            : quote.isFetching
              ? 'Waiting for the quote.'
              : !data
                ? 'No exit quote available for this trove.'
                : null
        }
        route={route}
        onRouteChange={onRouteChange}
        engineAvailable={engineAvailable}
        walletAvailable={walletAvailable}
        state={execution.state}
        onReset={execution.reset}
        onRun={() => {
          if (!owner) return
          setBuildError(null)
          if (route === 'engine' && engineAvailable) {
            void api
              .buildExit({ owner })
              .then((build) =>
                execution.runExit(
                  { owner, typedData: build.typedData, txTemplate: build.txWithSignatureTemplate },
                  'engine',
                ),
              )
              .catch((error: unknown) => setBuildError(describeError(error)))
            return
          }
          void execution.runExit({ owner }, 'wallet')
        }}
      />

      {buildError ? (
        <div className="px-3 pb-3">
          <StateBlock
            state="error"
            compact
            title="Engine could not assemble this exit"
            detail={`${buildError} — switch the broadcast route to Self-broadcast to send it from your wallet instead.`}
          />
        </div>
      ) : null}
    </>
  )
}
