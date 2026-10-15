'use client'

import { useState } from 'react'
import { isAddress } from 'viem'
import { AmountField } from '@/components/ui/AmountField'
import { Panel, SpecRow } from '@/components/ui/Panel'
import { Meter } from '@/components/ui/Meter'
import { StateBlock } from '@/components/ui/StateBlock'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { fmtBps, fmtMusd, fmtUnits, fmtWadPct, parseAmount } from '@/lib/format'
import { useReserve, useWalletState } from '@/state/queries'
import { useChainActions } from '@/state/actions'
import { HashLink } from '@/components/ui/AddressChip'
import { AddressChip } from '@/components/ui/AddressChip'

type ReserveTab = 'deposit' | 'withdraw'

/**
 * The shield reserve: a MUSD lending pool that only ever lends to registered Pylon positions, and
 * only ever to reduce their debt. Deposits mint non-transferable shares; redemptions pay out idle
 * liquidity, so utilisation is displayed before the user commits.
 */
export function ReservePanel({
  connectedAddress,
  compact = false,
}: {
  connectedAddress: string | null
  compact?: boolean
}) {
  const reserve = useReserve()
  const wallet = useWalletState(connectedAddress ? (connectedAddress as `0x${string}`) : null)
  const actions = useChainActions()
  const [tab, setTab] = useState<ReserveTab>('deposit')
  const [amount, setAmount] = useState('')

  const data = reserve.data?.value ?? null
  const parsed = parseAmount(amount, 18)
  const balance = wallet.data?.musdBalance ?? null
  const shares = wallet.data?.reserveShares ?? null
  const shareValue = wallet.data?.reserveAssets ?? null

  const withdrawShares = (() => {
    if (parsed === null || !data) return null
    const sharePrice = BigInt(data.sharePrice)
    if (sharePrice === 0n) return parsed
    return (parsed * 10n ** 18n) / sharePrice
  })()

  return (
    <Panel
      label="Shield reserve · MUSD pool"
      meta={
        <>
          <span className="figure text-label text-ink-3">
            {reserve.data?.source === 'engine' ? 'engine' : 'chain read'}
          </span>
          <span className="figure text-label text-ink-3">
            cap {data ? fmtBps(data.utilizationCapBps) : '—'}
          </span>
        </>
      }
      bodyClassName="flex flex-col gap-3 p-0"
    >
      {reserve.isLoading ? (
        <div className="px-3 py-3">
          <StateBlock state="loading" title="Reading the shield reserve" />
        </div>
      ) : null}

      {reserve.isError ? (
        <div className="px-3 py-3">
          <StateBlock
            state="error"
            title="Reserve read failed"
            detail={reserve.error instanceof Error ? reserve.error.message : 'The reserve did not answer.'}
            onRetry={() => void reserve.refetch()}
          />
        </div>
      ) : null}

      {data ? (
        <>
          <div className="flex flex-col gap-3 px-3 pt-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex flex-col gap-1">
                <span className="etched">Total assets</span>
                <span className="figure-lg text-ink">{fmtMusd(data.totalAssets, { fixed: 0 })}</span>
              </span>
              <span className="flex flex-col items-end gap-1">
                <span className="etched">Share price</span>
                <span className="figure text-lede text-emerald">{fmtUnits(data.sharePrice, 18, { fixed: 4 })}</span>
              </span>
            </div>

            {BigInt(data.totalAssets) === 0n ? (
              <StateBlock
                state="empty"
                compact
                title="The reserve holds no MUSD"
                detail="Nothing is available for a shield defence yet. The first deposit capitalises the pool — every shielded position then draws from it, and repayment from a defended position returns MUSD to the pool."
              />
            ) : null}

            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="etched">Utilisation</span>
                <span className="figure text-body text-ink">
                  {fmtBps(data.utilizationBps)}
                  <span className="text-ink-3"> / {fmtBps(data.utilizationCapBps)} cap</span>
                </span>
              </div>
              <Meter valueBps={data.utilizationBps} capBps={data.utilizationCapBps} />
            </div>

            <div className="flex flex-col">
              <SpecRow label="Idle liquidity" value={fmtMusd(data.idle)} hint="redeemable now" />
              <SpecRow label="Outstanding loans" value={fmtMusd(data.outstanding)} hint="lent to positions" />
              <SpecRow label="Fees received" value={fmtMusd(data.feesReceived)} tone="emerald" />
              <SpecRow label="Max per call" value={fmtMusd(data.maxLendPerCall)} tone="muted" />
              <SpecRow label="Max per position" value={fmtMusd(data.maxLendPerPosition)} tone="muted" />
            </div>
          </div>

          {!compact ? (
            <div className="border-t border-rule">
              <div className="px-3 pt-3">
                <span className="etched">Outstanding position loans</span>
              </div>
              {data.loans.length === 0 ? (
                <div className="px-3 pb-3 pt-2">
                  <StateBlock
                    state="empty"
                    compact
                    title="No position is borrowing from the reserve"
                    detail="Loans appear here as soon as a shield defence draws MUSD to repay a position's debt."
                  />
                </div>
              ) : (
                <div className="max-h-[220px] overflow-auto px-3 pb-3">
                  <table className="ledger">
                    <thead>
                      <tr>
                        <th className="cell-l">Position</th>
                        <th className="cell-l">Owner</th>
                        <th>Loan</th>
                        <th>ICR</th>
                        <th className="cell-l w-[92px]">Shield</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.loans.map((loan) => (
                        <tr key={loan.position}>
                          <td className="cell-l">
                            <AddressChip address={loan.position} />
                          </td>
                          <td className="cell-l">{loan.owner ? <AddressChip address={loan.owner} /> : '—'}</td>
                          <td>{fmtMusd(loan.loan)}</td>
                          <td>{loan.icrWad ? fmtWadPct(loan.icrWad) : '—'}</td>
                          <td className="cell-l">
                            <span
                              className={`figure text-meta ${loan.shieldEnabled ? 'text-emerald' : 'text-ink-3'}`}
                            >
                              {loan.shieldEnabled ? 'armed' : 'off'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          <div className="border-t border-rule px-3 py-3">
            <div className="pb-3">
              <SegmentedControl<ReserveTab>
                label="Reserve action"
                size="sm"
                value={tab}
                onChange={setTab}
                segments={[
                  { value: 'deposit', label: 'Deposit MUSD' },
                  { value: 'withdraw', label: 'Redeem shares' },
                ]}
              />
            </div>

            <div className="flex flex-col gap-3">
              <AmountField
                label={tab === 'deposit' ? 'MUSD to deposit' : 'MUSD to redeem'}
                unit="MUSD"
                value={amount}
                onChange={setAmount}
                balanceWei={tab === 'deposit' ? balance?.toString() ?? null : shareValue?.toString() ?? null}
                onMax={() => {
                  const source = tab === 'deposit' ? balance : shareValue
                  if (source !== null && source !== undefined) {
                    setAmount(fmtUnits(source, 18, { small: 2, normal: 2, min: 0 }))
                  }
                }}
                hint={tab === 'withdraw' ? 'limited by idle liquidity' : 'shares are minted at the current share price'}
                error={
                  tab === 'withdraw' && data && parsed !== null && BigInt(data.idle) < parsed
                    ? `Only ${fmtMusd(data.idle)} is idle right now — a defence loan is outstanding.`
                    : null
                }
              />

              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  !connectedAddress ||
                  !isAddress(connectedAddress) ||
                  parsed === null ||
                  parsed === 0n ||
                  (tab === 'withdraw' && withdrawShares === null)
                }
                onClick={() => {
                  if (!connectedAddress || parsed === null) return
                  const receiver = connectedAddress as `0x${string}`
                  if (tab === 'deposit') void actions.depositReserve(parsed, receiver)
                  else if (withdrawShares !== null) void actions.withdrawReserve(withdrawShares, receiver)
                }}
              >
                {tab === 'deposit' ? 'Approve & deposit' : 'Redeem to wallet'}
              </button>

              {connectedAddress && wallet.data ? (
                <div className="flex flex-col">
                  <SpecRow label="Your shares" value={fmtUnits(shares, 18, { fixed: 2 })} tone="muted" />
                  <SpecRow label="Redeemable value" value={fmtMusd(shareValue)} tone="muted" />
                  <SpecRow
                    label="Share price now"
                    value={data ? fmtWadPct(data.sharePrice) : '—'}
                    tone="muted"
                    hint="1.0000 = no fees accrued yet"
                  />
                </div>
              ) : (
                <span className="figure text-label text-ink-3">
                  Connect a wallet to deposit, redeem or read your share balance.
                </span>
              )}
            </div>
          </div>
        </>
      ) : null}

      {actions.state.stage !== 'idle' ? (
        <div className="border-t border-rule px-3 py-3">
          <span className="etched">{actions.state.label ?? 'Reserve action'}</span>
          <div className="flex items-center gap-3 pt-2">
            <span
              className={`h-[5px] w-[5px] ${
                actions.state.stage === 'confirmed'
                  ? 'bg-emerald'
                  : actions.state.stage === 'failed'
                    ? 'bg-vermilion'
                    : 'animate-blink bg-amber'
              }`}
            />
            <span className="figure text-meta text-ink-2">{actions.state.stage}</span>
            {actions.state.hash ? <HashLink hash={actions.state.hash} /> : null}
          </div>
          {actions.state.message ? (
            <p className="pt-2 text-body text-vermilion">{actions.state.message}</p>
          ) : null}
        </div>
      ) : null}
    </Panel>
  )
}
