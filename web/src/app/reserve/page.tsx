'use client'

import { useAccount } from 'wagmi'
import { ReservePanel } from '@/components/panels/ReservePanel'
import { SpecRow } from '@/components/ui/Panel'
import { AddressChip } from '@/components/ui/AddressChip'
import { useHydrated } from '@/hooks'
import { DEPLOYED } from '@/lib/chain'
import { fmtBps, fmtMusd, fmtUnits } from '@/lib/format'
import { useReserve } from '@/state/queries'
import type { Address } from 'viem'

export default function ReservePage() {
  const hydrated = useHydrated()
  const { address } = useAccount()
  const connectedAddress = (hydrated && address ? address : null) as Address | null
  const reserve = useReserve()
  const data = reserve.data?.value ?? null

  return (
    <div className="mx-auto max-w-[1560px] border-x border-rule">
      <header className="flex flex-col gap-3 border-b border-rule px-4 py-6">
        <span className="etched">Shield reserve</span>
        <h1 className="max-w-[46ch] text-h1 text-ink">
          A MUSD pool that repays debt before a redemption can reach collateral.
        </h1>
        <p className="max-w-[80ch] text-lede text-ink-2">
          Mezo lets any MUSD holder redeem against the lowest-ICR trove above 110%. The reserve exists to move
          shielded positions out of that queue&apos;s path: it lends MUSD that can only ever reduce a registered
          position&apos;s debt, and it cannot release that claim until the loan is settled.
        </p>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 border-b border-rule xl:border-b-0 xl:border-r">
          <ReservePanel connectedAddress={connectedAddress} />
        </div>

        <div className="flex min-w-0 flex-col">
          <section className="border-b border-rule px-4 py-4">
            <span className="etched">Mechanics</span>
            <div className="pt-2">
              <SpecRow
                label="Share price"
                value={data ? fmtUnits(data.sharePrice, 18, { fixed: 4 }) : '—'}
                hint="1.0000 at inception"
                tone="emerald"
              />
              <SpecRow label="Utilisation cap" value={data ? fmtBps(data.utilizationCapBps) : '90.00%'} tone="muted" />
              <SpecRow label="Max per defence call" value={data ? fmtMusd(data.maxLendPerCall) : '—'} tone="muted" />
              <SpecRow label="Max concurrent per position" value={data ? fmtMusd(data.maxLendPerPosition) : '—'} tone="muted" />
              <SpecRow label="Redeemability" value="idle liquidity only" tone="caution" />
            </div>
          </section>

          <section className="border-b border-rule px-4 py-4">
            <span className="etched">What the reserve can and cannot do</span>
            <ul className="flex flex-col gap-2 pt-2 text-body text-ink-2">
              <li>
                It can only ever send MUSD to a <span className="figure text-ink">registered Pylon position</span>,
                and only through that position&apos;s defence path, which spends it on repaying the position&apos;s
                own trove debt.
              </li>
              <li>
                A position cannot withdraw collateral or close its trove while a reserve loan is outstanding, so the
                claim is enforced in code rather than by policy.
              </li>
              <li>
                It cannot touch a native Mezo trove: shielding an existing position means operating it through a
                Pylon position, which is why the Shield mode offers to create one.
              </li>
              <li>
                It is not a savings account with a guaranteed yield. Lenders are exposed to the health of the troves
                they defend: a defence that is followed by a deeper drawdown can leave the loan unsettled and the
                shares worth less than the deposit.
              </li>
            </ul>
          </section>

          <section className="px-4 py-4">
            <span className="etched">Contracts</span>
            <div className="flex flex-col gap-3 pt-2">
              <AddressChip address={DEPLOYED.reserve} label="Reserve" />
              <AddressChip address={DEPLOYED.engine} label="Engine" />
              <AddressChip address={DEPLOYED.musd} label="MUSD" />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
