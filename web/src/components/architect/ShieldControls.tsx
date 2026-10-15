'use client'

import { useEffect, useMemo, useState } from 'react'
import { isAddress, type Address } from 'viem'
import { AmountField } from '@/components/ui/AmountField'
import { AddressChip } from '@/components/ui/AddressChip'
import { MechanicalSlider } from '@/components/ui/MechanicalSlider'
import { SpecRow } from '@/components/ui/Panel'
import { StateBlock } from '@/components/ui/StateBlock'
import { fmtMusd, fmtUnits, fmtWadPct, parseAmount } from '@/lib/format'
import { useOwnedPositions, usePosition, useReserve, useWalletState } from '@/state/queries'
import { useChainActions } from '@/state/actions'
import type { ArchitectSharedProps } from './types'

const WAD = 10n ** 18n

const bpsToWad = (bps: number) => (BigInt(Math.round(bps)) * WAD) / 10_000n
const wadToBps = (wad: bigint) => Number((wad * 10_000n) / WAD)

/**
 * Redemption Shield.
 *
 * A shield is a MUSD reserve that permissionlessly repays a position's debt when its ICR enters a
 * configured band, pushing it back up before a redemption sweep or a price move can take collateral.
 * Three things have to exist for it to work, and the panel shows which are missing: a Pylon
 * position, a policy, and reserve capital.
 */
