'use client'

import { useAccount } from 'wagmi'
import { ProofLedger } from '@/components/panels/ProofLedger'
import { AddressChip } from '@/components/ui/AddressChip'
import { SpecRow } from '@/components/ui/Panel'
import { useHydrated } from '@/hooks'
import { DEPLOYED, EXPLORER_URL } from '@/lib/chain'
import { useRuntimeConfig } from '@/state/queries'
import type { Address } from 'viem'

export default function ProofsPage() {
  const hydrated = useHydrated()
  const { address } = useAccount()
  const connectedAddress = (hydrated && address ? address : null) as Address | null
  const runtime = useRuntimeConfig().data?.value

  const manifest: Array<{ label: string; address: string; role: string }> = [
    {
      label: 'PylonFlashEngine',
      address: runtime?.engine ?? DEPLOYED.engine,
      role: 'Atomic entry point: loopSigned / unwindSigned / closeSigned, flash hook, fee accounting. v2 replaced v1, which parked repayment MUSD at BorrowerOperationsSignatures.',
    },
    { label: 'PylonReserve', address: runtime?.reserve ?? DEPLOYED.reserve, role: 'Shield pool: shares, utilisation caps, position-only lending' },
    { label: 'PylonPosition (impl)', address: runtime?.positionImplementation ?? DEPLOYED.positionImplementation, role: 'EIP-1167 clone target for shielded positions and their policies' },
    { label: 'BorrowerOperationsSignatures', address: runtime?.borrowerOpsSignatures ?? DEPLOYED.borrowerOpsSignatures, role: 'Mezo core contract that verifies the EIP-712 trove authorisations' },
    { label: 'TroveManager', address: runtime?.troveManager ?? DEPLOYED.troveManager, role: 'Mezo CDP accounting, ICR and TCR, redeemer-facing state' },
    { label: 'SortedTroves', address: runtime?.sortedTroves ?? DEPLOYED.sortedTroves, role: 'The redemption queue itself: one ordered list from 110% MCR to the head' },
    { label: 'MUSD', address: runtime?.musd ?? DEPLOYED.musd, role: 'The stablecoin borrowed, flashed, repaid and used to settle x402 calls' },
    { label: 'BTC (Mezo gas token)', address: runtime?.btc ?? DEPLOYED.btc, role: 'Collateral asset; 18-decimal ERC-20 view of the native token' },
    { label: 'Tigris MUSD/mUSDC', address: runtime?.flashPool ?? DEPLOYED.flashPool, role: 'Flash venue used for every operation' },
    { label: 'Tigris MUSD/BTC', address: runtime?.swapPool ?? DEPLOYED.swapPool, role: 'Swap venue: MUSD → BTC on a loop, BTC → MUSD on an unwind' },
    { label: 'Tigris Router', address: runtime?.router ?? DEPLOYED.router, role: 'Route discovery and swap entry point' },
  ]

  return (
    <div className="mx-auto max-w-[1560px] border-x border-rule">
      <header className="flex flex-col gap-3 border-b border-rule px-4 py-6">
        <span className="etched">Proof ledger</span>
        <h1 className="max-w-[46ch] text-h1 text-ink">Every claim in this terminal resolves to a Mezo transaction.</h1>
        <p className="max-w-[80ch] text-lede text-ink-2">
          A flash operation that moves collateral between legs inside a single transaction is only credible if the
          receipts are one click away. Each row below links to a real transaction on Mezo Testnet; each contract in
          the manifest is the address the terminal actually calls.
        </p>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="min-w-0 border-b border-rule xl:border-b-0 xl:border-r">
          <ProofLedger connectedAddress={connectedAddress} withFilters />
        </div>

        <div className="flex min-w-0 flex-col">
          <section className="border-b border-rule px-4 py-4">
            <span className="etched">How to verify a row</span>
            <ol className="flex flex-col gap-2 pt-2 text-body text-ink-2">
              <li>Open the transaction hash on {EXPLORER_URL.replace('https://', '')}.</li>
              <li>
                For a loop: the log shows <span className="figure text-ink">Looped(owner, musdBorrowed, btcAdded, feeMusd)</span>{' '}
                — one transaction, one flash borrow, one swap, one trove adjustment.
              </li>
              <li>
                For an unwind: <span className="figure text-ink">Unwound(owner, musdRepaid, btcWithdrawn, btcSwapped, feeMusd)</span>{' '}
                with zero MUSD leaving the owner&apos;s wallet.
              </li>
              <li>For a shield: <span className="figure text-ink">Defended(musdRepaid, preICR, postICR, reserveDebt)</span> on the position.</li>
            </ol>
          </section>

          <section className="border-b border-rule px-4 py-4">
            <span className="etched">Ledger semantics</span>
            <div className="pt-2">
              <SpecRow label="Live rows" value="read from the engine service" tone="emerald" />
              <SpecRow label="Fallback rows" value="frozen deployment ledger" tone="caution" />
              <SpecRow label="Chain" value="Mezo Testnet · 31611" tone="muted" />
              <SpecRow label="Custody" value="none at any point" tone="muted" />
            </div>
            <p className="pt-2 text-[12px] leading-[1.5] text-ink-3">
              When the engine API is unreachable the terminal falls back to the deployment transactions captured in
              the repository&apos;s broadcast log. Those rows are marked &quot;frozen deployment ledger&quot; rather than
              being presented as live activity.
            </p>
          </section>

          <section className="px-4 py-4">
            <span className="etched">Deployment manifest · chain 31611</span>
            <ul className="flex flex-col gap-3 pt-3">
              {manifest.map((entry) => (
                <li key={entry.label} className="flex flex-col gap-1.5">
                  <AddressChip address={entry.address} label={entry.label} size={5} />
                  <span className="text-[12px] leading-[1.5] text-ink-3">{entry.role}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
