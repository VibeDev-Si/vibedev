/**
 * The VibeDev gateway's models on the account channel (`deepseek-account`), so
 * the account experience the Harness builds around that channel — models listed
 * first, the sign-in prompt, the top-up prompt on an exhausted balance — serves
 * VibeDev accounts.
 *
 * The catalog comes from the gateway (`GET /v1/models`) with the same
 * credential requests use: the signed-in account's access token, or in
 * development a signature-exempt key named by `apiKeyEnv`. It is read at start,
 * whenever the account changes, and every `catalogRefreshMinutes`; a changed
 * catalog republishes the route so pickers list it.
 *
 * ```yaml
 * - id: llm-vibedev-gateway
 *   name: '@vibedev/dsh-llm-gateway'
 * ```
 *
 * @module @vibedev/dsh-llm-gateway
 */

import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { GatewayAdapter } from './adapter.ts'
import type { GatewayCredential } from './adapter.ts'
import { parseCatalog } from './catalog.ts'
import type { GatewayModel } from './catalog.ts'

export { GatewayAdapter } from './adapter.ts'
export type { GatewayAdapterOptions, GatewayCredential } from './adapter.ts'
export { chooseApi, parseCatalog, preferredApi, startingReasoning } from './catalog.ts'
export type { GatewayApi, GatewayModel, GatewayReasoningLevel } from './catalog.ts'
export { thinkingLevelMap, toPiModel } from './models.ts'

export const name = 'llm-vibedev-gateway'
export const inject = ['llm']

/** The route the gateway's models serve on: the Harness's account channel. */
export const PROVIDER = 'deepseek-account'

export interface Config {
  /** Gateway origin; requests and the catalog go to `<origin>/v1/...`. */
  gatewayOrigin: string
  /** Name selectors show for the route. */
  displayName: string
  /** Environment variable holding a signature-exempt development key, used only while nobody is signed in. */
  apiKeyEnv: string
  /** Minutes between catalog reads while the app runs. */
  catalogRefreshMinutes: number
  /** Timeout for one catalog read. */
  catalogTimeoutMs: number
  /** Prompt-cache retention requested from providers that support it. */
  cacheRetention: 'none' | 'short' | 'long'
}

export const Config: Schema<Config> = Schema.object({
  gatewayOrigin: Schema.string().default('https://vibedev.jzsaas.com'),
  displayName: Schema.string().default('VibeDev'),
  apiKeyEnv: Schema.string().default('VIBEDEV_GATEWAY_API_KEY'),
  catalogRefreshMinutes: Schema.number().min(1).max(1440).default(30),
  catalogTimeoutMs: Schema.number().min(1000).max(120_000).default(20_000),
  cacheRetention: Schema.union([Schema.const('none'), Schema.const('short'), Schema.const('long')]).default('short'),
}) as Schema<Config>

/** Strip trailing slashes so `<origin>/v1/...` never doubles one. */
function originOf(config: Config): string {
  return config.gatewayOrigin.trim().replace(/\/+$/, '')
}

export function apply(ctx: Context, config: Config): void {
  const origin = originOf(config)
  let catalog: readonly GatewayModel[] = []
  let catalogKey = '[]'

  const resolveCredential = async (): Promise<GatewayCredential | undefined> => {
    const token = await ctx.get('deepseekAccount')?.resolveToken(origin)
    if (token !== undefined) return { token, kind: 'account' }
    const key = config.apiKeyEnv === '' ? undefined : process.env[config.apiKeyEnv]?.trim()
    return key === undefined || key === '' ? undefined : { token: key, kind: 'key' }
  }

  const adapter = new GatewayAdapter({
    provider: PROVIDER,
    displayName: config.displayName,
    origin: () => origin,
    catalog: () => catalog,
    resolveCredential,
    rejectToken: token => ctx.get('deepseekAccount')?.rejectToken(token) ?? Promise.resolve(),
    deviceId: async () => (await ctx.get('deepseekAccount')?.getDeviceIdentity())?.deviceId ?? 'vibedev-desktop',
    cacheRetention: config.cacheRetention,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(`llm-vibedev-gateway: unusable replay state on assistant history for "${provider}/${model}"; sending provider-neutral content (${reason})`)
    },
  })
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)

  let reading: Promise<void> | undefined
  let disposed = false
  const readCatalog = (): Promise<void> => {
    reading ??= (async () => {
      try {
        const credential = await resolveCredential()
        let next: readonly GatewayModel[] = []
        if (credential !== undefined) {
          const response = await fetch(`${origin}/v1/models`, {
            headers: { accept: 'application/json', authorization: `Bearer ${credential.token}` },
            signal: AbortSignal.timeout(config.catalogTimeoutMs),
            redirect: 'error',
          })
          if (response.status === 401 && credential.kind === 'account') {
            await ctx.get('deepseekAccount')?.rejectToken(credential.token)
          }
          if (!response.ok) throw new Error(`gateway catalog answered HTTP ${response.status}`)
          next = parseCatalog(await response.json())
        }
        const key = JSON.stringify(next)
        if (disposed || key === catalogKey) return
        catalog = next
        catalogKey = key
        registration.replace([PROVIDER])
        ctx.logger.info(`llm-vibedev-gateway: catalog lists ${next.length} chat model(s)`)
      } catch (error) {
        // A failed read keeps the last catalog: a flaky network must not empty every picker.
        ctx.logger.warn('llm-vibedev-gateway: catalog read failed: %o', error)
      } finally {
        reading = undefined
      }
    })()
    return reading
  }

  ctx.effect(() => {
    void readCatalog()
    const timer = setInterval(() => { void readCatalog() }, config.catalogRefreshMinutes * 60_000)
    timer.unref?.()
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, 'llm-vibedev-gateway: catalog refresh')

  // A sign-in, sign-out, or account switch changes which models the credential may call.
  ctx.inject(['deepseekAccount'], (accountCtx) => {
    accountCtx.effect(() => {
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const _view of accountCtx.deepseekAccount.watch(controller.signal)) void readCatalog()
        } catch (error) {
          if (!controller.signal.aborted) ctx.logger.warn('llm-vibedev-gateway: account watch ended: %o', error)
        }
      })()
      return () => { controller.abort() }
    }, 'llm-vibedev-gateway: account watch')
  })
}
