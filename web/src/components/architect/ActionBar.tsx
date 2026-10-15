'use client'

import { HashLink } from '@/components/ui/AddressChip'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import type { BroadcastRoute, ExecState } from '@/state/execution'

export interface Guard {
  level: 'warn' | 'block'
  message: string
}

const STAGES: Array<{ key: ExecState['stage']; label: string }> = [
  { key: 'preparing', label: 'Prepare' },
  { key: 'signing', label: 'Sign' },
  { key: 'broadcasting', label: 'Broadcast' },
  { key: 'confirming', label: 'Confirm' },
]

/**
 * Single primary action plus the broadcast-route switch and a transaction lifecycle strip.
 * Anything that can go wrong is stated before the button, never after: guards render above it and
 * `disabledReason` explains the blocked state in the same place.
 */
export function ActionBar({
  label,
  guards,
  disabledReason,
  route,
  onRouteChange,
  engineAvailable,
  walletAvailable,
  state,
  onRun,
  onReset,
  extraAction,
}: {
  label: string
  guards: Guard[]
  disabledReason: string | null
  route: BroadcastRoute
  onRouteChange: (route: BroadcastRoute) => void
  engineAvailable: boolean
  walletAvailable: boolean
  state: ExecState
  onRun: () => void
  onReset: () => void
  extraAction?: React.ReactNode
}) {
  const blocked = disabledReason !== null
  const busy = ['preparing', 'signing', 'broadcasting', 'confirming'].includes(state.stage)
  const stageIndex = STAGES.findIndex((stage) => stage.key === state.stage)

  return (
    <div className="flex flex-col gap-3 border-t border-rule px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="etched">Broadcast route</span>
        <div className="w-[260px]">
          <SegmentedControl<BroadcastRoute>
            label="Broadcast route"
            size="sm"
            value={route}
            onChange={onRouteChange}
            segments={[
              {
                value: 'engine',
                label: 'Engine relay',
                hint: engineAvailable
                  ? 'Pylon engine service signs and broadcasts; hints are recomputed at execution time'
                  : 'Requires the Pylon engine API',
                disabled: !engineAvailable,
              },
              {
                value: 'wallet',
                label: 'Self-broadcast',
                hint: walletAvailable
                  ? 'Your wallet sends the transaction; nonce and hints are computed on chain by the terminal'
                  : 'Requires a connected wallet on Mezo Testnet',
                disabled: !walletAvailable,
              },
            ]}
          />
        </div>
      </div>

      {guards.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {guards.map((guard) => (
            <li
              key={guard.message}
              className={`border-l-2 pl-2.5 text-body ${
                guard.level === 'block' ? 'border-vermilion text-ink' : 'border-caution text-ink-2'
              }`}
            >
              {guard.message}
            </li>
          ))}
        </ul>
      ) : null}

      {busy || state.stage === 'confirmed' || state.stage === 'failed' ? (
        <div className="flex flex-col gap-2 border border-rule bg-canvas px-3 py-2.5">
          <div className="flex items-center gap-2">
            {STAGES.map((stage, index) => {
              const done = state.stage === 'confirmed' || index < stageIndex
              const active = index === stageIndex && state.stage !== 'confirmed'
              return (
                <span key={stage.key} className="flex flex-1 items-center gap-2">
                  <span
                    className={`h-[5px] w-[5px] ${done ? 'bg-emerald' : active ? 'animate-blink bg-amber' : 'bg-rule-2'}`}
                  />
                  <span
                    className={`figure text-label uppercase ${done ? 'text-emerald' : active ? 'text-amber' : 'text-ink-3'}`}
                  >
                    {stage.label}
                  </span>
                </span>
              )
            })}
          </div>

          {state.label ? <span className="figure text-label text-ink-3">{state.label}</span> : null}

          {state.hash ? <HashLink hash={state.hash} label={state.stage === 'confirmed' ? 'tx' : 'pending'} /> : null}

          {state.stage === 'confirmed' ? (
            <span className="figure text-meta text-emerald">
              Confirmed on Mezo Testnet — the queue and your position will refresh within one poll.
            </span>
          ) : null}

          {state.stage === 'failed' && state.message ? (
            <span className="flex flex-col gap-2">
              <span className="text-body text-vermilion">{state.message}</span>
              <button type="button" className="btn self-start" onClick={onReset}>
                Dismiss
              </button>
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-stretch gap-2">
        <button type="button" className="btn btn-primary btn-lg flex-1" disabled={blocked || busy} onClick={onRun}>
          {busy ? 'Executing…' : label}
        </button>
        {extraAction}
      </div>

      {disabledReason ? (
        <span className="figure text-label text-ink-3">{disabledReason}</span>
      ) : (
        <span className="figure text-label text-ink-3">
          {route === 'engine'
            ? 'The engine service relays the transaction; your signature authorises the trove change only.'
            : 'Your wallet pays gas in BTC and sends the transaction directly to the Pylon engine contract.'}
        </span>
      )}
    </div>
  )
}
