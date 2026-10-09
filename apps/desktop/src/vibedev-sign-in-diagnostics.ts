/** Safe VibeDev login diagnostics at the plugin/native boundary; never accept raw failure messages. */
import type { AccountView, SignInAttemptView, SignInErrorCode } from '@deepseek-ai/dsh-deepseek-account/types'

const phases = ['preparing', 'waiting-browser', 'exchanging', 'committing', 'succeeded', 'failed', 'cancelled', 'expired'] as const
const codes = ['network', 'timeout', 'gateway-refused', 'gateway-unavailable', 'protocol', 'storage', 'callback'] as const
const stages = ['listen', 'device', 'redeem', 'persist'] as const
const networkCodes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'] as const

/** Only classified, credential-free fields may cross into the welcome window. */
export interface VibeDevSignInDiagnostic {
  readonly gatewayOrigin?: string
  readonly errorCode?: typeof codes[number]
  readonly stage?: typeof stages[number]
  readonly httpStatus?: number
  readonly networkCode?: typeof networkCodes[number]
}

/** Optional VibeDev details extend the native view without changing DeepSeek's contract. */
export type DesktopSignInAttempt = SignInAttemptView & { readonly vibedevDiagnostic?: VibeDevSignInDiagnostic }
export type DesktopAccountView = Omit<AccountView, 'attempt'> & { readonly attempt: DesktopSignInAttempt | null }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function member<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === 'string' && values.includes(value as T) ? value as T : undefined
}

/** @param value - untrusted origin field. @returns origin only, with no userinfo, path or query. */
function safeOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.origin : undefined
  } catch { return undefined }
}

/** @param value - untrusted detail fields. @returns selected, validated diagnostics only. */
export function safeVibeDevDiagnostic(value: unknown): VibeDevSignInDiagnostic {
  if (!record(value)) return {}
  const gatewayOrigin = safeOrigin(value.gatewayOrigin)
  const errorCode = member(value.errorCode, codes)
  const stage = member(value.stage, stages)
  const networkCode = member(value.networkCode, networkCodes)
  const httpStatus = typeof value.httpStatus === 'number' && Number.isInteger(value.httpStatus)
    && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : undefined
  return {
    ...gatewayOrigin === undefined ? {} : { gatewayOrigin }, ...errorCode === undefined ? {} : { errorCode },
    ...stage === undefined ? {} : { stage }, ...httpStatus === undefined ? {} : { httpStatus },
    ...networkCode === undefined ? {} : { networkCode },
  }
}

/** @param value - plugin attempt. @returns a native attempt containing no gateway-controlled failure text. */
export function nativeVibeDevAttempt(value: unknown): DesktopSignInAttempt | undefined {
  if (!record(value) || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id)
    || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return undefined
  const phase = member(value.phase, phases)
  if (phase === undefined) return undefined
  const diagnostic = safeVibeDevDiagnostic(value)
  const code: SignInErrorCode | undefined = diagnostic.errorCode === 'timeout' ? 'no-response'
    : diagnostic.errorCode === 'gateway-refused' || diagnostic.errorCode === 'gateway-unavailable' ? 'network'
      : diagnostic.errorCode === 'callback' ? 'protocol' : diagnostic.errorCode
  return {
    id: value.id as SignInAttemptView['id'], phase: phase === 'preparing' ? 'initializing' : phase, expiresAt: value.expiresAt,
    ...code === undefined ? {} : { errorCode: code }, vibedevDiagnostic: diagnostic,
  }
}

/** @param attempt - safe attempt. @returns compact support details, never an authorization URL. */
export function vibeDevDiagnosticText(attempt: DesktopSignInAttempt | null | undefined): string | undefined {
  if (attempt?.vibedevDiagnostic === undefined) return undefined
  const diagnostic = safeVibeDevDiagnostic(attempt.vibedevDiagnostic)
  const id = /^[a-zA-Z0-9_-]{1,80}$/.test(attempt.id) ? attempt.id : undefined
  return [diagnostic.errorCode, diagnostic.stage, diagnostic.httpStatus === undefined ? undefined : `HTTP ${diagnostic.httpStatus}`,
    diagnostic.networkCode, diagnostic.gatewayOrigin, id].filter(value => value !== undefined).join(' · ')
}
