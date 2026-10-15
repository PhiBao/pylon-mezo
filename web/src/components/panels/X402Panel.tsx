'use client'

import { useState } from 'react'
import { isAddress, type Address } from 'viem'
import { useAccount, useChainId, usePublicClient, useSignTypedData, useWriteContract } from 'wagmi'
import { AmountField } from '@/components/ui/AmountField'
import { AddressChip } from '@/components/ui/AddressChip'
import { Panel, SpecRow } from '@/components/ui/Panel'
import { StateBlock } from '@/components/ui/StateBlock'
import { erc20Abi } from '@/lib/abi'
import { API_BASE } from '@/lib/api'
import { explorerTx } from '@/lib/chain'
import { fmtInt, fmtMusd, fmtUsd, fmtWadPct } from '@/lib/format'
import {
  acceptAmount,
  buildPaymentHeader,
  parseChallenge,
  parseSettlement,
  type X402Accept,
  type X402Challenge,
} from '@/lib/x402'

type Phase = 'idle' | 'probing' | 'terms' | 'transferring' | 'signing' | 'fetching' | 'paid' | 'failed'

interface Report {
  generatedAtBlock?: number
  trove?: Record<string, unknown>
  btcPriceWad?: string
  redemptionQueue?: { rank?: number; bufferAheadMusd?: string; healthLabel?: string }
  collateralValueMusd?: string
  debtMusd?: string
  liquidationPriceWad?: string
}

/**
 * x402 pay-to-deleverage.
 *
 * The resource is the engine service's paid trove report: the redemption-queue position, health band,
 * collateral value and liquidation price an agent or keeper needs before it pays for a de-leverage.
 * Settlement is either a real MUSD transfer the terminal sends from the wallet (retried with
 * `X-PAYMENT-TX`, which the service verifies against the chain) or an EIP-3009 authorisation signed
 * for the facilitator. The terminal never signs anything before the terms are on screen.
 */
