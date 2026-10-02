/** The plugin reads the gateway catalog with the request credential and publishes it on the account channel. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as Gateway from '../src/index.ts'
import { CATALOG, closeGatewayDoubles, gatewayDouble } from './gateway-double.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeGatewayDoubles()
})

describe('llm-vibedev-gateway plugin', () => {
  it('lists the catalog chat models under the account channel when a development key is set', async () => {
    const gateway = await gatewayDouble(CATALOG)
    vi.stubEnv('VIBEDEV_TEST_GATEWAY_KEY', 'sk-exempt-dev')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Gateway, Gateway.Config({ gatewayOrigin: `${gateway.url}/`, apiKeyEnv: 'VIBEDEV_TEST_GATEWAY_KEY' }))
    await vi.waitFor(async () => {
      const listed = await ctx.llm.listModels(Gateway.PROVIDER)
      expect(listed.map(model => model.id)).toEqual(['claude-opus-5-5', 'gpt-5.5', 'deepseek-v4-flash', 'glm-5.3'])
    })
    expect(gateway.catalogRequests[0]?.headers.authorization).toBe('Bearer sk-exempt-dev')
    await ctx.fiber.dispose()
  })

  it('lists nothing and asks the gateway nothing while nobody is signed in and no key is set', async () => {
    const gateway = await gatewayDouble(CATALOG)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Gateway, Gateway.Config({ gatewayOrigin: gateway.url, apiKeyEnv: 'VIBEDEV_TEST_GATEWAY_KEY_UNSET' }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await ctx.llm.listModels(Gateway.PROVIDER)).toEqual([])
    expect(gateway.catalogRequests).toEqual([])
    await ctx.fiber.dispose()
  })
})
