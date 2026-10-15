'use client'

import { useCallback, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import type { Address, Hex } from 'viem'
import { erc20Abi, pylonEngineAbi, pylonPositionAbi, pylonReserveAbi } from '@/lib/abi'
import { DEPLOYED, explorerTx } from '@/lib/chain'
import type { ExecStage } from './execution'
import { describeExecError } from './execution'

export interface ActionState {
  stage: ExecStage
  hash?: Hex
  explorerUrl?: string
  message?: string
  label?: string
}

const initial: ActionState = { stage: 'idle' }

const RECEIPT_TIMEOUT_MS = 150_000

/**
 * Wallet-side actions that need no EIP-712 relay: shield policy, manual defence, reserve loans and
 * reserve deposits/withdrawals. Every call is encoded locally against the deployed ABIs.
 */export function useChainActions() {
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const [state, setState] = useState<ActionState>(initial)

  const reset = useCallback(() => setState(initial), [])

  const run = useCallback(
    async (label: string, prepare: () => Promise<Hex>) => {
      if (!address) {
        setState({ stage: 'failed', message: 'Connect a wallet first', label })
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
        writeContractAsync({
          address: position,
          abi: pylonPositionAbi,
          functionName: 'setShield',
          args: [enabled, triggerIcrWad, targetIcrWad, maxPerCall],
        }),
      ),
    [run, writeContractAsync],
  )

  const defend = useCallback(
    (position: Address) =>
      run('Permissionless shield defence', async () =>
        writeContractAsync({ address: position, abi: pylonPositionAbi, functionName: 'defend' }),
      ),
    [run, writeContractAsync],
  )

  const repayReserve = useCallback(
    (position: Address, amount: bigint) =>
      run('Repay shield reserve loan', async () =>
        writeContractAsync({
          address: position,
          abi: pylonPositionAbi,
          functionName: 'repayReserve',
          args: [amount],
        }),
      ),
    [run, writeContractAsync],
  )

  /** Deploys a Pylon position (EIP-1167 clone) owned by the connected account. */
  const createPosition = useCallback(
    () =>
      run('Create Pylon position', async () => {
        if (!address) throw new Error('Connect a wallet first')
        return writeContractAsync({
          address: DEPLOYED.engine,
          abi: pylonEngineAbi,
          functionName: 'createPosition',
          args: [address],
        })
      }),
    [address, run, writeContractAsync],
  )

  /** Opens the position's own Mezo trove: BTC collateral is sent with the call, MUSD is borrowed. */
  const openPositionTrove = useCallback(
    (position: Address, collateral: bigint, debt: bigint) =>
      run('Open shielded trove', async () =>
        writeContractAsync({
          address: position,
          abi: pylonPositionAbi,
          functionName: 'openTrove',
          args: [debt],
          value: collateral,
        }),
      ),
    [run, writeContractAsync],
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
          const approveHash = await writeContractAsync({
            address: DEPLOYED.musd,
            abi: erc20Abi,
            functionName: 'approve',
            args: [DEPLOYED.reserve, amount],
          })
          await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: RECEIPT_TIMEOUT_MS })
        }
        return writeContractAsync({
          address: DEPLOYED.reserve,
          abi: pylonReserveAbi,
          functionName: 'deposit',
          args: [amount, receiver],
        })
      }),
    [publicClient, run, writeContractAsync],
  )

  const withdrawReserve = useCallback(
    (shareAmount: bigint, receiver: Address) =>
      run('Redeem shield reserve shares', async () =>
        writeContractAsync({
          address: DEPLOYED.reserve,
          abi: pylonReserveAbi,
          functionName: 'withdraw',
          args: [shareAmount, receiver, receiver],
        }),
      ),
    [run, writeContractAsync],
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