export function X402Panel({ defaultAddress }: { defaultAddress?: string }) {
  const { address } = useAccount()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { signTypedDataAsync } = useSignTypedData()
  const { writeContractAsync } = useWriteContract()

  const [trove, setTrove] = useState(defaultAddress ?? '')
  const [phase, setPhase] = useState<Phase>('idle')
  const [challenge, setChallenge] = useState<X402Challenge | null>(null)
  const [report, setReport] = useState<Report | null>(null)
  const [paymentTx, setPaymentTx] = useState<string | null>(null)
  const [settlementNote, setSettlementNote] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const resourcePath = `/api/v1/x402/trove-report/${trove}`
  const url = `${API_BASE}${resourcePath}`
  const accept: X402Accept | null =
    challenge?.accepts.find((entry) => entry.scheme === 'exact') ?? challenge?.accepts[0] ?? null
  const price = accept ? acceptAmount(accept) : 0n

  const probe = async () => {
    if (!isAddress(trove)) return
    setMessage(null)
    setReport(null)
    setPaymentTx(null)
    setPhase('probing')
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      const body: unknown = await response.json().catch(() => null)
      if (response.status !== 402) {
        if (response.ok) {
          setReport(extractReport(body))
          setPhase('paid')
          return
        }
        setPhase('failed')
        setMessage(`Endpoint returned HTTP ${response.status} without an x402 challenge.`)
        return
      }
      const parsed = parseChallenge(response, body)
      if (!parsed) {
        setPhase('failed')
        setMessage('The endpoint requires payment but did not return a parsable x402 challenge.')
        return
      }
      setChallenge(parsed)
      setPhase('terms')
    } catch (error) {
      setPhase('failed')
      setMessage(
        error instanceof Error
          ? `Cannot reach the pay-to-deleverage endpoint at ${url}: ${error.message}`
          : 'Cannot reach the endpoint.',
      )
    }
  }

  /** Primary route: send the MUSD transfer yourself, then prove it with `X-PAYMENT-TX`. */
  const settleWithTransfer = async () => {
    if (!accept || !address || price <= 0n) {
      setMessage('Request terms first, then connect the wallet that will pay.')
      setPhase('failed')
      return
    }
    try {
      setMessage(null)
      setPhase('transferring')
      const hash = await writeContractAsync({
        address: accept.asset,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [accept.payTo, price],
      })
      setPaymentTx(hash)
      setPhase('fetching')
      await publicClient?.waitForTransactionReceipt({ hash, timeout: 150_000 })
      const response = await fetch(url, { headers: { accept: 'application/json', 'x-payment-tx': hash } })
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        setPhase('failed')
        setMessage(`Settlement was rejected (HTTP ${response.status}). The transfer is on chain: verify it in the explorer.`)
        return
      }
      setReport(extractReport(body))
      setSettlementNote(`Settled with an on-chain MUSD transfer to ${accept.payTo}.`)
      setPhase('paid')
    } catch (error) {
      setPhase('failed')
      setMessage(error instanceof Error ? error.message : 'The paid call failed.')
    }
  }

  /** Secondary route: sign an EIP-3009 authorisation for the engine's facilitator. */
  const settleWithSignature = async () => {
    if (!challenge || !accept || !address) {
      setMessage('Request terms first, then connect the wallet that will pay.')
      setPhase('failed')
      return
    }
    try {
      setMessage(null)
      const headerValue = await buildPaymentHeader({
        challenge,
        accept,
        payer: address,
        chainId: chainId || 31611,
        signTypedData: async (args) => {
          setPhase('signing')
          return signTypedDataAsync(args)
        },
      })
      setPhase('fetching')
      const response = await fetch(url, {
        headers: { accept: 'application/json', [challenge.headerName]: headerValue },
      })
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
        setPhase('failed')
        setMessage(
          typeof record?.error === 'string'
            ? record.error
            : `Payment was rejected (HTTP ${response.status}). The facilitator may not be configured on this deployment — the on-chain transfer route always works.`,
        )
        return
      }
      const settlement = parseSettlement(response)
      setReport(extractReport(body))
      setSettlementNote(
        settlement.transaction
          ? `Facilitator settled in ${settlement.transaction.slice(0, 10)}…`
          : 'Facilitator accepted the EIP-3009 authorisation.',
      )
      setPhase('paid')
    } catch (error) {
      setPhase('failed')
      setMessage(error instanceof Error ? error.message : 'The paid call failed.')
    }
  }

  const queue = report?.redemptionQueue
  const troveRecord = report?.trove ?? null
  const icr = typeof troveRecord?.icrWad === 'string' ? troveRecord.icrWad : null

  return (
    <Panel
      label="Pay-to-deleverage · x402"
      meta={
        <>
          <span className="figure text-label text-ink-3">HTTP 402 · exact</span>
          <span className="figure text-label text-ink-3">MUSD on 31611</span>
        </>
      }
      bodyClassName="flex flex-col gap-3 p-0"
    >
      <div className="flex flex-col gap-3 px-3 pt-3">
        <p className="text-body text-ink-2">
          The engine sells the one thing an agent cannot compute for free: a trove&apos;s live place in the
          redemption queue. Pay in MUSD, receive the queue rank, buffer ahead, health band, collateral value and
          liquidation price — the report a keeper needs before it pays to de-leverage a position.
        </p>

        <div className="flex flex-col">
          <SpecRow
            label="Endpoint"
            value={<span className="figure text-meta">GET {resourcePath}</span>}
            tone="muted"
          />
          <SpecRow
            label="Price per call"
            value={price > 0n ? fmtMusd(price, { fixed: 3 }) : 'request terms'}
            tone="amber"
            hint={accept ? `${accept.scheme} · ${accept.network}` : undefined}
          />
          <SpecRow label="Pay to" value={accept ? <AddressChip address={accept.payTo} /> : '—'} tone="muted" />
          <SpecRow
            label="Asset"
            value={accept ? <AddressChip address={accept.asset} /> : '—'}
            tone="muted"
            hint={accept?.extra?.name}
          />
          <SpecRow
            label="Settlement"
            value={accept ? 'MUSD transfer (X-PAYMENT-TX) or EIP-3009' : '—'}
            tone="muted"
          />
        </div>

        <AmountField
          label="Trove address"
          unit="0x…"
          value={trove}
          onChange={setTrove}
          placeholder="0x…"
          hint="any Mezo trove; the report is generated at request time"
        />

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn"
            disabled={!isAddress(trove) || phase === 'probing'}
            onClick={() => void probe()}
          >
            {phase === 'probing' ? 'Requesting…' : 'Request terms'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              !accept || !address || price <= 0n || phase === 'transferring' || phase === 'fetching' || phase === 'signing'
            }
            onClick={() => void settleWithTransfer()}
          >
            {phase === 'transferring'
              ? 'Transferring MUSD…'
              : phase === 'fetching'
                ? 'Fetching report…'
                : price > 0n
                  ? `Pay ${fmtMusd(price, { fixed: 3 })} & fetch`
                  : 'Pay & fetch'}
          </button>
          {accept ? (
            <button
              type="button"
              className="btn btn-quiet"
              disabled={!address || phase === 'signing' || phase === 'fetching'}
              onClick={() => void settleWithSignature()}
              title="Requires the engine service to have an x402 facilitator configured"
            >
              {phase === 'signing' ? 'Signing…' : 'Sign EIP-3009 instead'}
            </button>
          ) : null}
        </div>
      </div>

      {phase === 'terms' && challenge ? (
        <div className="border-t border-rule px-3 py-3">
          <span className="etched">Payment terms decoded</span>
          <div className="pt-2">
            <SpecRow label="Challenge version" value={`x402 v${challenge.version}`} tone="muted" />
            <SpecRow label="Method" value={'method="evm" · EIP-155 31611'} tone="muted" />
            <SpecRow label="Signature type" value="EIP-3009 transferWithAuthorization or direct transfer" tone="muted" />
          </div>
          <p className="pt-2 text-[12px] leading-[1.5] text-ink-3">
            The default route sends a real MUSD transfer from your wallet and retries with the transaction hash,
            which the service verifies on Mezo — no third party in the loop. The signature route only works when
            the deployment has a facilitator configured.
          </p>
        </div>
      ) : null}

      {phase === 'paid' && report ? (
        <div className="border-t border-rule px-3 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="etched text-emerald">Report settled</span>
            <span className="figure text-label text-ink-3">
              {report.generatedAtBlock ? `block ${fmtInt(report.generatedAtBlock)}` : 'live'}
            </span>
          </div>
          <div className="pt-2">
            <SpecRow label="Queue rank" value={queue?.rank ? `#${queue.rank}` : 'not in queue'} tone={queue?.rank ? 'vermilion' : 'muted'} />
            <SpecRow
              label="Buffer ahead"
              value={queue?.bufferAheadMusd ? fmtMusd(queue.bufferAheadMusd) : '—'}
              hint="MUSD redeemed before this trove"
            />
            <SpecRow label="Health band" value={queue?.healthLabel ?? '—'} tone={queue?.healthLabel === 'safe' ? 'emerald' : 'caution'} />
            <SpecRow label="Trove ICR" value={icr ? fmtWadPct(icr) : '—'} />
            <SpecRow label="Collateral value" value={report.collateralValueMusd ? `${report.collateralValueMusd} MUSD` : '—'} tone="amber" />
            <SpecRow label="Debt" value={report.debtMusd ? `${report.debtMusd} MUSD` : '—'} />
            <SpecRow
              label="Liquidation price"
              value={report.liquidationPriceWad ? fmtUsd(report.liquidationPriceWad) : '—'}
              tone="muted"
            />
            <SpecRow label="BTC price used" value={report.btcPriceWad ? fmtUsd(report.btcPriceWad) : '—'} tone="muted" />
          </div>
          {settlementNote ? (
            <p className="pt-2 text-[12px] leading-[1.5] text-ink-3">{settlementNote}</p>
          ) : null}
          {paymentTx ? (
            <div className="pt-2">
              <a
                className="link figure text-meta"
                href={explorerTx(paymentTx)}
                target="_blank"
                rel="noreferrer noopener"
              >
                Verify the settlement transfer on the Mezo explorer ↗
              </a>
            </div>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <div className="border-t border-rule px-3 py-3">
          <StateBlock
            state="error"
            compact
            title="Paid call failed"
            detail={message}
            onRetry={() => void probe()}
            retryLabel="Request terms again"
          />
          {phase === 'failed' && message.includes('Cannot reach') ? (
            <p className="pt-2 text-[12px] leading-[1.5] text-ink-3">
              The paid endpoint lives in the Pylon engine service ({API_BASE}). Start it, or use the Position
              Architect — the same report is computed for free on the terminal.
            </p>
          ) : null}
        </div>
      ) : null}

      {phase === 'idle' && !message ? (
        <div className="border-t border-rule px-3 py-3">
          <p className="text-[12px] leading-[1.5] text-ink-3">
            Humans do not need this endpoint: the radar and the architect already print the queue position for
            every trove. It exists so agents, keeper bots and dashboards can buy one report per decision — and so
            every report is paid for in the asset the protocol runs on.
          </p>
        </div>
      ) : null}
    </Panel>
  )
}

const extractReport = (body: unknown): Report | null => {
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  const nested = record.report
  if (nested && typeof nested === 'object') return nested as Report
  return record as Report
}

export type { Address }
