/**
 * Typed client for the Pylon engine API (Rust service, default http://localhost:8787).
 *
 * The terminal treats the API as an accelerator, never as a dependency: every read has an RPC
 * fallback in `lib/rpc.ts` and every write has a self-broadcast path. Callers distinguish an
 * *unreachable* engine (fall back silently) from a *rejected* request (surface it) via
 * `shouldFallBack`.
 */

import type {
  EngineConfig,
  ExitQuote,
  LoopQuote,
  Market,
  ProofLedger,
  Radar,
  Reserve,
  Trove,
  UnwindQuote,
  Address,
  Wei,
} from './types'

export type {
  Address,
  EngineConfig,
  ExitQuote,
  LoopQuote,
  Market,
  Proof,
  ProofLedger,
  Radar,
  RadarTrove,
  Reserve,
  Sourced,
  Trove,
  UnwindQuote,
  Wei,
  Wad,
} from './types'

export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8787').replace(
  /\/+$/,
  '',
)

export type ApiErrorKind = 'unreachable' | 'timeout' | 'http' | 'shape' | 'rejected'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  readonly url: string

  constructor(kind: ApiErrorKind, message: string, url: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.url = url
    this.status = status
  }
}

/** Unreachable / broken engine → the UI is expected to fall back to chain reads. */
export const shouldFallBack = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.kind === 'unreachable' || error.kind === 'timeout' || error.kind === 'http')

export const describeError = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.kind === 'unreachable' || error.kind === 'timeout') {
      return `Pylon engine API unavailable at ${API_BASE}`
    }
    return error.message
  }
  if (error instanceof Error) return error.message
  return 'Unexpected error'
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { timeoutMs = 9_000, headers, ...rest } = options
  const url = `${API_BASE}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(url, {
      ...rest,
      signal: rest.signal ?? controller.signal,
      headers: {
        accept: 'application/json',
        ...(rest.body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
    })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError'
    throw new ApiError(
      timedOut ? 'timeout' : 'unreachable',
      timedOut ? `Request to ${path} timed out` : `Cannot reach the Pylon engine at ${API_BASE}`,
      url,
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    let detail = ''
    try {
      const body: unknown = await response.json()
      if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>
        const raw = record.error ?? record.message
        if (typeof raw === 'string') detail = raw
      }
    } catch {
      detail = ''
    }
    throw new ApiError(
      response.status >= 500 ? 'http' : 'rejected',
      `Engine rejected ${path} (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
      url,
      response.status,
    )
  }

  try {
    return (await response.json()) as T
  } catch {
    throw new ApiError('shape', `Engine returned a non-JSON body for ${path}`, url, response.status)
  }
}

/* ---------------------------------------------------------------- wire shapes */

/** API payloads carry no provenance tag; the query layer adds `source: 'engine'`. */
export type LoopQuoteWire = Omit<LoopQuote, 'source' | 'pylonFeeBps' | 'flashFeeBps'>
export type UnwindQuoteWire = Omit<UnwindQuote, 'source'>
export type ExitQuoteWire = Omit<ExitQuote, 'source'>

export interface Eip712TypedData {
  domain: Record<string, unknown>
  types: Record<string, Array<{ name: string; type: string }>>
  primaryType: string
  message: Record<string, unknown>
}

export interface CallTemplate {
  to: Address
  data: string
  value?: string
}

export interface BuildResponse<Quote> {
  typedData: Eip712TypedData
  tx: CallTemplate
  /** Calldata template carrying a `{signature}` placeholder for wallet self-broadcast. */
  txWithSignatureTemplate?: CallTemplate
  hints: { upper: Address; lower: Address }
  quote: Quote
}

/** Optional fields the engine adds to a config payload; all are used when present. */
export interface EngineConfigExtras {
  borrowerOps?: Address
  hintHelpers?: Address
  priceFeed?: Address
  deployer?: Address
}

export interface ExecutionReceipt {
  txHash: string
  explorerUrl?: string
}

