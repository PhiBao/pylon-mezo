'use client'

import { useCallback, useState } from 'react'
import { useWriteContract } from 'wagmi'
import type { Address, Hex } from 'viem'
import { erc20Abi, pylonEngineAbi, pylonPositionAbi, pylonReserveAbi } from '@/lib/abi'
import { ACTIVE_CHAIN, DEPLOYED, explorerTx } from '@/lib/chain'
import { publicClient as rpcClient } from '@/lib/rpc'
import { demoAccount, demoWalletClient, useSignerAddress } from '@/state/demo-signer'
import type { ExecStage } from './execution'
import { describeExecError } from './execution'

export interface ActionState {
  stage: ExecStage
  hash?: Hex
  explorerUrl?: string
  message?: string
  label?: string
}

/** The shape every write in this module passes: an ABI call, with optional value for payable ones. */
type WriteCall = {
  address: Address
  abi: readonly unknown[]
  functionName: string
  args?: readonly unknown[]
  value?: bigint
}

const initial: ActionState = { stage: 'idle' }

const RECEIPT_TIMEOUT_MS = 150_000

/**
 * Wallet-side actions that need no EIP-712 relay: shield policy, manual defence, reserve loans and
 * reserve deposits/withdrawals. Every call is encoded locally against the deployed ABIs.
 */export function useChainActions() {
  // Same signer abstraction as the ballot path: the demo key, when loaded, drives these writes too.
  const address = useSignerAddress()
  const publicClient = rpcClient
  const { writeContractAsync } = useWriteContract()
  const [state, setState] = useState<ActionState>(initial)

  const reset = useCallback(() => setState(initial), [])

  const write = useCallback(
    async (args: WriteCall): Promise<Hex> => {
      const local = demoAccount()
      if (!local) return writeContractAsync(args as never) as Promise<Hex>
      const wallet = demoWalletClient()
      if (!wallet) throw new Error('Demo signer is no longer loaded — paste the key again')
      return wallet.writeContract({
        account: local,
        chain: ACTIVE_CHAIN,
        ...args,
      } as never) as Promise<Hex>
    },
    [writeContractAsync],
  )

  const run = useCallback(
    async (label: string, prepare: () => Promise<Hex>) => {
      if (!address) {
        setState({ stage: 'failed', message: 'Connect a wallet or load a demo key first', label })
        return
      }
      try {
        setState({ stage: 'preparing', label })
        const hash = await prepare()
        setState({ stage: 'confirming', hash, explorerUrl: explorerTx(hash), label })
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
        if (receipt.status !== 'success') {
          setState({ stage: 'failed', hash, explorerUrl: explorerTx(hash), label, message: 'Transaction reverted' })
          return
        }
        setState({ stage: 'confirmed', hash, explorerUrl: explorerTx(hash), label })
      } catch (error) {
        setState({ stage: 'failed', label, message: describeExecError(error) })
      }
    },
    [address, publicClient],
  )

  const setShield = useCallback(
    (position: Address, enabled: boolean, triggerIcrWad: bigint, targetIcrWad: bigint, maxPerCall: bigint) =>
      run(`${enabled ? 'Enable' : 'Disable'} redemption shield`, async () =>
        write({
          address: position,
          abi: pylonPositionAbi,
          functionName: 'setShield',
          args: [enabled, triggerIcrWad, targetIcrWad, maxPerCall],
        }),
      ),
    [run, write],
  )

  const defend = useCallback(
    (position: Address) =>
      run('Permissionless shield defence', async () =>
        write({ address: position, abi: pylonPositionAbi, functionName: 'defend' }),
      ),
    [run, write],
  )

  const repayReserve = useCallback(
    (position: Address, amount: bigint) =>
      run('Repay shield reserve loan', async () =>
        write({
          address: position,
          abi: pylonPositionAbi,
          functionName: 'repayReserve',
          args: [amount],
        }),
      ),
    [run, write],
  )

  /** Deploys a Pylon position (EIP-1167 clone) owned by the connected account. */
  const createPosition = useCallback(
    () =>
      run('Create Pylon position', async () => {
        if (!address) throw new Error('Connect a wallet or load a demo key first')
        return write({
          address: DEPLOYED.engine,
          abi: pylonEngineAbi,
          functionName: 'createPosition',
          args: [address],
        })
      }),
    [address, run, write],
  )

  /** Opens the position's own Mezo trove: BTC collateral is sent with the call, MUSD is borrowed. */
  const openPositionTrove = useCallback(
    (position: Address, collateral: bigint, debt: bigint) =>
      run('Open shielded trove', async () =>
        write({
          address: position,
          abi: pylonPositionAbi,
          functionName: 'openTrove',
          args: [debt],
          value: collateral,
        }),
      ),
    [run, write],
  )

  /** Approves (only when the allowance is short) and deposits MUSD into the shield reserve. */
  const depositReserve = useCallback(
    (amount: bigint, receiver: Address) =>
      run('Deposit MUSD into the shield reserve', async () => {
        const allowance = await publicClient.readContract({
          address: DEPLOYED.musd,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [receiver, DEPLOYED.reserve],
        })
        if (allowance < amount) {
          const approveHash = await write({
            address: DEPLOYED.musd,
            abi: erc20Abi,
            functionName: 'approve',
            args: [DEPLOYED.reserve, amount],
          })
          await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: RECEIPT_TIMEOUT_MS })
        }
        return write({
          address: DEPLOYED.reserve,
          abi: pylonReserveAbi,
          functionName: 'deposit',
          args: [amount, receiver],
        })
      }),
    [run, write, publicClient],
  )

  const withdrawReserve = useCallback(
    (shareAmount: bigint, receiver: Address) =>
      run('Redeem shield reserve shares', async () =>
        write({
          address: DEPLOYED.reserve,
          abi: pylonReserveAbi,
          functionName: 'withdraw',
          args: [shareAmount, receiver, receiver],
        }),
      ),
    [run, write],
  )

  /** Unused-argument guard: keeps the encoded-call surface explicit for auditing. */
  return {
    state,
    reset,
    setShield,
    defend,
    repayReserve,
    createPosition,
    openPositionTrove,
    depositReserve,
    withdrawReserve,
  }
}
