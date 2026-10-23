'use client'

import { useHydrated } from '@/hooks'
import { PositionArchitect } from '@/components/architect/PositionArchitect'
import { ProofLedger } from '@/components/panels/ProofLedger'
import { ReservePanel } from '@/components/panels/ReservePanel'
import { X402Panel } from '@/components/panels/X402Panel'
import { RadarPanel } from '@/components/radar/RadarPanel'
import { InstrumentBar } from '@/components/shell/InstrumentBar'
import { API_ENABLED } from '@/lib/api'
import { useRadar } from '@/state/queries'
import { TerminalProvider, useTerminal } from '@/state/terminal-context'
import { useSignerAddress } from '@/state/demo-signer'
import type { Address } from 'viem'

/**
 * The terminal. Composition rules:
 *   · the working surface is the page — 62% redemption radar, 38% position architect, separated by a
 *     hairline rather than by gaps, so both panels read as one instrument;
 *   · everything below the fold is capital and evidence: the shield reserve, the paid endpoint, and
 *     the proof ledger;
 *   · no marketing copy above the fold: a visitor lands directly inside the queue.
 */
export default function TerminalPage() {
  const hydrated = useHydrated()
  // The demo key, when loaded, is the identity this page operates as — so the architect targets the
  // trove that key owns without a wallet extension in the loop.
  const signer = useSignerAddress()
  const connectedAddress = (hydrated && signer ? signer : null) as Address | null

  return (
    <TerminalProvider defaultOwner={connectedAddress ?? ''}>
      <TerminalBody connectedAddress={connectedAddress} />
    </TerminalProvider>
  )
}

function TerminalBody({ connectedAddress }: { connectedAddress: Address | null }) {
  const { selectedTrove } = useTerminal()
  // Same query key as the radar panel: one queue read feeds both the strip and the bar.
  const radar = useRadar(80)

  return (
    <>
      <InstrumentBar
        queueDepthMusd={radar.data?.value.redemptionQueueDepthMusd ?? null}
        queueCoverage={radar.data?.value.coverage ?? null}
      />

      <div className="mx-auto max-w-[1560px] border-x border-rule">
        <div className="grid grid-cols-1 lg:grid-cols-[62fr_38fr]">
          <div className="min-w-0 border-b border-rule lg:border-b-0 lg:border-r">
            <RadarPanel limit={80} connectedAddress={connectedAddress} />
          </div>
          <div className="min-w-0">
            <PositionArchitect connectedAddress={connectedAddress} />
          </div>
        </div>
      </div>

      <section className="mx-auto max-w-[1560px] border-x border-b border-t border-rule">
        <div className="flex flex-wrap items-baseline justify-between gap-3 px-3 py-4">
          <h2 className="text-h2 text-ink">Capital, agents and receipts</h2>
          <p className="max-w-[70ch] text-body text-ink-2">
            The shield reserve pays for redemptions before they reach a shielded position; the x402 endpoint
            sells executions to agents; the ledger is the explorer-linked record of what actually ran on Mezo
            Testnet.
          </p>
        </div>
        <div className="grid grid-cols-1 border-t border-rule xl:grid-cols-3">
          <div className="min-w-0 border-b border-rule xl:border-b-0 xl:border-r">
            <ReservePanel connectedAddress={connectedAddress} compact />
          </div>
          {API_ENABLED ? (
            <div className="min-w-0 border-b border-rule xl:border-b-0 xl:border-r">
              <X402Panel defaultAddress={selectedTrove?.address} />
            </div>
          ) : (
            <div className="min-w-0 border-b border-rule px-3 py-4 xl:border-b-0 xl:border-r">
              <span className="etched">Pay-to-deleverage · x402</span>
              <p className="pt-2 text-body text-ink-2">
                The paid telemetry endpoint is served by the testnet engine, which indexes chain 31611.
                This bundle reads Mezo mainnet directly and does not proxy another chain&apos;s data.
              </p>
            </div>
          )}
          <div className="min-w-0">
            <ProofLedger connectedAddress={connectedAddress} limit={6} />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1560px] px-3 py-8">
        <div className="grid gap-x-8 gap-y-6 lg:grid-cols-3">
          <div className="flex flex-col gap-2">
            <span className="etched">What the queue is telling you</span>
            <p className="text-body text-ink-2">
              Mezo is a Liquity-style CDP: MUSD is redeemable for $1 of BTC against the lowest-ICR trove above
              the 110% MCR. A healthy-looking borrower can therefore still lose collateral. The radar plots every
              trove in that queue, so a position is only ever described in the one unit that matters — how much
              redemption volume stands between it and the tail.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <span className="etched">Why it is atomic</span>
            <p className="text-body text-ink-2">
              Loops, unwinds and exits all borrow MUSD from a Tigris flash pool, act on the trove, and repay the
              pool inside one transaction. That is what removes the up-front capital requirement: nothing needs
              to be sitting in a wallet, and a failure costs gas instead of a half-finished position.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <span className="etched">What stays yours</span>
            <p className="text-body text-ink-2">
              Pylon never holds collateral, never takes custody and cannot move a trove without an EIP-712
              authorisation signed by its owner. The engine service can relay a transaction, but it cannot
              change its contents: the same struct is verified on chain against the signature.
            </p>
          </div>
        </div>
      </section>
    </>
  )
}
