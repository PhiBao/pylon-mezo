/**
 * Execution assembly for the signed trove operations.
 *
 * Two broadcast routes exist and both are real:
 *
 *   ENGINE   sign EIP-712 → POST /api/v1/execute/* → the engine service relays the transaction.
 *            Works for wallets that cannot send EVM transactions themselves.
 *   WALLET   sign EIP-712 → build calldata → `sendTransaction` from the connected account.
 *            The terminal computes the nonce, the `SortedTroves` hints and the request struct
 *            on-chain, so it needs no backend at all (this is what read-only RPC mode uses).
 *
 * The EIP-712 structs mirror `BorrowerOperationsSignatures` exactly; the on-chain proof script
 * (contracts/script/Prove.s.sol) reconstructs the same digest.
 */

import { encodeFunctionData, type Address, type Hex } from 'viem'
import { DEPLOYED, trustedTargets } from './chain'
import { borrowerOpsSignaturesAbi, hintHelpersAbi, pylonEngineAbi, sortedTrovesAbi } from './abi'
import { publicClient } from './rpc'

export const ADJUST_TROVE_TYPES = {
  AdjustTrove: [
    { name: 'collWithdrawal', type: 'uint256' },
    { name: 'debtChange', type: 'uint256' },
    { name: 'isDebtIncrease', type: 'bool' },
    { name: 'assetAmount', type: 'uint256' },
    { name: 'borrower', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export const CLOSE_TROVE_TYPES = {
  CloseTrove: [
    { name: 'borrower', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

const domain = () => ({
  name: 'BorrowerOperationsSignatures',
  version: '1',
  chainId: DEPLOYED.chainId,
  verifyingContract: DEPLOYED.borrowerOpsSignatures,
})

export interface LoopIntent {
  owner: Address
  /** MUSD borrowed from the trove (the flashed amount). */
  debtAmount: bigint
  /** BTC collateral added back to the trove. */
  collAdd: bigint
  minPostICR: bigint
  deadline: number
  nonce: bigint
  hints: { upper: Address; lower: Address }
  recipient: Address
}

export interface UnwindIntent {
  owner: Address
  repay: bigint
  /** BTC ceiling withdrawn from the trove to fund the repayment. */
  collOut: bigint
  minPostICR: bigint
  deadline: number
  nonce: bigint
  hints: { upper: Address; lower: Address }
  recipient: Address
}

export interface ExitIntent {
  owner: Address
  deadline: number
  nonce: bigint
  recipient: Address
}

export const loopTypedData = (intent: LoopIntent) =>
  ({
    domain: domain(),
    types: ADJUST_TROVE_TYPES,
    primaryType: 'AdjustTrove',
    message: {
      collWithdrawal: 0n,
      debtChange: intent.debtAmount,
      isDebtIncrease: true,
      assetAmount: intent.collAdd,
      borrower: intent.owner,
      recipient: intent.recipient,
      nonce: intent.nonce,
      deadline: BigInt(intent.deadline),
    },
  }) as const

export const unwindTypedData = (intent: UnwindIntent) =>
  ({
    domain: domain(),
    types: ADJUST_TROVE_TYPES,
    primaryType: 'AdjustTrove',
    message: {
      collWithdrawal: intent.collOut,
      debtChange: intent.repay,
      isDebtIncrease: false,
      assetAmount: 0n,
      borrower: intent.owner,
      recipient: intent.recipient,
      nonce: intent.nonce,
      deadline: BigInt(intent.deadline),
    },
  }) as const

export const exitTypedData = (intent: ExitIntent) =>
  ({
    domain: domain(),
    types: CLOSE_TROVE_TYPES,
    primaryType: 'CloseTrove',
    message: {
      borrower: intent.owner,
      recipient: intent.recipient,
      nonce: intent.nonce,
      deadline: BigInt(intent.deadline),
    },
  }) as const

/* ------------------------------------------------------------------ on-chain scaffolding */

export const readNonce = async (owner: Address): Promise<bigint> =>
  publicClient.readContract({
    address: DEPLOYED.borrowerOpsSignatures,
    abi: borrowerOpsSignaturesAbi,
    functionName: 'getNonce',
    args: [owner],
  })

/** `SortedTroves` insert position for a target nominal CR, as the BorrowingOperations expects it. */
export const computeHints = async (nicr: bigint): Promise<{ upper: Address; lower: Address }> => {
  const [approx] = await publicClient.readContract({
    address: DEPLOYED.hintHelpers,
    abi: hintHelpersAbi,
    functionName: 'getApproxHint',
    args: [nicr, 40n, BigInt(Date.now())],
  })
  const [upper, lower] = await publicClient.readContract({
    address: DEPLOYED.sortedTroves,
    abi: sortedTrovesAbi,
    functionName: 'findInsertPosition',
    args: [nicr, approx, approx],
  })
  return { upper, lower }
}

export const nicrOf = (coll: bigint, debt: bigint): bigint => (debt === 0n ? 0n : (coll * 10n ** 18n) / debt)

/* --------------------------------------------------------------------- calldata */

interface SelfBroadcastCall {
  to: Address
  data: Hex
  value: bigint
}

export const encodeLoop = (intent: LoopIntent, signature: Hex): SelfBroadcastCall => ({
  to: DEPLOYED.engine,
  value: 0n,
  data: encodeFunctionData({
    abi: pylonEngineAbi,
    functionName: 'loopSigned',
    args: [
      {
        owner: intent.owner,
        debtAmount: intent.debtAmount,
        collAdd: intent.collAdd,
        outputTo: intent.owner,
        minPostICR: intent.minPostICR,
        deadline: BigInt(intent.deadline),
        upperHint: intent.hints.upper,
        lowerHint: intent.hints.lower,
        signature,
      },
    ],
  }),
})

export const encodeUnwind = (intent: UnwindIntent, signature: Hex): SelfBroadcastCall => ({
  to: DEPLOYED.engine,
  value: 0n,
  data: encodeFunctionData({
    abi: pylonEngineAbi,
    functionName: 'unwindSigned',
    args: [
      {
        owner: intent.owner,
        repayAmount: intent.repay,
        collOut: intent.collOut,
        outputTo: intent.owner,
        minPostICR: intent.minPostICR,
        deadline: BigInt(intent.deadline),
        upperHint: intent.hints.upper,
        lowerHint: intent.hints.lower,
        signature,
      },
    ],
  }),
})

export const encodeExit = (intent: ExitIntent, signature: Hex): SelfBroadcastCall => ({
  to: DEPLOYED.engine,
  value: 0n,
  data: encodeFunctionData({
    abi: pylonEngineAbi,
    functionName: 'closeSigned',
    args: [
      {
        owner: intent.owner,
        outputTo: intent.owner,
        deadline: BigInt(intent.deadline),
        signature,
      },
    ],
  }),
})

/* ------------------------------------------------------------- backend templates */

/**
 * The engine API may hand back calldata with a `{signature}` placeholder instead of the wallet
 * struct. Substituting the 65-byte signature keeps the wallet route available for any operation
 * the backend knows how to assemble.
 */
export const applySignatureTemplate = (data: string, signature: Hex): Hex => {
  const substituted = data.includes('{signature}')
    ? data.replaceAll('{signature}', signature.slice(2))
    : data
  if (!/^0x[0-9a-fA-F]*$/.test(substituted)) {
    throw new Error('Engine returned calldata that is not hex')
  }
  return substituted as Hex
}

/**
 * Wallet transactions are refused for any destination outside the deployed Pylon/Mezo set, so a
 * malformed or hostile `tx` payload from the engine service cannot be signed into a send.
 */
export const isTrustedTarget = (to: Address): boolean =>
  trustedTargets().some((known) => known.toLowerCase() === to.toLowerCase())

export const DEFAULT_DEADLINE_SECONDS = 30 * 60

export const deadlineFromNow = (seconds = DEFAULT_DEADLINE_SECONDS): number =>
  Math.floor(Date.now() / 1000) + seconds

/**
 * Slippage floor handed to the engine: never accept a post-operation ICR below the target the user
 * set, minus a small tolerance for interest accrued between quote and inclusion.
 */
export const minPostIcrFrom = (targetIcrWad: bigint, toleranceBps = 100n): bigint =>
  targetIcrWad - (targetIcrWad * toleranceBps) / 10_000n
