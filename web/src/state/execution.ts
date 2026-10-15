'use client'

import { useCallback, useState } from 'react'
import { useAccount, useChainId, useSendTransaction, useSignTypedData, useSwitchChain } from 'wagmi'
import type { Address, Hex, TypedData, TypedDataDomain } from 'viem'
import { api, ApiError, type Eip712TypedData } from '@/lib/api'
import { DEPLOYED, explorerTx, mezoTestnet } from '@/lib/chain'
import {
  applySignatureTemplate,
  computeHints,
  deadlineFromNow,
  encodeExit,
  encodeLoop,
  encodeUnwind,
  exitTypedData,
  isTrustedTarget,
  loopTypedData,
  minPostIcrFrom,
  nicrOf,
  readNonce,
  unwindTypedData,
  type ExitIntent,
  type LoopIntent,
  type UnwindIntent,
} from '@/lib/execution'
import { publicClient } from '@/lib/rpc'

export type BroadcastRoute = 'engine' | 'wallet'

export type ExecStage =
  | 'idle'
  | 'preparing'
  | 'signing'
  | 'broadcasting'
  | 'confirming'
  | 'confirmed'
  | 'failed'

export interface ExecState {
  stage: ExecStage
  hash?: Hex
  explorerUrl?: string
  message?: string
  route?: BroadcastRoute
  /** Human-readable description of the operation that produced this state. */
  label?: string
}

const initial: ExecState = { stage: 'idle' }

const RECEIPT_TIMEOUT_MS = 150_000

const asViemTypedData = (payload: Eip712TypedData) => {
  if (!payload.domain || !payload.types || !payload.primaryType) {
    throw new Error('Engine returned incomplete EIP-712 typed data')
  }
  if (!(payload.primaryType in payload.types)) {
    throw new Error(`Engine typed data has no ${payload.primaryType} struct definition`)
  }
  return {
    domain: payload.domain as TypedDataDomain,
    // The API publishes the struct definitions as plain JSON; the runtime check above guarantees
    // the primary type exists before viem signs anything.
    types: payload.types as unknown as TypedData,
    primaryType: payload.primaryType,
    message: payload.message,
  }
}

export interface LoopRequestInput {
  owner: Address
  collAdd: bigint
  debtAmount: bigint
  targetIcrWad: bigint
  hints: { upper: Address; lower: Address }
  /** Engine-assembled typed data; when omitted the terminal assembles it locally. */
  typedData?: Eip712TypedData
  /** Engine-assembled calldata with a `{signature}` placeholder for the wallet route. */
  txTemplate?: { to: Address; data: string; value?: string }
}

export interface UnwindRequestInput {
  owner: Address
  repay: bigint
  collOut: bigint
  targetIcrWad: bigint
  hints: { upper: Address; lower: Address } | null
  typedData?: Eip712TypedData
  txTemplate?: { to: Address; data: string; value?: string }
  postColl: bigint
  postDebt: bigint
}

export interface ExitRequestInput {
  owner: Address
  typedData?: Eip712TypedData
  txTemplate?: { to: Address; data: string; value?: string }
}

export interface AtomicExecution {
  state: ExecState
  reset: () => void
  runLoop: (input: LoopRequestInput, route: BroadcastRoute) => Promise<void>
  runUnwind: (input: UnwindRequestInput, route: BroadcastRoute) => Promise<void>
  runExit: (input: ExitRequestInput, route: BroadcastRoute) => Promise<void>
  /** True when the connected wallet can sign and send EVM transactions. */
  walletReady: boolean
  wrongChain: boolean
  switchToMezo: () => void
}

/**
 * Drives one atomic Pylon operation: prepare → sign → broadcast → confirm.
 *
 * The UI never invents a transaction: the route either relays engine-assembled calldata through the
 * Pylon engine service, or reproduces the same struct locally from the quote and sends it from the
 * connected wallet. Targets outside the deployed Pylon/Mezo set are refused.
 */
