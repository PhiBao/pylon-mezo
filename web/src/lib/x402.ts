/**
 * x402 client (HTTP 402 / "pay-to-deleverage").
 *
 * Wire format implemented here is the x402 `exact` scheme on EVM:
 *   • v1 challenge: JSON body carrying `x402Version: 1` + `accepts[]`, paid with `X-PAYMENT`
 *   • v2 challenge: base64 JSON in the `PAYMENT-REQUIRED` header, paid with `PAYMENT-SIGNATURE`
 *   • settlement: base64 JSON in the `PAYMENT-RESPONSE` response header
 * Payment authorisation is an EIP-3009 `TransferWithAuthorization`, signed in the user's wallet:
 * the terminal never holds a key and the payer can revoke by spending the nonce.
 *
 * Assumption (documented in the README): the Pylon engine API is the resource server *and* the
 * facilitator — it verifies the signature and redeems the authorisation on Mezo.
 */

import type { Address, Hex } from 'viem'

export interface X402Accept {
  scheme: string
  network: string
  asset: Address
  /** v1 field */
  maxAmountRequired?: string
  /** v2 field */
  amount?: string
  payTo: Address
  resource?: string
  description?: string
  maxTimeoutSeconds?: number
  extra?: { name?: string; version?: string; assetTransferMethod?: string }
}

export interface X402Challenge {
  version: 1 | 2
  accepts: X402Accept[]
  raw: string
  headerName: 'X-PAYMENT' | 'PAYMENT-SIGNATURE'
  resource?: string
}

export interface X402Settlement {
  status?: string
  transaction?: string
  amount?: string
  payer?: string
  network?: string
  success: boolean
  raw: string
}

interface X402Result {
  /** Resource payload returned after payment. */
  resource: unknown
  settlement: X402Settlement
}

const encodeBase64 = (value: string): string => {
  if (typeof window === 'undefined') return Buffer.from(value, 'utf-8').toString('base64')
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return window.btoa(binary)
}

const decodeBase64 = (value: string): string => {
  if (typeof window === 'undefined') return Buffer.from(value, 'base64').toString('utf-8')
  const binary = window.atob(value.trim())
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const randomNonce = (): Hex => {
  const bytes = new Uint8Array(32)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < 32; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex
}

const parseAccepts = (payload: Record<string, unknown>): X402Accept[] => {
  const accepts = payload.accepts
  if (!Array.isArray(accepts)) return []
  return accepts.flatMap((entry) => {
    const record = asRecord(entry)
    if (!record) return []
    const asset = asString(record.asset)
    const payTo = asString(record.payTo)
    const scheme = asString(record.scheme)
    const network = asString(record.network)
    if (!asset || !payTo || !scheme || !network) return []
    const extra = asRecord(record.extra)
    return [
      {
        scheme,
        network,
        asset: asset as Address,
        payTo: payTo as Address,
        maxAmountRequired: asString(record.maxAmountRequired),
        amount: asString(record.amount),
        resource: asString(record.resource),
        description: asString(record.description),
        maxTimeoutSeconds: typeof record.maxTimeoutSeconds === 'number' ? record.maxTimeoutSeconds : undefined,
        extra: extra
          ? {
              name: asString(extra.name),
              version: asString(extra.version),
              assetTransferMethod: asString(extra.assetTransferMethod),
            }
          : undefined,
      },
    ]
  })
}

/** Reads a 402 response in either wire version; returns null when it is not an x402 challenge. */
export const parseChallenge = (response: Response, body: unknown): X402Challenge | null => {
  const headerPayload = response.headers.get('payment-required')
  if (headerPayload) {
    try {
      const payload = asRecord(JSON.parse(decodeBase64(headerPayload)))
      if (payload) {
        return {
          version: 2,
          accepts: parseAccepts(payload),
          raw: headerPayload,
          headerName: 'PAYMENT-SIGNATURE',
          resource: asString(payload.resource),
        }
      }
    } catch {
      return null
    }
  }

  const record = asRecord(body)
  if (record && 'x402Version' in record) {
    return {
      version: 1,
      accepts: parseAccepts(record),
      raw: JSON.stringify(record),
      headerName: 'X-PAYMENT',
      resource: asString(record.resource),
    }
  }
  return null
}

export interface ExactPaymentInput {
  challenge: X402Challenge
  accept: X402Accept
  payer: Address
  chainId: number
  signTypedData: (args: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address }
    types: Record<string, Array<{ name: string; type: string }>>
    primaryType: string
    message: Record<string, unknown>
  }) => Promise<Hex>
}

