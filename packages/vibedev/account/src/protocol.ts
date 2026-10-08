/**
 * The VibeDev gateway's app-token sign-in protocol (gateway spec
 * DSH-GATEWAY-APP-TOKEN-SPEC-1002): browser authorization code with PKCE,
 * app tokens with rotating refresh tokens, and the account read. Responses are
 * bounded and validated; errors carry a stable code, never a body or token.
 */
import { z } from 'zod'

/** Client identity the gateway binds the authorization code and app session to. */
export const CLIENT_ID = 'vibedev-desktop'

/**
 * Loopback route receiving the browser's authorization code. Distinct from the
 * DeepSeek provider's exact `/oauth/callback`, so both can never collide.
 */
export const CALLBACK_PATH = '/oauth/vibedev/callback'

/** Safe failure classification rendered by the shared account UI. */
export type AuthErrorCode = 'network' | 'protocol' | 'expired' | 'storage'

/** Gateway failures expose a stable code, never a response body, URL, or token. */
export class VibeDevAuthError extends Error {
  /** @param code - safe error classification. */
  constructor(readonly code: AuthErrorCode) { super(`vibedev-account: ${code}`) }
}

/** The gateway rejected an access or refresh token (HTTP 401); the stored login is no longer usable. */
export class AccountUnauthorizedError extends VibeDevAuthError {
  constructor() { super('expired') }
}

/**
 * Accept the HTTPS gateway origin, or an explicitly enabled loopback HTTP origin for local development.
 * @param value - configured origin.
 * @param allowLoopbackHttp - development-only opt-in.
 * @returns normalized origin.
 */
export function gatewayOrigin(value: string, allowLoopbackHttp: boolean): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !(url.protocol === 'https:' || (allowLoopbackHttp && loopback && url.protocol === 'http:'))) {
    throw new Error('vibedev-account: gatewayOrigin must be an HTTPS origin or an explicitly enabled loopback HTTP origin')
  }
  return url.origin
}

/**
 * Accept a browser-accessible loopback HTTP origin for local or SSH-forwarded sign-in.
 * @param value - loopback HTTP origin with an explicit port, supplied by the initiating client.
 * @returns normalized origin; remote domains and path-based proxies are unsupported.
 */
export function loginOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new VibeDevAuthError('protocol') }
  const explicitPort = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]+)\/?$/i.exec(value)?.[1]
  if (explicitPort === undefined || Number(explicitPort) === 0
    || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new VibeDevAuthError('protocol')
  }
  return `${url.protocol}//${url.hostname}:${Number(explicitPort)}`
}

/**
 * The gateway's browser authorization page for one attempt. Only the PKCE challenge travels in the URL.
 * @param origin - validated gateway origin.
 * @param options - loopback callback URL, attempt state, and PKCE S256 challenge.
 * @returns the `/vibedev-link` URL in authorization-code mode.
 */
export function authorizeUrl(origin: string, options: { callback: string; state: string; challenge: string }): string {
  const url = new URL('/vibedev-link', origin)
  url.searchParams.set('callback', options.callback)
  url.searchParams.set('state', options.state)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('code_challenge', options.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('client', CLIENT_ID)
  return url.href
}

const printable = z.string().regex(/^[\x21-\x7e]+$/)

/** Token pair returned by redeem and refresh. */
export const tokenPair = z.object({
  access_token: printable,
  expires_in: z.number().int().positive(),
  refresh_token: printable,
  refresh_expires_in: z.number().int().positive().optional(),
  session_id: z.string().min(1).optional(),
  user: z.unknown().optional(),
})
/** Validated access and refresh tokens returned by gateway authorization. */
export type TokenPair = z.infer<typeof tokenPair>

/** The fields of `GET /v1/account/auth/me` the account surfaces use; the gateway sends more. */
export const accountMe = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  email: z.string().nullish(),
  nickname: z.string().nullish(),
  username: z.string().nullish(),
  balance: z.union([z.number(), z.string()]),
  currency: z.enum(['CNY', 'USD']).optional(),
})
/** Validated identity and balance fields read by the account service. */
export type AccountMe = z.infer<typeof accountMe>

const envelope = z.object({ code: z.literal(0), data: z.unknown() })

/** Request options shared by every gateway call. */
interface GatewayRequest {
  readonly method: 'GET' | 'POST'
  readonly body?: unknown
  /** App access token sent as a Bearer credential. */
  readonly token?: string
  readonly headers?: Record<string, string>
  readonly signal: AbortSignal
}

/**
 * Call one fixed gateway endpoint and return the envelope's `data`.
 * @param origin - validated gateway origin.
 * @param path - fixed endpoint path.
 * @param request - method, body, credential and deadline.
 * @returns the successful payload, validated by the caller.
 * @throws AccountUnauthorizedError on 401; VibeDevAuthError('network' | 'protocol') otherwise.
 */
export async function gatewayRequest(origin: string, path: string, request: GatewayRequest): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${origin}${path}`, {
      method: request.method,
      redirect: 'error',
      signal: request.signal,
      headers: {
        ...request.headers,
        accept: 'application/json',
        ...request.body === undefined ? {} : { 'content-type': 'application/json' },
        ...request.token === undefined ? {} : { authorization: `Bearer ${request.token}` },
      },
      ...request.body === undefined ? {} : { body: JSON.stringify(request.body) },
    })
  } catch {
    throw new VibeDevAuthError('network')
  }
  if (response.status === 401) {
    await response.body?.cancel()
    throw new AccountUnauthorizedError()
  }
  // 400/403 are definite refusals (bad request, unusable grant); anything else non-2xx may pass.
  if (response.status === 400 || response.status === 403) {
    await response.body?.cancel()
    throw new VibeDevAuthError('protocol')
  }
  // 204 is a complete success with nothing to return (revoke).
  if (response.status === 204) {
    await response.body?.cancel()
    return undefined
  }
  const body = response.body
  if (!response.ok || body === null) {
    await body?.cancel()
    throw new VibeDevAuthError('network')
  }
  const payload = await readBounded(body)
  const parsed = envelope.safeParse(payload)
  if (!parsed.success) throw new VibeDevAuthError('protocol')
  return parsed.data.data
}

/** Read at most 64 KiB of JSON; larger or malformed bodies are protocol errors. */
async function readBounded(body: ReadableStream<Uint8Array>): Promise<unknown> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 65_536) throw new VibeDevAuthError('protocol')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    if (error instanceof VibeDevAuthError) throw error
    throw new VibeDevAuthError('protocol')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/**
 * Validate a payload against a schema, mapping a mismatch to a protocol error.
 * @param schema - expected shape.
 * @param payload - envelope data.
 * @returns the parsed value.
 */
export function expectShape<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new VibeDevAuthError('protocol')
  return parsed.data
}
