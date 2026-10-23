'use client'

import { useEffect, useState } from 'react'
import { NETWORK_LABEL } from '@/lib/chain'
import { isAddress } from 'viem'
import { AddressChip } from '@/components/ui/AddressChip'
import { Panel, SpecRow } from '@/components/ui/Panel'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { StateBlock } from '@/components/ui/StateBlock'
import { fmtBps, fmtBtc, fmtMusd, fmtWadPct } from '@/lib/format'
import { fmtCompact, shortAddress } from '@/lib/format'
import { useMarket, useRadar, useRuntimeConfig, useTrove, useTroveState, useWalletState } from '@/state/queries'
import { useAtomicExecution, type BroadcastRoute } from '@/state/execution'
import { useTerminal, type ArchitectMode } from '@/state/terminal-context'
import { ExitControls } from './ExitControls'
import { LoopControls } from './LoopControls'
import { OpenTroveCard } from './OpenTroveCard'
import { ShieldControls } from './ShieldControls'
import { UnwindControls } from './UnwindControls'
import type { ArchitectSharedProps } from './types'

/**
 * Right column: the Position Architect.
 *
 * One mode switch, one control surface, one primary action. The trove being operated on is stated at
 * the top — either the connected wallet's own Mezo trove or a trove picked out of the Redemption
 * Radar — because for a signed operation that difference decides who can authorise it.
 */
