/** The plugin reads the gateway catalog with the request credential and publishes it on the account channel. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { volatileForm } from '@deepseek-ai/dsh-settings/src/schema.ts'
import * as Gateway from '../src/index.ts'
import { parseCatalog } from '../src/catalog.ts'
import { CATALOG, closeGatewayDoubles, gatewayDouble } from './gateway-double.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeGatewayDoubles()
})

/** Let the plugin's startup and watch-driven reads run. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30))

/**
 * A stand-in account service: a token once signed in, a way to hold token reads open, and a
 * watch stream that yields once for every state change the test reports.
 */
function fakeAccount() {
  let token: string | undefined
  let gate: Promise<void> = Promise.resolve()
  const listeners = new Set<() => void>()
  return {
    signIn: (value: string): void => { token = value },
    /** Hold the token reads that start from now on until the returned release is called. */
    hold: (): (() => void) => {
      let release: () => void = () => {}
      gate = new Promise<void>((resolve) => { release = resolve })
      return () => { gate = Promise.resolve(); release() }
    },
    notify: (): void => { for (const listener of listeners) listener() },
    service: {
      resolveToken: (_url: string): Promise<string | undefined> => {
        const value = token
        return gate.then(() => value)
      },
      rejectToken: (): Promise<void> => Promise.resolve(),
      getDeviceIdentity: (): Promise<undefined> => Promise.resolve(undefined),
      async *watch(signal: AbortSignal): AsyncIterable<{ status: string }> {
        let pending = 0
        let wake: (() => void) | undefined
        const changed = (): void => { pending++; wake?.() }
        listeners.add(changed)
        const stop = (): void => { wake?.() }
        signal.addEventListener('abort', stop, { once: true })
        try {
          while (!signal.aborted) {
            if (pending > 0) {
              pending--
              yield { status: 'credential-stored' }
              continue
            }
            await new Promise<void>((resolve) => { wake = resolve })
          }
        } finally {
          listeners.delete(changed)
          signal.removeEventListener('abort', stop)
        }
      },
    },
  }
}

describe('llm-vibedev-gateway settings', () => {
  it('has a live-editable field, so the settings service serves the namespace the Models page lists the account row under', () => {
    expect(volatileForm(Gateway.Config)).toBeDefined()
  })
})

describe('preferredFirst', () => {
  it('lists the preferred models first in their order and keeps the rest in catalog order', () => {
    const models = parseCatalog(CATALOG)
    expect(Gateway.preferredFirst(models, ['deepseek-v4-flash', 'missing', 'gpt-5.5']).map(model => model.id))
      .toEqual(['deepseek-v4-flash', 'gpt-5.5', 'claude-opus-5-5', 'glm-5.3'])
    expect(Gateway.preferredFirst(models, []).map(model => model.id)).toEqual(models.map(model => model.id))
  })
})

describe('llm-vibedev-gateway plugin', () => {
  it('lists the catalog chat models under the account channel when a development key is set', async () => {
    const gateway = await gatewayDouble(CATALOG)
    vi.stubEnv('VIBEDEV_TEST_GATEWAY_KEY', 'sk-exempt-dev')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Gateway, { gatewayOrigin: `${gateway.url}/`, apiKeyEnv: 'VIBEDEV_TEST_GATEWAY_KEY' })
    await vi.waitFor(async () => {
      const listed = await ctx.llm.listModels(Gateway.PROVIDER)
      expect(listed.map(model => model.id)).toEqual(['deepseek-v4-flash', 'claude-opus-5-5', 'gpt-5.5', 'glm-5.3'])
    })
    expect(gateway.catalogRequests[0]?.headers.authorization).toBe('Bearer sk-exempt-dev')
    await ctx.fiber.dispose()
  })

  it('reads the catalog again when the sign-in stores its credential during a read', async () => {
    const gateway = await gatewayDouble(CATALOG)
    const account = fakeAccount()
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.provide('deepseekAccount', account.service as never)
    await ctx.plugin(Gateway, { gatewayOrigin: gateway.url, apiKeyEnv: 'VIBEDEV_TEST_GATEWAY_KEY_UNSET' })
    await settle()

    // The sign-in's first state change starts a read that looks for the credential before it is stored...
    const release = account.hold()
    account.notify()
    await settle()
    // ...and the change that stores it arrives while that read is still waiting.
    account.signIn('vdat_new')
    account.notify()
    release()

    await vi.waitFor(() => { expect(gateway.catalogRequests).toHaveLength(1) })
    expect(gateway.catalogRequests[0]?.headers.authorization).toBe('Bearer vdat_new')
    await ctx.fiber.dispose()
  })

  it('reads the catalog when models are listed after a sign-in no state change reported', async () => {
    const gateway = await gatewayDouble(CATALOG)
    const account = fakeAccount()
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.provide('deepseekAccount', account.service as never)
    await ctx.plugin(Gateway, { gatewayOrigin: gateway.url, apiKeyEnv: 'VIBEDEV_TEST_GATEWAY_KEY_UNSET' })
    await settle()
    expect(gateway.catalogRequests).toEqual([])

    account.signIn('vdat_quiet')
    const listed = await ctx.llm.listModels(Gateway.PROVIDER)

    expect(listed.map(model => model.id)).toEqual(['deepseek-v4-flash', 'claude-opus-5-5', 'gpt-5.5', 'glm-5.3'])
    expect(gateway.catalogRequests.map(request => request.headers.authorization)).toEqual(['Bearer vdat_quiet'])
    await ctx.fiber.dispose()
  })

  it('asks the gateway again for an empty catalog at most once per gap', async () => {
    const gateway = await gatewayDouble({ object: 'list', data: [{ id: 'plain-entry', object: 'model' }] })
    const account = fakeAccount()
    account.signIn('vdat_plain')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.provide('deepseekAccount', account.service as never)
    await ctx.plugin(Gateway, { gatewayOrigin: gateway.url, apiKeyEnv: 'VIBEDEV_TEST_GATEWAY_KEY_UNSET' })
    await vi.waitFor(() => { expect(gateway.catalogRequests).toHaveLength(1) })

    expect(await ctx.llm.listModels(Gateway.PROVIDER)).toEqual([])
    expect(await ctx.llm.listModels(Gateway.PROVIDER)).toEqual([])

    expect(gateway.catalogRequests).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('lists nothing and asks the gateway nothing while nobody is signed in and no key is set', async () => {
    const gateway = await gatewayDouble(CATALOG)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Gateway, { gatewayOrigin: gateway.url, apiKeyEnv: 'VIBEDEV_TEST_GATEWAY_KEY_UNSET' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await ctx.llm.listModels(Gateway.PROVIDER)).toEqual([])
    expect(gateway.catalogRequests).toEqual([])
    await ctx.fiber.dispose()
  })
})