export const acceptAmount = (accept: X402Accept): bigint => {
  const raw = accept.amount ?? accept.maxAmountRequired ?? '0'
  try {
    return BigInt(raw)
  } catch {
    return 0n
  }
}

/** Signs an EIP-3009 authorisation and returns the header the resource server expects. */
export const buildPaymentHeader = async (input: ExactPaymentInput): Promise<string> => {
  const { challenge, accept, payer, signTypedData } = input
  const value = acceptAmount(accept)
  if (value <= 0n) throw new Error('x402 challenge does not specify a payable amount')
  const name = accept.extra?.name
  if (!name) throw new Error('x402 asset is missing extra.name; cannot build the EIP-712 domain')

  const now = Math.floor(Date.now() / 1000)
  const validAfter = BigInt(now - 60)
  const validBefore = BigInt(now + (accept.maxTimeoutSeconds ?? 300))

  const authorization = {
    from: payer,
    to: accept.payTo,
    value,
    validAfter,
    validBefore,
    nonce: randomNonce(),
  }

  const signature = await signTypedData({
    domain: {
      name,
      version: accept.extra?.version ?? '2',
      chainId: input.chainId,
      verifyingContract: accept.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: { ...authorization, validAfter, validBefore },
  })

  const payload =
    challenge.version === 1
      ? {
          x402Version: 1,
          scheme: accept.scheme,
          network: accept.network,
          payload: { signature, authorization },
        }
      : {
          x402Version: 2,
          scheme: accept.scheme,
          network: accept.network,
          accepted: accept,
          payload: { signature, authorization },
        }

  return encodeBase64(JSON.stringify(payload))
}

export const parseSettlement = (response: Response): X402Settlement => {
  const header = response.headers.get('payment-response')
  if (!header) return { success: response.ok, raw: '' }
  try {
    const payload = asRecord(JSON.parse(decodeBase64(header))) ?? {}
    const status = asString(payload.status)
    return {
      status,
      transaction: asString(payload.transaction),
      amount: asString(payload.amount),
      payer: asString(payload.payer),
      network: asString(payload.network),
      success: response.ok && (status === undefined || status === 'success' || status === 'settled'),
      raw: header,
    }
  } catch {
    return { success: response.ok, raw: header }
  }
}

interface PayToDeleverageInput {
  url: string
  body: unknown
  payer: Address
  chainId: number
  signTypedData: ExactPaymentInput['signTypedData']
  signal?: AbortSignal
}

/**
 * Full paid call: probe → on 402 sign the exact-scheme authorisation → replay once with the
 * payment header. Replaying with a stale signature is never retried automatically.
 */
export const payToDeleverage = async (input: PayToDeleverageInput): Promise<X402Result> => {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(input.body),
    signal: input.signal,
  }

  const probe = await fetch(input.url, init)
  const probeBody: unknown = await probe.json().catch(() => null)

  if (probe.status !== 402) {
    if (!probe.ok) {
      const record = asRecord(probeBody)
      throw new Error(
        asString(record?.error) ?? `Pay-to-deleverage endpoint returned HTTP ${probe.status}`,
      )
    }
    return { resource: probeBody, settlement: { success: true, raw: '' } }
  }

  const challenge = parseChallenge(probe, probeBody)
  if (!challenge) throw new Error('Endpoint requires payment but did not return an x402 challenge')
  const accept = challenge.accepts.find((entry) => entry.scheme === 'exact') ?? challenge.accepts[0]
  if (!accept) throw new Error('x402 challenge carries no acceptable payment option')

  const headerValue = await buildPaymentHeader({
    challenge,
    accept,
    payer: input.payer,
    chainId: input.chainId,
    signTypedData: input.signTypedData,
  })

  const paid = await fetch(input.url, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), [challenge.headerName]: headerValue },
  })
  const paidBody: unknown = await paid.json().catch(() => null)

  if (!paid.ok) {
    const record = asRecord(paidBody)
    throw new Error(asString(record?.error) ?? `Payment rejected (HTTP ${paid.status})`)
  }

  return { resource: paidBody, settlement: parseSettlement(paid) }
}