export function useAtomicExecution(): AtomicExecution {
  const { address } = useAccount()
  const chainId = useChainId()
  const { signTypedDataAsync } = useSignTypedData()
  const { sendTransactionAsync } = useSendTransaction()
  const { switchChainAsync } = useSwitchChain()
  const [state, setState] = useState<ExecState>(initial)

  const reset = useCallback(() => setState(initial), [])

  const confirmReceipt = useCallback(async (hash: Hex, label: string) => {
    setState({ stage: 'confirming', hash, explorerUrl: explorerTx(hash), label })
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
    if (receipt.status !== 'success') {
      setState({
        stage: 'failed',
        hash,
        explorerUrl: explorerTx(hash),
        label,
        message: 'Transaction reverted on Mezo Testnet',
      })
      return
    }
    setState({ stage: 'confirmed', hash, explorerUrl: explorerTx(hash), label })
  }, [])

  const runLoop = useCallback(
    async (input: LoopRequestInput, route: BroadcastRoute) => {
      if (!address) {
        setState({ stage: 'failed', message: 'Connect a wallet to sign the trove authorisation' })
        return
      }
      const label = `Flash loop ${input.collAdd.toString()} wei → ${input.debtAmount.toString()} wei`
      try {
        setState({ stage: 'preparing', label })
        const deadline = deadlineFromNow()

        if (route === 'engine' && input.typedData) {
          setState({ stage: 'signing', label })
          const signature = await signTypedDataAsync(asViemTypedData(input.typedData))
          setState({ stage: 'broadcasting', label, route: 'engine' })
          const receipt = await api.executeLoop({
            owner: input.owner,
            collAdd: input.collAdd.toString(),
            debtAmount: input.debtAmount.toString(),
            signature,
            deadline,
          })
          await confirmReceipt(receipt.txHash as Hex, label)
          return
        }

        const intent: LoopIntent = {
          owner: input.owner,
          debtAmount: input.debtAmount,
          collAdd: input.collAdd,
          minPostICR: minPostIcrFrom(input.targetIcrWad),
          deadline,
          nonce: await readNonce(input.owner),
          hints: input.hints,
          recipient: DEPLOYED.engine,
        }
        setState({ stage: 'signing', label })
        const signature = await signTypedDataAsync(loopTypedData(intent))
        setState({ stage: 'broadcasting', label, route: 'wallet' })

        const call = input.txTemplate
          ? {
              to: input.txTemplate.to,
              data: applySignatureTemplate(input.txTemplate.data, signature),
              value: BigInt(input.txTemplate.value ?? '0'),
            }
          : encodeLoop(intent, signature)

        if (!isTrustedTarget(call.to)) {
          throw new Error(`Refusing to send: ${call.to} is not a deployed Pylon or Mezo contract`)
        }
        const hash = await sendTransactionAsync(call)
        await confirmReceipt(hash, label)
      } catch (error) {
        setState({ stage: 'failed', label, message: describeExecError(error) })
      }
    },
    [address, confirmReceipt, sendTransactionAsync, signTypedDataAsync],
  )

  const runUnwind = useCallback(
    async (input: UnwindRequestInput, route: BroadcastRoute) => {
      if (!address) {
        setState({ stage: 'failed', message: 'Connect a wallet to sign the trove authorisation' })
        return
      }
      const label = `Flash unwind ${input.repay.toString()} wei`
      try {
        setState({ stage: 'preparing', label })
        const deadline = deadlineFromNow()

        if (route === 'engine' && input.typedData) {
          setState({ stage: 'signing', label })
          const signature = await signTypedDataAsync(asViemTypedData(input.typedData))
          setState({ stage: 'broadcasting', label, route: 'engine' })
          const receipt = await api.executeUnwind({
            owner: input.owner,
            repay: input.repay.toString(),
            collOut: input.collOut.toString(),
            signature,
            deadline,
          })
          await confirmReceipt(receipt.txHash as Hex, label)
          return
        }

        const hints = input.hints ?? (await computeHints(nicrOf(input.postColl, input.postDebt)))
        const intent: UnwindIntent = {
          owner: input.owner,
          repay: input.repay,
          collOut: input.collOut,
          minPostICR: minPostIcrFrom(input.targetIcrWad),
          deadline,
          nonce: await readNonce(input.owner),
          hints,
          recipient: DEPLOYED.engine,
        }
        setState({ stage: 'signing', label })
        const signature = await signTypedDataAsync(unwindTypedData(intent))
        setState({ stage: 'broadcasting', label, route: 'wallet' })

        const call = input.txTemplate
          ? {
              to: input.txTemplate.to,
              data: applySignatureTemplate(input.txTemplate.data, signature),
              value: BigInt(input.txTemplate.value ?? '0'),
            }
          : encodeUnwind(intent, signature)

        if (!isTrustedTarget(call.to)) {
          throw new Error(`Refusing to send: ${call.to} is not a deployed Pylon or Mezo contract`)
        }
        const hash = await sendTransactionAsync(call)
        await confirmReceipt(hash, label)
      } catch (error) {
        setState({ stage: 'failed', label, message: describeExecError(error) })
      }
    },
    [address, confirmReceipt, sendTransactionAsync, signTypedDataAsync],
  )

  const runExit = useCallback(
    async (input: ExitRequestInput, route: BroadcastRoute) => {
      if (!address) {
        setState({ stage: 'failed', message: 'Connect a wallet to sign the close authorisation' })
        return
      }
      const label = 'Flash exit — close trove'
      try {
        setState({ stage: 'preparing', label })
        const deadline = deadlineFromNow()

        if (route === 'engine' && input.typedData) {
          setState({ stage: 'signing', label })
          const signature = await signTypedDataAsync(asViemTypedData(input.typedData))
          setState({ stage: 'broadcasting', label, route: 'engine' })
          const receipt = await api.executeExit({ owner: input.owner, signature, deadline })
          await confirmReceipt(receipt.txHash as Hex, label)
          return
        }

        const intent: ExitIntent = {
          owner: input.owner,
          deadline,
          nonce: await readNonce(input.owner),
          recipient: DEPLOYED.engine,
        }
        setState({ stage: 'signing', label })
        const signature = await signTypedDataAsync(exitTypedData(intent))
        setState({ stage: 'broadcasting', label, route: 'wallet' })

        const call = input.txTemplate
          ? {
              to: input.txTemplate.to,
              data: applySignatureTemplate(input.txTemplate.data, signature),
              value: BigInt(input.txTemplate.value ?? '0'),
            }
          : encodeExit(intent, signature)

        if (!isTrustedTarget(call.to)) {
          throw new Error(`Refusing to send: ${call.to} is not a deployed Pylon or Mezo contract`)
        }
        const hash = await sendTransactionAsync(call)
        await confirmReceipt(hash, label)
      } catch (error) {
        setState({ stage: 'failed', label, message: describeExecError(error) })
      }
    },
    [address, confirmReceipt, sendTransactionAsync, signTypedDataAsync],
  )

  return {
    state,
    reset,
    runLoop,
    runUnwind,
    runExit,
    walletReady: Boolean(address) && chainId === mezoTestnet.id,
    wrongChain: Boolean(address) && chainId !== mezoTestnet.id,
    switchToMezo: () => {
      void switchChainAsync({ chainId: mezoTestnet.id }).catch(() => undefined)
    },
  }
}

export const describeExecError = (error: unknown): string => {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) {
    if (/user rejected|denied/i.test(error.message)) return 'Signature rejected in the wallet'
    if (/insufficient funds/i.test(error.message)) return 'Wallet has no BTC for gas on Mezo Testnet'
    return error.message
  }
  return 'Unexpected execution error'
}

