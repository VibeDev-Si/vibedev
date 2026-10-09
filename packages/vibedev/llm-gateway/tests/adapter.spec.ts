/** Requests through the gateway adapter reach the gateway in the shape it expects, and its failures become account failures. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ACCOUNT_QUOTA_EXCEEDED_CODE, BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { GatewayAdapter } from '../src/adapter.ts'
import type { GatewayCredential } from '../src/adapter.ts'
import { parseCatalog } from '../src/catalog.ts'
import { PROVIDER } from '../src/index.ts'
import { CATALOG, chatTextEvents, closeGatewayDoubles, gatewayDouble } from './gateway-double.ts'
import type { Behavior, GatewayDouble } from './gateway-double.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeGatewayDoubles()
})

const MODELS = parseCatalog(CATALOG)
const ACCOUNT: GatewayCredential = { token: 'vdat_test-token', kind: 'account' }

interface Bench {
  readonly ctx: Context
  readonly adapter: GatewayAdapter
  readonly gateway: GatewayDouble
  readonly rejected: string[]
}

/** A runtime with the adapter registered; `null` means nobody is signed in and no key is configured. */
async function bench(script: Behavior[], credential: GatewayCredential | null = ACCOUNT): Promise<Bench> {
  const gateway = await gatewayDouble(CATALOG, script)
  const rejected: string[] = []
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new GatewayAdapter({
    provider: PROVIDER,
    displayName: 'VibeDev',
    origin: () => gateway.url,
    catalog: () => MODELS,
    resolveCredential: () => Promise.resolve(credential ?? undefined),
    rejectToken: (token) => { rejected.push(token); return Promise.resolve() },
    deviceId: () => Promise.resolve('device-1'),
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return { ctx, adapter, gateway, rejected }
}

const hello = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })

async function run(ctx: Context, options: Omit<GenerateOptions, 'provider' | 'messages'>): Promise<{ text: string; finish: FinishReason }> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider: PROVIDER, messages: [hello], sessionId: 'session-1' as never, ...options })) assembler.push(chunk)
  const message = assembler.message({ provider: PROVIDER, model: options.model })
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
  return { text, finish: assembler.finish }
}

