'use client'

import { useCallback, useState } from 'react'
import { useAccount, useChainId, useSendTransaction, useSignTypedData, useSwitchChain } from 'wagmi'
import type { Address, Hex } from 'viem'
import { api, ApiError, type Eip712TypedData } from '@/lib/api'
import {ACTIVE_CHAIN, DEPLOYED, explorerTx, NETWORK_LABEL } from '@/lib/chain'
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
import { demoAccount, demoWalletClient, useDemoSigner } from '@/state/demo-signer'

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
  const demo = useDemoSigner()
  const { signTypedDataAsync } = useSignTypedData()
  const { sendTransactionAsync } = useSendTransaction()
  const { switchChainAsync } = useSwitchChain()
  const [state, setState] = useState<ExecState>(initial)

  // A demo key, when loaded, is the signer for this session: it signs the same EIP-712 ballot the
  // wallet would, and sends through the same trusted targets. No extension involved.
  const signerAddress = demo.address ?? address ?? null
  const signTyped = useCallback(
    async (payload: Parameters<typeof signTypedDataAsync>[0]) => {
      const local = demoAccount()
      if (local) return local.signTypedData(payload as never)
      return signTypedDataAsync(payload)
    },
    [signTypedDataAsync],
  )
  const sendTransaction = useCallback(
    async (call: { to: `0x${string}`; data: `0x${string}`; value: bigint }) => {
      const local = demoAccount()
      if (!local) return sendTransactionAsync(call)
      const wallet = demoWalletClient()
      if (!wallet) throw new Error('Demo signer is no longer loaded — paste the key again')
      return wallet.sendTransaction({ account: local, chain: ACTIVE_CHAIN, ...call })
    },
    [sendTransactionAsync],
  )

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
        message: `Transaction reverted on ${NETWORK_LABEL}`,
      })
      return
    }
    setState({ stage: 'confirmed', hash, explorerUrl: explorerTx(hash), label })
  }, [])

  const runLoop = useCallback(
    async (input: LoopRequestInput, route: BroadcastRoute) => {
      if (!signerAddress) {
        setState({ stage: 'failed', message: 'Connect a wallet or load a demo key to sign the trove authorisation' })
        return
      }
      const label = `Flash loop ${input.collAdd.toString()} wei → ${input.debtAmount.toString()} wei`
      try {
        setState({ stage: 'preparing', label })
        const deadline = deadlineFromNow()

        if (route === 'engine') {
          // The relay submits with `outputTo = owner`, so the ballot names the borrower as the
          // recipient. Positions ignore the signature (their owner authorises the engine), native
          // troves verify it against exactly these fields.
          const minPostIcr = minPostIcrFrom(input.targetIcrWad)
          const intent: LoopIntent = {
            owner: input.owner,
            debtAmount: input.debtAmount,
            collAdd: input.collAdd,
            minPostICR: minPostIcr,
            deadline,
            nonce: await readNonce(input.owner),
            hints: input.hints,
            recipient: input.owner,
          }
          setState({ stage: 'signing', label })
          const signature = await signTyped(loopTypedData(intent))
          setState({ stage: 'broadcasting', label, route: 'engine' })
          const receipt = await api.executeLoop({
            owner: input.owner,
            collAdd: input.collAdd.toString(),
            debtAmount: input.debtAmount.toString(),
            signature,
            deadline,
            minPostIcr: minPostIcr.toString(),
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
        const signature = await signTyped(loopTypedData(intent))
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
        const hash = await sendTransaction(call)
        await confirmReceipt(hash, label)
      } catch (error) {
        setState({ stage: 'failed', label, message: describeExecError(error) })
      }
    },
    [signerAddress, confirmReceipt, sendTransaction, signTyped, address],
  )

  const runUnwind = useCallback(
    async (input: UnwindRequestInput, route: BroadcastRoute) => {
      if (!signerAddress) {
        setState({ stage: 'failed', message: 'Connect a wallet or load a demo key to sign the trove authorisation' })
        return
      }
      const label = `Flash unwind ${input.repay.toString()} wei`
      try {
        setState({ stage: 'preparing', label })
        const deadline = deadlineFromNow()

        if (route === 'engine') {
          const minPostIcr = minPostIcrFrom(input.targetIcrWad)
          const intent: UnwindIntent = {
            owner: input.owner,
            repay: input.repay,
            collOut: input.collOut,
            minPostICR: minPostIcr,
            deadline,
            nonce: await readNonce(input.owner),
            hints: input.hints ?? {
              upper: '0x0000000000000000000000000000000000000000',
              lower: '0x0000000000000000000000000000000000000000',
            },
            recipient: input.owner,
          }
          setState({ stage: 'signing', label })
          const signature = await signTyped(unwindTypedData(intent))
          setState({ stage: 'broadcasting', label, route: 'engine' })
          const receipt = await api.executeUnwind({
            owner: input.owner,
            repay: input.repay.toString(),
            collOut: input.collOut.toString(),
            signature,
            deadline,
            minPostIcr: minPostIcr.toString(),
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
        const signature = await signTyped(unwindTypedData(intent))
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
        const hash = await sendTransaction(call)
        await confirmReceipt(hash, label)
      } catch (error) {
        setState({ stage: 'failed', label, message: describeExecError(error) })
      }
    },
    [signerAddress, confirmReceipt, sendTransaction, signTyped, address],
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

        if (route === 'engine') {
          const intent: ExitIntent = {
            owner: input.owner,
            deadline,
            nonce: await readNonce(input.owner),
            recipient: input.owner,
          }
          setState({ stage: 'signing', label })
          const signature = await signTyped(exitTypedData(intent))
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
        const signature = await signTyped(exitTypedData(intent))
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
        const hash = await sendTransaction(call)
        await confirmReceipt(hash, label)
      } catch (error) {
        setState({ stage: 'failed', label, message: describeExecError(error) })
      }
    },
    [signerAddress, confirmReceipt, sendTransaction, signTyped, address],
  )

  return {
    state,
    reset,
    runLoop,
    runUnwind,
    runExit,
    walletReady: Boolean(signerAddress),
    wrongChain: !demo.address && Boolean(address) && chainId !== ACTIVE_CHAIN.id,
    switchToMezo: () => {
      void switchChainAsync({ chainId: ACTIVE_CHAIN.id }).catch(() => undefined)
    },
  }
}

export const describeExecError = (error: unknown): string => {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) {
    if (/user rejected|denied/i.test(error.message)) return 'Signature rejected in the wallet'
    if (/insufficient funds/i.test(error.message)) return `Wallet has no BTC for gas on ${NETWORK_LABEL}`
    return error.message
  }
  return 'Unexpected execution error'
}

