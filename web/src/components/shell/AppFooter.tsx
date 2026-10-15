'use client'

import { AddressChip } from '@/components/ui/AddressChip'
import { DEPLOYED, EXPLORER_URL } from '@/lib/chain'
import { useRuntimeConfig } from '@/state/queries'

export function AppFooter() {
  const config = useRuntimeConfig()
  const source = config.data?.source === 'engine' ? 'Pylon engine API' : 'direct Mezo RPC reads'
  const runtime = config.data?.value
  // Addresses come from the effective runtime configuration, so the footer can never advertise a
  // superseded deployment while the rest of the terminal talks to a newer one.
  const contracts: Array<{ label: string; address: string }> = [
    { label: 'Engine', address: runtime?.engine ?? DEPLOYED.engine },
    { label: 'Reserve', address: runtime?.reserve ?? DEPLOYED.reserve },
    { label: 'MUSD', address: runtime?.musd ?? DEPLOYED.musd },
    { label: 'BTC', address: runtime?.btc ?? DEPLOYED.btc },
    { label: 'SortedTroves', address: runtime?.sortedTroves ?? DEPLOYED.sortedTroves },
    { label: 'TroveManager', address: runtime?.troveManager ?? DEPLOYED.troveManager },
    { label: 'Tigris flash', address: runtime?.flashPool ?? DEPLOYED.flashPool },
    { label: 'Tigris MUSD/BTC', address: runtime?.swapPool ?? DEPLOYED.swapPool },
  ]

  return (
    <footer className="mt-8 border-t border-rule">
      <div className="mx-auto grid max-w-[1560px] gap-x-8 gap-y-6 px-3 py-8 lg:grid-cols-[1.2fr_1fr_1fr]">
        <div className="flex min-w-0 flex-col gap-3">
          <span className="etched">Deployed contracts · chain 31611</span>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {contracts.map((entry) => (
              <AddressChip key={entry.label} address={entry.address} label={entry.label} />
            ))}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <span className="etched">Data provenance</span>
          <p className="max-w-[44ch] text-body text-ink-2">
            Figures resolve from {source}. Every panel falls back to direct chain reads when the engine
            service is unavailable; nothing is cached longer than the refresh window shown in each panel
            header.
          </p>
          <a className="link figure text-meta" href={EXPLORER_URL} target="_blank" rel="noreferrer noopener">
            Verify on the Mezo explorer ↗
          </a>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <span className="etched">Instrument notes</span>
          <ul className="flex flex-col gap-1.5 text-body text-ink-2">
            <li>Pylon is non-custodial: nothing is held between transactions.</li>
            <li>Flash liquidity is borrowed and repaid inside a single transaction.</li>
            <li>Runs on Mezo Testnet only. Amounts are testnet MUSD and BTC.</li>
            <li>Engine v2 is live on 31611; v1 was superseded after a repayment-accounting fault.</li>
          </ul>
        </div>
      </div>
    </footer>
  )
}