describe('GatewayAdapter', () => {
  it('describes catalog models with their levels and starting level', async () => {
    const { adapter } = await bench([])
    const gpt = await adapter.resolveModel(PROVIDER, 'gpt-5.5')
    expect(gpt.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    expect(gpt.reasoning?.defaultEffort).toBe('medium')
    expect(gpt.context?.contextWindow).toBe(400_000)
    const claude = await adapter.resolveModel(PROVIDER, 'claude-opus-5-5')
    expect(claude.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'max'])
    expect(claude.inputModalities).toEqual(['text', 'image'])
    const glm = await adapter.resolveModel(PROVIDER, 'glm-5.3')
    expect(glm.reasoning).toBeUndefined()
    await expect(adapter.resolveModel(PROVIDER, 'missing')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    expect((await adapter.listModels(PROVIDER)).map(model => model.id)).toEqual(['claude-opus-5-5', 'gpt-5.5', 'deepseek-v4-flash', 'glm-5.3'])
  })

  it('sends Chat Completions with a Bearer token, the session headers, and the session cache key', async () => {
    const { ctx, gateway } = await bench([{ events: chatTextEvents }, { events: chatTextEvents }])
    const result = await run(ctx, { model: 'deepseek-v4-flash' })
    expect(result).toEqual({ text: 'hello', finish: { kind: 'stop' } })
    const [request] = gateway.requests
    expect(request?.path).toBe('/v1/chat/completions')
    expect(request?.headers.authorization).toBe('Bearer vdat_test-token')
    expect(request?.headers.session_id).toBe('session-1')
    expect(request?.headers['user-agent']).toMatch(/^vibedev-app\//)
    expect(request?.body).toMatchObject({ model: 'deepseek-v4-flash', prompt_cache_key: 'session-1', thinking: { type: 'enabled' }, reasoning_effort: 'high' })

    await run(ctx, { model: 'deepseek-v4-flash', reasoningEffort: ReasoningEffortId('off') })
    expect(gateway.requests[1]?.body).toMatchObject({ thinking: { type: 'disabled' } })
    expect(gateway.requests[1]?.body).not.toHaveProperty('reasoning_effort')
  })

  it('sends Responses with the session key, spells off as none, and drops temperature while reasoning', async () => {
    const { ctx, gateway } = await bench([{ status: 400, body: '{"error":{"message":"stop here"}}' }, { status: 400, body: '{"error":{"message":"stop here"}}' }])
    await run(ctx, { model: 'gpt-5.5', temperature: 0.3 })
    const [request] = gateway.requests
    expect(request?.path).toBe('/v1/responses')
    expect(request?.headers.authorization).toBe('Bearer vdat_test-token')
    expect(request?.headers.session_id).toBe('session-1')
    expect(request?.body).toMatchObject({ model: 'gpt-5.5', prompt_cache_key: 'session-1', reasoning: { effort: 'medium' } })
    expect(request?.body).not.toHaveProperty('temperature')

    await run(ctx, { model: 'gpt-5.5', reasoningEffort: ReasoningEffortId('off') })
    expect(gateway.requests[1]?.body).toMatchObject({ reasoning: { effort: 'none' } })
  })

  it('sends Messages with Bearer instead of x-api-key and the device-and-session affinity user id', async () => {
    const { ctx, gateway } = await bench([{ status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"stop here"}}' }])
    await run(ctx, { model: 'claude-opus-5-5' })
    const [request] = gateway.requests
    expect(request?.path.split('?')[0]).toBe('/v1/messages')
    expect(request?.headers.authorization).toBe('Bearer vdat_test-token')
    expect(request?.headers['x-api-key']).toBeUndefined()
    expect(request?.body).toMatchObject({ model: 'claude-opus-5-5', thinking: { type: 'adaptive' } })
    expect(JSON.parse(String((request?.body?.metadata as { user_id?: unknown } | undefined)?.user_id))).toEqual({ device_id: 'device-1', session_id: 'session-1' })
  })

  it('turns a 402 into the account quota failure', async () => {
    const { ctx } = await bench([{
      status: 402,
      body: '{"error":{"type":"insufficient_quota","code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance","recharge_url":"https://api.vibedev.studio/purchase"}}',
    }])
    const { finish } = await run(ctx, { model: 'deepseek-v4-flash' })
    expect(finish).toMatchObject({ kind: 'error', failure: { code: ACCOUNT_QUOTA_EXCEEDED_CODE, status: 402, requestId: 'req-1' } })
  })

  it('hands a rejected account token back and fails as an invalid token', async () => {
    const { ctx, rejected } = await bench([{ status: 401, body: '{"error":{"type":"authentication_error","code":"APP_TOKEN_EXPIRED","message":"expired"}}' }])
    const { finish } = await run(ctx, { model: 'deepseek-v4-flash' })
    expect(finish).toMatchObject({ kind: 'error', failure: { code: 'ACCOUNT_TOKEN_INVALID', status: 401 } })
    expect(rejected).toEqual(['vdat_test-token'])
  })

  it('keeps a development key when the gateway rejects it', async () => {
    const { ctx, rejected } = await bench([{ status: 401, body: '{}' }], { token: 'sk-dev', kind: 'key' })
    const { finish } = await run(ctx, { model: 'deepseek-v4-flash' })
    expect(finish).toMatchObject({ kind: 'error', failure: { code: 'ACCOUNT_TOKEN_INVALID' } })
    expect(rejected).toEqual([])
  })

  it('asks for sign-in, not an unknown model, while the catalog is still empty', async () => {
    const gateway = await gatewayDouble(CATALOG)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new GatewayAdapter({
      provider: PROVIDER, displayName: 'VibeDev', origin: () => gateway.url, catalog: () => [],
      resolveCredential: () => Promise.resolve(undefined),
    })
    ctx.llm.registerAdapter([PROVIDER], adapter)
    await expect(adapter.resolveModel(PROVIDER, 'deepseek-v4-flash')).rejects.toMatchObject({ code: 'ACCOUNT_SIGN_IN_REQUIRED' })
    const { finish } = await run(ctx, { model: 'deepseek-v4-flash' })
    expect(finish).toMatchObject({ kind: 'error', failure: { code: 'ACCOUNT_SIGN_IN_REQUIRED' } })
    expect(gateway.requests).toEqual([])
  })

  it('asks for sign-in before any network request when there is no credential', async () => {
    const { ctx, gateway } = await bench([], null)
    const { finish } = await run(ctx, { model: 'deepseek-v4-flash' })
    expect(finish).toMatchObject({ kind: 'error', failure: { code: 'ACCOUNT_SIGN_IN_REQUIRED' } })
    expect(gateway.requests).toEqual([])
  })
})
