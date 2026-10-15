'use client'

import { useClock, useHydrated } from '@/hooks'
import { fmtBps, fmtCompact, fmtInt, fmtUnits, fmtWadPct } from '@/lib/format'
import { useMarket, useRuntimeConfig } from '@/state/queries'
import { AnimatedNumber, AnimatedScalar } from '@/components/ui/AnimatedNumber'
import { Readout } from '@/components/ui/Panel'

/**
 * The instrument bar: the protocol's live vitals in one ruled row. Every value here comes from a
 * real read — the engine API or, when that is down, the same numbers read directly off chain.
 */
export function InstrumentBar({
  queueDepthMusd,
  queueCoverage,
}: {
  queueDepthMusd?: string | null
  queueCoverage?: { read: number; total: number } | null
}) {
  const market = useMarket()
  const config = useRuntimeConfig()
  const hydrated = useHydrated()
  const clock = useClock()
  const data = market.data?.value
  const ccrWad = config.data?.value.ccrWad ?? '1500000000000000000'
  const belowCcr = data ? BigInt(data.tcrWad) < BigInt(ccrWad) : false

  return (
    <div className="border-b border-rule bg-panel/60">
      <div className="mx-auto flex max-w-[1560px] items-stretch overflow-x-auto">
        <Cell first>
          <Readout
            label="BTC / USD"
            tone="amber"
            value={
              data ? (
                <AnimatedNumber
                  wei={data.btcPriceWad}
                  format={(value) => `$${fmtUnits(value, 18, { fixed: 2 })}`}
                />
              ) : (
                '—'
              )
            }
            hint="Mezo price precompile"
          />
        </Cell>
        <Cell>
          <Readout
            label="System ICR"
            tone={data === undefined ? 'default' : data.recoveryMode || belowCcr ? 'caution' : 'default'}
            value={
              data ? (
                <AnimatedNumber wei={data.tcrWad} format={(value) => fmtWadPct(value)} />
              ) : (
                '—'
              )
            }
            hint={data?.recoveryMode ? 'recovery mode active' : 'CCR 150%'}
          />
        </Cell>
        <Cell>
          <Readout
            label="Redemption depth"
            value={
              queueDepthMusd ? (
                <AnimatedNumber wei={queueDepthMusd} format={(value) => `${fmtCompact(value)} MUSD`} />
              ) : data?.systemDebt ? (
                <AnimatedNumber wei={data.systemDebt} format={(value) => `${fmtCompact(value)} MUSD`} />
              ) : (
                '—'
              )
            }
            hint={
              queueCoverage
                ? `walked tail · ${queueCoverage.read} of ${queueCoverage.total} troves`
                : 'system debt'
            }
          />
        </Cell>
        <Cell>
          <Readout
            label="Flash liquidity"
            value={
              data ? (
                <AnimatedNumber
                  wei={data.flashMusdReserve}
                  format={(value) => `${fmtCompact(value)} MUSD`}
                />
              ) : (
                '—'
              )
            }
            hint="MUSD/mUSDC pool"
          />
        </Cell>
        <Cell>
          <Readout
            label="MUSD/BTC depth"
            value={data ? `${fmtCompact(data.musdReserve)} MUSD` : '—'}
            hint={data ? `${fmtUnits(data.btcReserve, 18, { small: 4, normal: 4, min: 2 })} BTC` : undefined}
          />
        </Cell>
        <Cell>
          <Readout
            label="Fees"
            value={data ? `${fmtBps(data.flashFeeBps)} · ${fmtBps(data.swapFeeBps)}` : '—'}
            hint="pylon · swap"
          />
        </Cell>
        <Cell>
          <Readout
            label="Troves"
            value={
              data ? (
                <AnimatedScalar value={data.troveCount} format={(value) => fmtInt(Math.round(value))} />
              ) : (
                '—'
              )
            }
            hint="SortedTroves size"
          />
        </Cell>
        <Cell last>
          <Readout
            label="Mezo head"
            value={data?.updatedBlock ? fmtInt(data.updatedBlock) : '—'}
            hint={hydrated ? `${clock.toISOString().slice(11, 19)} UTC` : 'UTC'}
          />
        </Cell>
      </div>
    </div>
  )
}

function Cell({ children, first = false, last = false }: { children: React.ReactNode; first?: boolean; last?: boolean }) {
  return (
    <div
      className={`flex min-w-[168px] flex-1 items-center px-4 py-3 ${first ? '' : 'border-l border-rule'} ${
        last ? 'pr-6' : ''
      }`}
    >
      {children}
    </div>
  )
}
