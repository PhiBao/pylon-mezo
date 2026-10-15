'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Panel } from '@/components/ui/Panel'
import { StateBlock, Badge } from '@/components/ui/StateBlock'
import { explorerBlock, explorerTx } from '@/lib/chain'
import { fmtAge, fmtBtc, fmtInt, fmtMusd, shortAddress, shortHash } from '@/lib/format'
import type { ProofKind } from '@/lib/types'
import { useProofs } from '@/state/queries'

const KIND_TONE: Record<ProofKind, 'neutral' | 'amber' | 'vermilion' | 'emerald' | 'caution'> = {
  loop: 'amber',
  unwind: 'emerald',
  exit: 'vermilion',
  shield: 'caution',
  reserve: 'neutral',
  deploy: 'neutral',
}

const KIND_LABEL: Record<ProofKind, string> = {
  loop: 'loop',
  unwind: 'unwind',
  exit: 'exit',
  shield: 'shield',
  reserve: 'reserve',
  deploy: 'deploy',
}

/**
 * Proof ledger.
 *
 * A product that moves collateral between legs inside one transaction has to show its receipts: this
 * is the explorer-linked record of every operation Pylon has executed. When the engine API is down
 * the terminal shows the frozen deployment ledger from the repository's broadcast log instead, and
 * says so.
 */
export function ProofLedger({
  connectedAddress,
  limit,
  withFilters = false,
}: {
  connectedAddress: string | null
  limit?: number
  withFilters?: boolean
}) {
  const proofs = useProofs()
  const [filter, setFilter] = useState<ProofKind | 'all' | 'mine'>('all')

  const all = proofs.data?.value.proofs ?? []
  const filtered = all.filter((proof) => {
    if (filter === 'all') return true
    if (filter === 'mine') {
      return Boolean(connectedAddress) && proof.actor.toLowerCase() === connectedAddress?.toLowerCase()
    }
    return proof.kind === filter
  })
  const rows = limit ? filtered.slice(0, limit) : filtered

  return (
    <Panel
      label="Proof ledger · Mezo Testnet"
      meta={
        <>
          <Badge tone={proofs.data?.source === 'engine' ? 'emerald' : 'caution'}>
            {proofs.data?.source === 'engine' ? 'live' : 'frozen deployment ledger'}
          </Badge>
          <span className="figure text-label text-ink-3">{fmtInt(filtered.length)} entries</span>
        </>
      }
      bodyClassName="flex flex-col gap-0 p-0"
    >
      {withFilters ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2">
          <span className="etched">Filter</span>
          {(['all', 'loop', 'unwind', 'exit', 'shield', 'reserve', 'mine'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`chip chip-link ${filter === value ? 'border-amber/60 text-amber' : ''}`}
              onClick={() => setFilter(value)}
            >
              {value}
            </button>
          ))}
        </div>
      ) : null}

      {proofs.isLoading ? (
        <div className="px-3 py-3">
          <StateBlock state="loading" title="Loading the proof ledger" skeletonRows={4} />
        </div>
      ) : null}

      {proofs.isError ? (
        <div className="px-3 py-3">
          <StateBlock
            state="error"
            title="Ledger unavailable"
            detail={proofs.error instanceof Error ? proofs.error.message : 'The proof ledger did not answer.'}
            onRetry={() => void proofs.refetch()}
          />
        </div>
      ) : null}

      {!proofs.isLoading && !proofs.isError && rows.length === 0 ? (
        <div className="px-3 py-3">
          <StateBlock
            state="empty"
            title={filter === 'mine' ? 'No proofs from this wallet yet' : 'No proofs recorded'}
            detail={
              filter === 'mine'
                ? 'Run a flash loop, unwind, exit or shield defence from this wallet and its explorer-linked receipt will appear here.'
                : 'The ledger fills as Pylon operations execute on Mezo Testnet.'
            }
          />
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="max-h-[420px] overflow-auto">
          <table className="ledger">
            <thead>
              <tr>
                <th className="cell-l w-[86px]">Kind</th>
                <th className="cell-l">Transaction</th>
                <th className="cell-l">Actor</th>
                <th className="cell-l">Note</th>
                <th>MUSD</th>
                <th>BTC</th>
                <th>Fee</th>
                <th>Block</th>
                <th className="cell-l w-[80px]">Age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((proof) => (
                <tr key={proof.id}>
                  <td className="cell-l">
                    <Badge tone={KIND_TONE[proof.kind]}>{KIND_LABEL[proof.kind]}</Badge>
                  </td>
                  <td className="cell-l">
                    <a
                      className="figure text-amber underline decoration-rule-3 underline-offset-2 hover:decoration-amber"
                      href={proof.explorerUrl || explorerTx(proof.txHash)}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={proof.txHash}
                    >
                      {shortHash(proof.txHash)}
                    </a>
                  </td>
                  <td className="cell-l text-ink-2" title={proof.actor}>
                    {shortAddress(proof.actor)}
                  </td>
                  <td className="cell-l max-w-[280px] truncate text-ink-2" title={proof.note}>
                    {proof.note}
                  </td>
                  <td>{proof.musd ? fmtMusd(proof.musd) : '—'}</td>
                  <td>{proof.btc ? fmtBtc(proof.btc) : '—'}</td>
                  <td>{proof.feeMusd ? fmtMusd(proof.feeMusd) : '—'}</td>
                  <td className="text-ink-2">
                    {proof.block ? (
                      <a
                        className="hover:text-amber"
                        href={explorerBlock(proof.block)}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {fmtInt(proof.block)}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="cell-l text-ink-3">{fmtAge(proof.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5 border-t border-rule px-3 py-2">
        <span className="figure text-label text-ink-3">
          {proofs.data?.source === 'engine'
            ? 'Read from the Pylon engine service'
            : 'Frozen ledger from contracts/broadcast · engine API offline'}
        </span>
        {limit ? (
          <Link href="/proofs/" className="link figure text-meta">
            All proofs →
          </Link>
        ) : null}
      </div>
    </Panel>
  )
}
