/** The plugin serves `ctx.web` searches through the gateway with the gateway models' credential. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as Search from '../src/index.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('web-search-vibedev plugin', () => {
  it('searches through the gateway with the development key while nobody is signed in', async () => {
    vi.stubEnv('VIBEDEV_TEST_SEARCH_KEY', 'sk-exempt-dev')
    const fetch = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response(
      JSON.stringify({ results: [{ url: 'https://example.com/', title: 'Example' }] }), { status: 200 },
    )))
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: Search.GATEWAY_SEARCH_PROVIDER_ID })
    await ctx.plugin(Search, Search.Config({ gatewayOrigin: 'https://gateway.test/', apiKeyEnv: 'VIBEDEV_TEST_SEARCH_KEY' }))

    const result = await ctx.web.search({ query: 'example', maxResults: 5 })

    expect(result).toEqual({ sources: [{ url: 'https://example.com/', title: 'Example' }], truncated: false })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe('https://gateway.test/v1/vibedev/web-search')
    expect(init?.headers).toMatchObject({ authorization: 'Bearer sk-exempt-dev' })
    expect((init?.headers as Record<string, string>)['user-agent']).toMatch(/^vibedev-app\//)
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '{}')).toEqual({ query: 'example', max_results: 5 })
    await ctx.fiber.dispose()
  })

  it('asks for a sign-in while nobody is signed in and no key is set', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: Search.GATEWAY_SEARCH_PROVIDER_ID })
    await ctx.plugin(Search, Search.Config({ apiKeyEnv: 'VIBEDEV_TEST_SEARCH_KEY_UNSET' }))

    await expect(ctx.web.search({ query: 'example' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    expect(fetch).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