export function ShieldControls({ owner, market, config }: ArchitectSharedProps) {
  const account = owner
  const positions = useOwnedPositions(account)
  const [positionAddress, setPositionAddress] = useState<Address | null>(null)
  const [manual, setManual] = useState('')
  const [triggerBps, setTriggerBps] = useState(22_000) // 220%
  const [targetBps, setTargetBps] = useState(26_000) // 260%
  const [maxPerCall, setMaxPerCall] = useState('')
  const [repayAmount, setRepayAmount] = useState('')
  const [openColl, setOpenColl] = useState('')
  const [openDebt, setOpenDebt] = useState('')

  const discovered = positions.data ?? []
  const effective = positionAddress ?? discovered[0] ?? null
  const position = usePosition(effective)
  const reserve = useReserve()
  const wallet = useWalletState(account)
  const actions = useChainActions()

  useEffect(() => {
    const existing = position.data
    if (existing?.policy.enabled) {
      setTriggerBps(wadToBps(BigInt(existing.policy.triggerIcrWad)))
      setTargetBps(wadToBps(BigInt(existing.policy.targetIcrWad)))
      setMaxPerCall(fmtUnits(existing.policy.maxPerCall, 18, { fixed: 0 }))
    }
  }, [position.data])

  const price = market ? BigInt(market.btcPriceWad) : null
  const reserveLiquidity = reserve.data?.value ? BigInt(reserve.data.value.totalAssets) : 0n

  const coverage = useMemo(() => {
    if (!position.data || !price) return null
    const coll = BigInt(position.data.coll)
    const debt = BigInt(position.data.debt)
    const collValue = (coll * price) / WAD
    const targetWad = bpsToWad(targetBps)
    const debtAtTarget = (collValue * WAD) / targetWad
    const want = debt > debtAtTarget ? debt - debtAtTarget : 0n
    const available = BigInt(position.data.availableToLend)
    const maxCall = parseAmount(maxPerCall, 18) ?? want
    const repayNow = want < maxCall ? want : maxCall
    const actual = repayNow < available ? repayNow : available
    const postIcr = debt > actual ? (collValue * WAD) / (debt - actual) : 0n
    return { collValue, debt, want, available, actual, postIcr, defences: want > 0n ? available / want : 0n }
  }, [position.data, price, targetBps, maxPerCall])

  if (!account || !isAddress(account)) {
    return (
      <div className="flex flex-col gap-4 px-3 py-3">
        <StateBlock
          state="empty"
          title="Connect a wallet to configure a shield"
          detail="The shield is attached to a Pylon position you own: it repays that position's debt from reserve MUSD when the ICR falls into your trigger band. Nothing is signed until you save a policy."
        />
        <ol className="flex flex-col">
          {[
            {
              step: '1',
              title: 'Capital',
              body: 'Lenders deposit MUSD into the shield reserve. Deposits mint shares priced at total assets over total shares, and every flash fee Pylon charges accrues to them.',
            },
            {
              step: '2',
              title: 'Policy',
              body: 'A position stores a trigger ICR, a target ICR and a per-call ceiling. The policy is the only instruction the reserve ever acts on.',
            },
            {
              step: '3',
              title: 'Defence',
              body: 'Once the ICR drops into the band, anyone can call defend(). The reserve lends MUSD to the position, and the position spends it on repaying its own trove debt. The loan is settled before any collateral can move.',
            },
          ].map((entry) => (
            <li key={entry.step} className="flex gap-3 border-b border-rule py-2.5 last:border-b-0">
              <span className="figure mt-[2px] text-[10px] text-ink-3">{entry.step}</span>
              <span className="flex flex-col gap-1">
                <span className="etched">{entry.title}</span>
                <span className="text-body text-ink-2">{entry.body}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    )
  }

  if (positions.isLoading) {
    return (
      <div className="px-3 py-3">
        <StateBlock state="loading" title="Looking for Pylon positions owned by this wallet" />
      </div>
    )
  }

  if (discovered.length === 0 && !effective) {
    return (
      <div className="flex flex-col gap-4 px-3 py-3">
        <StateBlock
          state="empty"
          title="No Pylon position found for this wallet"
          detail="A shield protects a trove that a Pylon position owns, because only the position can repay its own debt from reserve capital. Create the position here, open its trove, then set a policy — or paste an existing position address below."
        />
        <div className="flex flex-wrap items-end gap-3">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void actions.createPosition()}
          >
            Create Pylon position
          </button>
          <div className="min-w-[240px] flex-1">
            <AmountField
              label="Or paste a position address"
              unit="0x…"
              value={manual}
              onChange={setManual}
              placeholder="0x…"
            />
          </div>
          <button
            type="button"
            className="btn"
            disabled={!isAddress(manual)}
            onClick={() => setPositionAddress(manual as Address)}
          >
            Load position
          </button>
        </div>
        <ActionState state={actions.state} onReset={actions.reset} />
      </div>
    )
  }

  if (position.isLoading) {
    return (
      <div className="px-3 py-3">
        <StateBlock state="loading" title="Reading the position and its shield policy" />
      </div>
    )
  }

  if (!position.data) {
    return (
      <div className="px-3 py-3">
        <StateBlock
          state="error"
          title="That address is not a Pylon position"
          detail="Check the address, or create a new position from this wallet."
          onRetry={() => void position.refetch()}
        />
      </div>
    )
  }

  const data = position.data
  const active = BigInt(data.coll) > 0n
  const icr = BigInt(data.icrWad)
  const triggerWad = bpsToWad(triggerBps)
  const targetWad = bpsToWad(targetBps)
  const configValid = targetWad > triggerWad && triggerWad >= (WAD * 110n) / 100n

  return (
    <>
      <div className="flex flex-col gap-4 px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-3">
            <span className="etched">Position</span>
            <AddressChip address={data.address} size={5} />
          </span>
          <span className="flex items-center gap-2">
            <span className="etched">Policy</span>
            <span className={`figure text-meta ${data.policy.enabled ? 'text-emerald' : 'text-ink-3'}`}>
              {data.policy.enabled ? 'armed' : 'disarmed'}
            </span>
          </span>
        </div>

        {!active ? (
          <div className="flex flex-col gap-3 border border-rule bg-canvas px-3 py-3">
            <span className="etched">Step 1 — open the position&apos;s trove</span>
            <p className="text-body text-ink-2">
              The shield defends a trove owned by this position. Post BTC collateral and borrow at least{' '}
              {fmtMusd(config.minNetDebt, { fixed: 0 })} (plus Mezo&apos;s{' '}
              {fmtMusd(config.gasCompensation, { fixed: 0 })} gas compensation) to activate it.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <AmountField
                label="Collateral"
                unit="BTC"
                value={openColl}
                onChange={setOpenColl}
                placeholder="0.02"
                balanceWei={wallet.data ? wallet.data.btcBalance.toString() : null}
                onMax={() =>
                  wallet.data && setOpenColl(fmtUnits(wallet.data.btcBalance, 18, { small: 6, normal: 6, min: 4 }))
                }
              />
              <AmountField
                label="Debt to borrow"
                unit="MUSD"
                value={openDebt}
                onChange={setOpenDebt}
                placeholder="2000"
                hint={`min ${fmtMusd(config.minNetDebt, { fixed: 0 })}`}
              />
            </div>
            <button
              type="button"
              className="btn btn-primary self-start"
              disabled={
                (parseAmount(openColl, 18) ?? 0n) === 0n ||
                (parseAmount(openDebt, 18) ?? 0n) < BigInt(config.minNetDebt)
              }
              onClick={() => {
                const coll = parseAmount(openColl, 18)
                const debt = parseAmount(openDebt, 18)
                if (coll && debt) void actions.openPositionTrove(data.address, coll, debt)
              }}
            >
              Open shielded trove
            </button>
          </div>
        ) : null}

        {active ? (
          <>
            <MechanicalSlider
              ariaLabel="Trigger ICR"
              value={triggerBps}
              min={11_000}
              max={40_000}
              step={500}
              format={(value) => fmtWadPct(bpsToWad(value))}
              onChange={(value) => setTriggerBps(value)}
              captionLeft="110% MCR"
              captionRight="400%"
              marks={[
                { value: 12_500, label: '125%' },
                { value: 17_500, label: '175%' },
                { value: 25_000, label: '250%' },
                { value: 35_000, label: '350%' },
              ]}
            />

            <MechanicalSlider
              ariaLabel="Target ICR"
              value={targetBps}
              min={Math.max(triggerBps + 500, 11_500)}
              max={50_000}
              step={500}
              format={(value) => fmtWadPct(bpsToWad(value))}
              onChange={(value) => setTargetBps(value)}
              captionLeft="above trigger"
              captionRight="500%"
              marks={[
                { value: 20_000, label: '200%' },
                { value: 30_000, label: '300%' },
                { value: 40_000, label: '400%' },
              ]}
            />

            <AmountField
              label="Max MUSD per defence call"
              unit="MUSD"
              value={maxPerCall}
              onChange={setMaxPerCall}
              placeholder="500"
              hint="absolute ceiling for one permissionless defence"
              onMax={() =>
                setMaxPerCall(
                  fmtUnits(BigInt(data.availableToLend), 18, { small: 2, normal: 2, min: 0 }),
                )
              }
            />

            <div className="flex flex-col">
              <SpecRow label="Position ICR" value={fmtWadPct(icr)} tone={icr < triggerWad ? 'vermilion' : 'emerald'} />
              <SpecRow label="Trigger" value={fmtWadPct(triggerWad)} tone="muted" />
              <SpecRow
                label="Repay needed at target"
                value={coverage ? fmtMusd(coverage.want) : '—'}
                hint={`to reach ${fmtWadPct(targetWad)}`}
              />
              <SpecRow
                label="One defence call repays"
                value={coverage ? fmtMusd(coverage.actual) : '—'}
                tone={coverage && coverage.actual === 0n ? 'vermilion' : 'default'}
              />
              <SpecRow
                label="ICR after one call"
                value={coverage && coverage.postIcr > 0n ? fmtWadPct(coverage.postIcr) : '—'}
                tone="emerald"
              />
              <SpecRow
                label="Reserve loan outstanding"
                value={fmtMusd(data.reserveDebt)}
                tone={BigInt(data.reserveDebt) > 0n ? 'caution' : 'muted'}
              />
            </div>

            {reserveLiquidity === 0n ? (
              <StateBlock
                state="empty"
                compact
                title="The shield reserve is empty"
                detail="There is no MUSD for the reserve to lend, so a defence cannot repay anything yet. Deposit MUSD into the shield reserve to capitalise it — every shielded position draws from the same pool."
              />
            ) : coverage && coverage.available === 0n ? (
              <StateBlock
                state="empty"
                compact
                title="No lending capacity for this position"
                detail="Either the reserve has hit its utilisation cap, or this position is already at its per-position ceiling."
              />
            ) : (
              <p className="text-body text-ink-2">
                Defence is permissionless: anyone can call it once the ICR drops below{' '}
                <span className="figure text-ink">{fmtWadPct(triggerWad)}</span>. It repays from reserve MUSD
                until the ICR reaches <span className="figure text-ink">{fmtWadPct(targetWad)}</span>, capped at
                your per-call ceiling and at{' '}
                <span className="figure text-ink">{fmtMusd(data.availableToLend)}</span> of available reserve
                liquidity — roughly {coverage ? coverage.defences.toString() : '0'} full defences at the current
                target.
              </p>
            )}

            <AmountField
              label="Repay reserve loan"
              unit="MUSD"
              value={repayAmount}
              onChange={setRepayAmount}
              placeholder="0"
              hint={`outstanding ${fmtMusd(data.reserveDebt)}`}
              onMax={() => setRepayAmount(fmtUnits(BigInt(data.reserveDebt), 18, { fixed: 2 }))}
            />
          </>
        ) : null}
      </div>

      {active ? (
        <div className="flex flex-col gap-3 border-t border-rule px-3 py-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!configValid}
              onClick={() => void actions.setShield(data.address, true, triggerWad, targetWad, parseAmount(maxPerCall, 18) ?? 0n)}
            >
              Arm shield policy
            </button>
            <button
              type="button"
              className="btn"
              disabled={!data.policy.enabled}
              onClick={() => void actions.defend(data.address)}
            >
              Run defence now
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={parseAmount(repayAmount, 18) === null || (parseAmount(repayAmount, 18) ?? 0n) === 0n}
              onClick={() => {
                const amount = parseAmount(repayAmount, 18)
                if (amount) void actions.repayReserve(data.address, amount)
              }}
            >
              Repay reserve loan
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={!data.policy.enabled}
              onClick={() => void actions.setShield(data.address, false, BigInt(data.policy.triggerIcrWad), BigInt(data.policy.targetIcrWad), BigInt(data.policy.maxPerCall))}
            >
              Disarm
            </button>
          </div>
          {!configValid ? (
            <span className="figure text-label text-vermilion">
              Target ICR must be above the trigger, and the trigger at or above the 110% MCR.
            </span>
          ) : null}
          <span className="figure text-label text-ink-3">
            Saving a policy costs one transaction. Reserve repayments are yours alone — the shield can never
            take collateral.
          </span>
        </div>
      ) : null}

      <ActionState state={actions.state} onReset={actions.reset} />
    </>
  )
}

function ActionState({
  state,
  onReset,
}: {
  state: ReturnType<typeof useChainActions>['state']
  onReset: () => void
}) {
  if (state.stage === 'idle') return null
  return (
    <div className="mx-3 mb-3 flex flex-col gap-2 border border-rule bg-canvas px-3 py-2.5">
      <span className="etched">{state.label ?? 'Wallet action'}</span>
      <span className="flex items-center gap-3">
        <span
          className={`h-[5px] w-[5px] ${
            state.stage === 'confirmed'
              ? 'bg-emerald'
              : state.stage === 'failed'
                ? 'bg-vermilion'
                : 'animate-blink bg-amber'
          }`}
        />
        <span className="figure text-meta text-ink-2">
          {state.stage === 'preparing'
            ? 'preparing'
            : state.stage === 'confirming'
              ? 'confirming on chain'
              : state.stage === 'confirmed'
                ? 'confirmed'
                : 'failed'}
        </span>
        {state.hash ? <AddressChip address={state.hash} kind="tx" /> : null}
      </span>
      {state.message ? <span className="text-body text-vermilion">{state.message}</span> : null}
      {state.stage === 'failed' ? (
        <button type="button" className="btn btn-quiet self-start" onClick={onReset}>
          Dismiss
        </button>
      ) : null}
    </div>
  )
}