/* ------------------------------------------------------------------ endpoints */

export const api = {
  config: () => request<EngineConfig>('/api/v1/config'),

  market: () => request<Market>('/api/v1/market'),

  radar: (limit = 80) => request<Radar>(`/api/v1/radar?limit=${encodeURIComponent(String(limit))}`),

  /**
   * The engine service returns `{ trove, hints, nextNonce, musdBalance, btcBalance }`; older or
   * slimmer deployments return the trove fields at the top level. Both are accepted.
   */
  trove: async (address: string): Promise<Trove> => {
    const payload = await request<Trove | { trove: Trove; hints?: { upper: Address; lower: Address } }>(
      `/api/v1/trove/${address}`,
    )
    if (payload && typeof payload === 'object' && 'trove' in payload && payload.trove) {
      return { ...payload.trove, hints: payload.hints ?? payload.trove.hints }
    }
    return payload as Trove
  },

  loopQuote: (collAdd: Wei, owner?: string) =>
    request<LoopQuoteWire>(
      `/api/v1/quote/loop?collAdd=${collAdd}${owner ? `&owner=${owner}` : ''}`,
    ),

  unwindQuote: (address: string, repay: Wei) =>
    request<UnwindQuoteWire>(`/api/v1/quote/unwind?address=${address}&repay=${repay}`),

  exitQuote: (address: string) => request<ExitQuoteWire>(`/api/v1/quote/exit?address=${address}`),

  /**
   * The engine reports outstanding defence loans under `positions` (with owner, ICR and shield
   * state) or, in earlier builds, under `loans`. Normalise to `loans`.
   */
  reserve: async (): Promise<Reserve> => {
    const payload = await request<Reserve & { positions?: Array<Record<string, unknown>> }>(
      '/api/v1/reserve',
    )
    const raw = payload.positions ?? []
    const loans =
      payload.loans && payload.loans.length > 0
        ? payload.loans
        : raw.flatMap((entry) => {
            const position = entry.position
            const loan = entry.loan
            if (typeof position !== 'string' || typeof loan !== 'string') return []
            return [
              {
                position: position as Address,
                loan,
                owner: typeof entry.owner === 'string' ? (entry.owner as Address) : undefined,
                icrWad: typeof entry.icrWad === 'string' ? entry.icrWad : undefined,
                shieldEnabled: entry.shieldEnabled === true,
              },
            ]
          })
    return { ...payload, loans }
  },

  proofs: () => request<ProofLedger>('/api/v1/proofs'),

  buildLoop: (body: { owner: Address; collAdd: Wei; debtAmount: Wei }) =>
    request<BuildResponse<LoopQuoteWire>>('/api/v1/build/loop', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  executeLoop: (body: {
    owner: Address
    collAdd: Wei
    debtAmount: Wei
    signature: string
    deadline?: number
  }) =>
    request<ExecutionReceipt>('/api/v1/execute/loop', {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: 60_000,
    }),

  /**
   * Unwind and exit mirror the loop endpoints. The engine contract exposes `unwindSigned` and
   * `closeSigned` alongside `loopSigned`, so the API is assumed to publish the same build/execute
   * pair; when it does not, the terminal self-broadcasts from the connected wallet instead.
   */
  buildUnwind: (body: { owner: Address; repay: Wei; collOut?: Wei }) =>
    request<BuildResponse<UnwindQuoteWire>>('/api/v1/build/unwind', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  executeUnwind: (body: {
    owner: Address
    repay: Wei
    collOut?: Wei
    signature: string
    deadline?: number
  }) =>
    request<ExecutionReceipt>('/api/v1/execute/unwind', {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: 60_000,
    }),

  buildExit: (body: { owner: Address }) =>
    request<BuildResponse<ExitQuoteWire>>('/api/v1/build/exit', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  executeExit: (body: { owner: Address; signature: string; deadline?: number }) =>
    request<ExecutionReceipt>('/api/v1/execute/exit', {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: 60_000,
    }),
}
