'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { parseEventLogs, parseEther, type Address, type Hex } from 'viem'
import { usePublicClient, useWriteContract } from 'wagmi'
import { pylonEngineAbi, pylonPositionAbi } from '@/lib/abi'
import { DEPLOYED, explorerTx } from '@/lib/chain'
import { fmtMusd, fmtWadPct } from '@/lib/format'
import type { EngineConfig, Market, WalletChainState } from '@/lib/types'
import { describeExecError } from '@/state/execution'

const STORAGE_KEY = (owner: Address) => `pylon.position.${owner.toLowerCase()}`

/**
 * The first-run path. A visitor without a Mezo trove previously had to leave the terminal, open one in
 * Mezo, and come back. This card does both steps in place: it creates the Pylon position (the clone
 * that holds the shield policy) and opens that position's trove with the visitor's own BTC.
 *
 * The trove belongs to the position, whose owner is the connected wallet. Pylon never holds the
 * collateral or the keys — the position is the trove owner, and only the wallet can withdraw.
 */
export function OpenTroveCard({
  owner,
  config,
  market,
  wallet,
  onOpened,
}: {
  owner: Address
  config: EngineConfig
  market: Market | null
  wallet: WalletChainState | null
  onOpened?: () => void
}) {
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const [position, setPosition] = useState<Address | null>(null)
  const [collateral, setCollateral] = useState('')
  const [debt, setDebt] = useState('')
  const [stage, setStage] = useState<'idle' | 'creating' | 'opening' | 'done'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [hash, setHash] = useState<Hex | null>(null)

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY(owner))
      if (saved && /^0x[0-9a-fA-F]{40}$/.test(saved)) setPosition(saved as Address)
    } catch {
      /* private mode: no memory, the flow still works in one session */
    }
  }, [owner])

  const minNetDebt = BigInt(config.minNetDebt)
  const gasCompensation = BigInt(config.gasCompensation)
  const ccr = BigInt(config.ccrWad ?? '1500000000000000000')
  const price = market ? BigInt(market.btcPriceWad) : 0n

  // Start from the smallest valid trove, so the form opens in a state that can be submitted.
  useEffect(() => {
    if (debt !== '' || price === 0n) return
    setDebt(formatEtherOf(minNetDebt))
  }, [debt, minNetDebt, price])

  useEffect(() => {
    if (collateral !== '' || price === 0n) return
    const total = minNetDebt + minNetDebt / 1000n + gasCompensation
    const forCcr = (total * ccr) / 10n ** 18n / price
    setCollateral(formatEtherOf(forCcr + forCcr / 50n)) // ~2% headroom over the minimum
  }, [collateral, minNetDebt, gasCompensation, ccr, price])

  const numbers = useMemo(() => {
    try {
      const coll = parseEther(collateral || '0')
      const borrow = parseEther(debt || '0')
      const fee = borrow / 1000n // 0.1% borrowing fee, as Mezo charges
      const total = borrow + fee + gasCompensation
      const icr = total === 0n ? 0n : (coll * price) / (10n ** 18n * total)
      return { coll, borrow, total, icr }
    } catch {
      return null
    }
  }, [collateral, debt, gasCompensation, price])

  const problem = useMemo(() => {
    if (!numbers) return 'Enter an amount'
    if (numbers.borrow === 0n || numbers.coll === 0n) return 'Enter an amount'
    if (numbers.borrow < minNetDebt) return `Mezo's minimum borrow is ${fmtMusd(minNetDebt.toString())}`
    if (numbers.icr < ccr) return `Mezo needs at least ${fmtWadPct(ccr.toString())} at open`
    if (wallet && numbers.coll > wallet.btcBalance) return 'More BTC than this wallet holds'
    return null
  }, [numbers, minNetDebt, ccr, wallet])

  const submit = useCallback(async () => {
    if (!numbers || problem) return
    setMessage(null)
    try {
      let target = position
      if (!target) {
        setStage('creating')
        const createHash = await writeContractAsync({
          address: DEPLOYED.engine,
          abi: pylonEngineAbi,
          functionName: 'createPosition',
          args: [owner],
        })
        setHash(createHash)
        const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash })
        const [created] = parseEventLogs({
          abi: pylonEngineAbi,
          logs: receipt.logs,
          eventName: 'PositionCreated',
        })
        const address = created?.args?.position as Address | undefined
        if (!address) throw new Error('the new position was not in the receipt')
        target = address
        setPosition(address)
        try {
          localStorage.setItem(STORAGE_KEY(owner), address)
        } catch {
          /* ignore */
        }
      }
      setStage('opening')
      const openHash = await writeContractAsync({
        address: target,
        abi: pylonPositionAbi,
        functionName: 'openTrove',
        args: [numbers.borrow],
        value: numbers.coll,
      })
      setHash(openHash)
      await publicClient.waitForTransactionReceipt({ hash: openHash })
      setStage('done')
      onOpened?.()
    } catch (error) {
      setStage('idle')
      setMessage(describeExecError(error))
    }
  }, [numbers, problem, position, owner, writeContractAsync, publicClient, onOpened])

  if (stage === 'done') {
    return (
      <div className="px-3 py-3">
        <div className="flex flex-col gap-1">
          <span className="figure text-meta text-emerald">Trove open — you are in</span>
          <p className="text-[12px] leading-[1.5] text-ink-3">
            Your Pylon position owns the trove. Loop it, arm a shield, or unwind it from this panel.
          </p>
        </div>
        {hash ? (
          <a
            href={explorerTx(hash)}
            target="_blank"
            rel="noreferrer noopener"
            className="figure mt-2 inline-block text-meta text-amber underline-offset-2 hover:underline"
          >
            View the transaction
          </a>
        ) : null}
      </div>
    )
  }

  const busy = stage === 'creating' || stage === 'opening'

  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      <div className="flex flex-col gap-1">
        <span className="etched">Open a shielded trove</span>
        <p className="text-[12px] leading-[1.5] text-ink-3">
          You have no trove yet. This opens one in two transactions: a Pylon position, then that
          position&apos;s Mezo trove funded with your BTC. Pylon never holds the collateral — the
          position owns the trove and only this wallet can withdraw from it.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="figure text-label text-ink-3">BTC collateral</span>
          <input
            className="field h-8 text-meta"
            inputMode="decimal"
            value={collateral}
            onChange={(event) => setCollateral(event.target.value.trim())}
            placeholder="0.000"
            spellCheck={false}
            aria-label="BTC collateral"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="figure text-label text-ink-3">MUSD to borrow</span>
          <input
            className="field h-8 text-meta"
            inputMode="decimal"
            value={debt}
            onChange={(event) => setDebt(event.target.value.trim())}
            placeholder="1800"
            spellCheck={false}
            aria-label="MUSD to borrow"
          />
        </label>
      </div>

      <div className="flex flex-col gap-1 border-t border-rule pt-2">
        <span className="flex items-baseline justify-between gap-3">
          <span className="figure text-label text-ink-3">debt incl. fee + gas comp</span>
          <span className="figure text-meta text-ink">
            {numbers ? fmtMusd(numbers.total.toString(), { fixed: 2 }) : '—'}
          </span>
        </span>
        <span className="flex items-baseline justify-between gap-3">
          <span className="figure text-label text-ink-3">collateral ratio at open</span>
          <span
            className={`figure text-meta ${
              numbers && numbers.icr >= ccr ? 'text-emerald' : 'text-vermilion'
            }`}
          >
            {numbers && numbers.icr > 0n ? fmtWadPct(numbers.icr.toString()) : '—'}
          </span>
        </span>
        {wallet ? (
          <span className="flex items-baseline justify-between gap-3">
            <span className="figure text-label text-ink-3">wallet BTC</span>
            <span className="figure text-meta text-ink-3">
              {(Number(wallet.btcBalance) / 1e18).toFixed(6)}
            </span>
          </span>
        ) : null}
      </div>

      {problem ? <span className="figure text-label text-vermilion">{problem}</span> : null}
      {message ? <span className="text-[12px] leading-[1.5] text-vermilion">{message}</span> : null}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={Boolean(problem) || busy || !numbers}
        className="btn btn-primary h-9 w-full text-meta disabled:opacity-40"
      >
        {stage === 'creating'
          ? 'Creating the position…'
          : stage === 'opening'
            ? 'Opening the trove…'
            : position
              ? 'Open the trove'
              : 'Create position and open trove'}
      </button>

      <p className="text-[12px] leading-[1.5] text-ink-3">
        Need testnet BTC for collateral?{' '}
        <a
          href="https://faucet.test.mezo.org"
          target="_blank"
          rel="noreferrer noopener"
          className="text-amber underline-offset-2 hover:underline"
        >
          The Mezo faucet
        </a>{' '}
        sends it to this wallet.
      </p>
    </div>
  )
}

/** 1e18-scaled integer as a plain decimal string with up to six decimals, no trailing zeros. */
function formatEtherOf(value: bigint): string {
  const whole = value / 10n ** 18n
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}
