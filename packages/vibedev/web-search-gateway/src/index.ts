/**
 * VibeDev gateway web search for the web capability seam (`ctx.web`). The
 * `vibedev-gateway` provider calls the gateway's `POST /v1/vibedev/web-search`
 * with the credential the gateway models use: the signed-in account's access
 * token, or in development a signature-exempt key named by `apiKeyEnv`.
 *
 * ```yaml
 * - id: web-search-vibedev
 *   name: '@vibedev/dsh-web-search-gateway'
 * - id: web
 *   config:
 *     searchProvider: vibedev-gateway
 *     fetchProvider: http
 * ```
 *
 * @module @vibedev/dsh-web-search-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { userAgent } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-web'
import { GatewaySearchProvider } from './provider.ts'
import type { GatewaySearchCredential } from './provider.ts'

export { GATEWAY_SEARCH_PROVIDER_ID, GatewaySearchProvider, mapSearchResponse, requestBody, retryAfterMs } from './provider.ts'
export type { GatewaySearchCredential, GatewaySearchOptions } from './provider.ts'

export const name = 'web-search-vibedev'
export const inject = ['web']

/** Gateway search endpoint, development credential name and bounded retry policy. */
export interface Config {
  /** Gateway origin; searches go to `<origin>/v1/vibedev/web-search`. */
  gatewayOrigin: string
  /** Environment variable holding a signature-exempt development key, used only while nobody is signed in. */
  apiKeyEnv: string
  /** Deadline for one search request. */
  requestTimeoutMs: number
  /** Retries after a rate-limited or busy answer. */
  maxRetries: number
  /** Longest `Retry-After` waited out before the search fails. */
  maxRetryWaitMs: number
}

export const Config = Schema.object({
  gatewayOrigin: Schema.string().default('https://vibedev.jzsaas.com'),
  apiKeyEnv: Schema.string().default('VIBEDEV_GATEWAY_API_KEY'),
  requestTimeoutMs: Schema.number().min(1000).max(120_000).default(20_000),
  maxRetries: Schema.number().min(0).max(5).step(1).default(2),
  maxRetryWaitMs: Schema.number().min(0).max(60_000).default(10_000),
})

export function apply(ctx: Context, config: Config): void {
  const endpoint = `${config.gatewayOrigin.trim().replace(/\/+$/, '')}/v1/vibedev/web-search`
  ctx.web.registerSearchProvider(new GatewaySearchProvider({
    endpoint,
    resolveCredential: async (): Promise<GatewaySearchCredential | undefined> => {
      const token = await ctx.get('deepseekAccount')?.resolveToken(endpoint)
      if (token !== undefined) return { token, kind: 'account' }
      const key = config.apiKeyEnv === '' ? undefined : process.env[config.apiKeyEnv]?.trim()
      return key === undefined || key === '' ? undefined : { token: key, kind: 'key' }
    },
    rejectToken: token => ctx.get('deepseekAccount')?.rejectToken(token) ?? Promise.resolve(),
    userAgent: userAgent(),
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    maxRetryWaitMs: config.maxRetryWaitMs,
  }))
}