export function PositionArchitect({ connectedAddress }: { connectedAddress: string | null }) {
  const { mode, setMode, targetOwner, selectedTrove, focusTrove, setTargetOwner } = useTerminal()
  const config = useRuntimeConfig()
  const radar = useRadar(24)
  const market = useMarket()
  const [route, setRoute] = useState<BroadcastRoute>('engine')

  const configValue = config.data?.value ?? null
  const marketValue = market.data?.value ?? null
  const engineAvailable = config.data?.source === 'engine'
  const walletAvailable = Boolean(connectedAddress)

  const ownerCandidate = targetOwner || connectedAddress || ''
  const owner = isAddress(ownerCandidate) ? (ownerCandidate as `0x${string}`) : null
  const trove = useTrove(owner)
  const troveState = useTroveState(trove.data)
  const wallet = useWalletState(connectedAddress ? (connectedAddress as `0x${string}`) : null)
  const execution = useAtomicExecution()

  useEffect(() => {
    if (!engineAvailable && walletAvailable) setRoute('wallet')
    if (engineAvailable && !walletAvailable) setRoute('engine')
  }, [engineAvailable, walletAvailable])

  const shared: Omit<ArchitectSharedProps, 'config' | 'market'> = {
    owner,
    trove: trove.data,
    troveState,
    engineAvailable,
    walletAvailable,
    execution,
    route,
    onRouteChange: setRoute,
  }

  const isOwnTrove = Boolean(connectedAddress && owner && connectedAddress === owner)

  return (
    <Panel
      label="Position architect"
      className="min-h-[620px]"
      bodyClassName="flex flex-col gap-0 p-0"
      meta={
        <span className="figure text-label text-ink-3">
          {marketValue
            ? `${fmtBps(marketValue.flashFeeBps)} Pylon · ${fmtBps(marketValue.swapFeeBps)} swap`
            : 'reading fees…'}
        </span>
      }
    >
      <div className="border-b border-rule px-3 py-3">
        <SegmentedControl<ArchitectMode>
          label="Execution mode"
          value={mode}
          onChange={setMode}
          segments={[
            { value: 'loop', label: 'Loop', hint: 'Borrow and re-buy BTC in one transaction' },
            { value: 'unwind', label: 'Unwind', hint: 'Repay debt out of the trove’s own collateral' },
            { value: 'exit', label: 'Exit', hint: 'Close the trove entirely with no wallet MUSD' },
            { value: 'shield', label: 'Shield', hint: 'Reserve-funded defence against redemptions' },
          ]}
        />
      </div>

      <div className="flex flex-col gap-2 border-b border-rule px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex min-w-0 flex-wrap items-center gap-3">
            <span className="etched">Target trove</span>
            {selectedTrove && owner === selectedTrove.address ? (
              <span className="chip border-amber/50 text-amber">radar #{selectedTrove.rank}</span>
            ) : null}
            {isOwnTrove ? <span className="chip border-ink/40 text-ink">your wallet</span> : null}
          </span>
          {trove.data?.value ? (
            <span className="flex items-center gap-3">
              <span className="figure text-label text-ink-3">
                {trove.data.value.exists ? 'active trove' : 'no active trove'}
              </span>
              <span className="figure text-meta text-ink">
                {/* getCurrentICR returns type(uint256).max for a trove that does not exist — never print it. */}
                {trove.data.value.exists ? fmtWadPct(trove.data.value.icrWad) : '—'}
              </span>
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <input
            className="field h-8 flex-1 text-meta"
            value={targetOwner}
            onChange={(event) => setTargetOwner(event.target.value.trim())}
            placeholder="0x… Mezo trove owner (paste any trove address)"
            spellCheck={false}
            autoComplete="off"
            aria-label="Trove owner address"
          />
          {owner ? <AddressChip address={owner} size={4} /> : null}
        </div>
        {targetOwner !== '' && !owner ? (
          <span className="figure text-label text-vermilion">Not a valid address</span>
        ) : null}
      </div>

      {configValue === null ? (
        <div className="px-3 py-3">
          <StateBlock state="loading" title={`Reading protocol configuration from ${NETWORK_LABEL}`} skeletonRows={2} />
        </div>
      ) : (
        <>
          {mode !== 'shield' ? (
            <>
              {trove.isLoading && owner ? (
                <div className="px-3 py-3">
                  <StateBlock state="loading" title={`Reading the trove from ${NETWORK_LABEL}`} skeletonRows={2} />
                </div>
              ) : null}

              {trove.isError ? (
                <div className="px-3 py-3">
                  <StateBlock
                    state="error"
                    title="Trove read failed"
                    detail={trove.error instanceof Error ? trove.error.message : 'The trove could not be read.'}
                    onRetry={() => void trove.refetch()}
                  />
                </div>
              ) : null}

              {!owner && !trove.isLoading ? (
                <div className="flex flex-col gap-3 px-3 py-3">
                  <StateBlock
                    state="empty"
                    title="No trove selected"
                    detail="Connect the wallet that owns the Mezo trove you want to operate on, or start from the five cheapest-to-redeem positions on the queue:"
                  />
                  <ul className="flex flex-col">
                    {(radar.data?.value.tail ?? radar.progress?.rows ?? []).slice(0, 5).map((row) => (
                      <li key={row.address}>
                        <button
                          type="button"
                          onClick={() => focusTrove(row)}
                          className="flex w-full items-baseline justify-between gap-3 border-b border-rule py-2 text-left transition-colors hover:bg-raised"
                        >
                          <span className="figure text-meta text-ink-3">#{row.rank}</span>
                          <span className="figure text-meta text-ink">{shortAddress(row.address, 5)}</span>
                          <span className="figure text-meta text-vermilion">{fmtWadPct(row.icrWad)}</span>
                          <span className="figure text-meta text-ink-3">
                            {fmtCompact(row.redemptionBufferMusd)} ahead
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {owner && trove.data && !trove.data.value.exists ? (
                isOwnTrove && configValue ? (
                  <OpenTroveCard
                    owner={owner}
                    config={configValue}
                    market={marketValue}
                    wallet={wallet.data ?? null}
                    onOpened={() => void trove.refetch()}
                  />
                ) : (
                  <div className="px-3 py-3">
                    <StateBlock
                      state="empty"
                      title="This address has no active Mezo trove"
                      detail="Pylon operates on the owner's existing trove. Connect that owner's wallet to open a Pylon trove here, or pick a trove from the radar to inspect it read-only."
                    />
                  </div>
                )
              ) : null}

              {mode === 'loop' && trove.data?.value.exists ? (
                <LoopControls {...shared} config={configValue} market={marketValue} />
              ) : null}
              {mode === 'unwind' && trove.data?.value.exists ? (
                <UnwindControls {...shared} config={configValue} market={marketValue} />
              ) : null}
              {mode === 'exit' && trove.data?.value.exists ? (
                <ExitControls {...shared} config={configValue} market={marketValue} />
              ) : null}
            </>
          ) : (
            <ShieldControls {...shared} config={configValue} market={marketValue} />
          )}
        </>
      )}

      <div className="mt-auto border-t border-rule px-3 py-3">
        <div className="flex flex-col">
          <SpecRow
            label="Wallet MUSD"
            value={wallet.data ? fmtMusd(wallet.data.musdBalance.toString()) : '—'}
            tone="muted"
            hint="never required for a flash operation"
          />
          <SpecRow
            label="Wallet BTC"
            value={wallet.data ? fmtBtc(wallet.data.btcBalance.toString()) : '—'}
            tone="muted"
            hint={`pays gas on ${NETWORK_LABEL}`}
          />
          <SpecRow
            label="Reserve shares"
            value={wallet.data ? fmtMusd(wallet.data.reserveAssets.toString()) : '—'}
            tone="muted"
            hint="shield pool position"
          />
        </div>
        <p className="pt-2 text-[12px] leading-[1.5] text-ink-3">
          Every mode is atomic on {NETWORK_LABEL}. Pylon never holds funds: the flash leg is borrowed and repaid
          inside one transaction, and a failure reverts the whole operation.
        </p>
      </div>
    </Panel>
  )
}
