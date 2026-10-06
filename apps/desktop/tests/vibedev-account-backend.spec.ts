/** VibeDev: the welcome flow's view of the VibeDev account, served by the built-in account plugin's Host routes. */
import { describe, expect, it, vi } from 'vitest'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import { accountViewOf, connectVibeDevAccount, pluginAccountView, VIBEDEV_ACCOUNT_ROUTE } from '../src/vibedev-account-backend.ts'

const ORIGIN = 'http://127.0.0.1:19387'
const LINKS = { topUp: 'https://vibedev.example/purchase', usage: 'https://vibedev.example/usage', register: 'https://vibedev.example' }

/** A Host serving the plugin's routes from a mutable view. */
function host(initial: Record<string, unknown>) {
  const state: { view: Record<string, unknown> } = { view: { links: LINKS, models: { count: 0 }, ...initial } }
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  let attempts = 0
  const send = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, path: url.pathname, ...typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {} })
    expect(init).toMatchObject({ credentials: 'include', redirect: 'error' })
    if (method === 'GET' && url.pathname === VIBEDEV_ACCOUNT_ROUTE) return Response.json(state.view)
    if (method === 'POST' && url.pathname === `${VIBEDEV_ACCOUNT_ROUTE}/sign-in`) {
      state.view = { ...state.view, pending: { url: 'https://vibedev.example/vibedev-link?state=s', expiresAt: 5_000 * ++attempts } }
      return Response.json({ ok: true })
    }
    if (method === 'POST' && url.pathname === `${VIBEDEV_ACCOUNT_ROUTE}/cancel`) {
      const { pending: _pending, ...rest } = state.view
      state.view = rest
      return Response.json({ ok: true })
    }
    if (method === 'POST' && url.pathname === `${VIBEDEV_ACCOUNT_ROUTE}/sign-out`) {
      state.view = { ...state.view, source: 'none' }
      return Response.json({ ok: true })
    }
    return new Response('not found', { status: 404 })
  })
  return { state, calls, send }
}

describe('connectVibeDevAccount', () => {
  it('serves the welcome flow only when the plugin is the main account', async () => {
    expect(await connectVibeDevAccount(ORIGIN, host({ source: 'none', primary: true }).send)).toBeDefined()
    expect(await connectVibeDevAccount(ORIGIN, host({ source: 'none', primary: false }).send)).toBeUndefined()
    expect(await connectVibeDevAccount(ORIGIN, host({ source: 'none' }).send)).toBeUndefined()
    // Another page (no plugin): final at once; a missing route or a failed connection is asked again, then given up.
    const page = vi.fn(async () => new Response('index'))
    expect(await connectVibeDevAccount(ORIGIN, page, { probeDelayMs: 1 })).toBeUndefined()
    expect(page).toHaveBeenCalledOnce()
    const missing = vi.fn(async () => new Response('missing', { status: 404 }))
    expect(await connectVibeDevAccount(ORIGIN, missing, { probeTries: 3, probeDelayMs: 1 })).toBeUndefined()
    expect(missing).toHaveBeenCalledTimes(3)
  })

  it('maps the plugin view to the account view the welcome window reads', () => {
    expect(accountViewOf(pluginAccountView({ source: 'none', links: LINKS }))).toEqual({
      status: 'signed-out', attempt: null, links: { usageUrl: LINKS.usage, topUpUrl: LINKS.topUp },
    })
    expect(accountViewOf(pluginAccountView({ source: 'plugin', links: LINKS })).status).toBe('credential-stored')
    expect(accountViewOf(pluginAccountView({ source: 'none', links: LINKS, pending: { url: 'https://v/link', expiresAt: 9 } })).attempt)
      .toEqual({ id: 'vibedev-9', phase: 'waiting-browser', authorizeUrl: 'https://v/link', expiresAt: 9 })
    expect(() => pluginAccountView({ source: 'someone' })).toThrow('vibedev account: invalid state')
  })

  it('starts a sign-in the plugin opens itself, and signs out', async () => {
    const h = host({ source: 'none', primary: true })
    const account = (await connectVibeDevAccount(ORIGIN, h.send))!
    const started = await account.start()
    expect(h.calls.find(call => call.method === 'POST')).toEqual({ method: 'POST', path: `${VIBEDEV_ACCOUNT_ROUTE}/sign-in`, body: { open: true } })
    expect(started.attempt).toMatchObject({ phase: 'waiting-browser', authorizeUrl: 'https://vibedev.example/vibedev-link?state=s' })
    h.state.view = { links: LINKS, source: 'plugin', primary: true }
    expect((await account.signOut()).status).toBe('signed-out')
  })

  it('reports a waiting sign-in that ends signed in as succeeded, once, even when it ends between idle polls', async () => {
    const h = host({ source: 'none', primary: true })
    const account = (await connectVibeDevAccount(ORIGIN, h.send, { pendingMs: 5, idleMs: 60_000 }))!
    const seen: AccountView[] = []
    const stop = account.watch((state) => { seen.push(state) }, () => {})
    await vi.waitFor(() => { expect(seen).toHaveLength(1) })
    await account.start() // wakes the idle poll at once
    await vi.waitFor(() => { expect(seen.some(state => state.attempt?.phase === 'waiting-browser')).toBe(true) })
    h.state.view = { links: LINKS, source: 'plugin', primary: true }
    await vi.waitFor(() => { expect(seen.some(state => state.attempt?.phase === 'succeeded')).toBe(true) })
    const succeeded = seen.filter(state => state.attempt?.phase === 'succeeded')
    expect(succeeded).toHaveLength(1)
    expect(succeeded[0]).toMatchObject({ status: 'credential-stored', attempt: { id: 'vibedev-5000' } })
    stop()
  })

  it('reports a cancelled sign-in as cancelled and a lapsed one as expired', async () => {
    let now = 0
    const h = host({ source: 'none', primary: true })
    const account = (await connectVibeDevAccount(ORIGIN, h.send, { pendingMs: 5, idleMs: 5, now: () => now }))!
    const seen: AccountView[] = []
    const stop = account.watch((state) => { seen.push(state) }, () => {})
    await account.start()
    await vi.waitFor(() => { expect(seen.some(state => state.attempt?.phase === 'waiting-browser')).toBe(true) })
    await account.cancel('vibedev-5000' as never)
    await vi.waitFor(() => { expect(seen.some(state => state.attempt?.phase === 'cancelled')).toBe(true) })
    await account.start()
    await vi.waitFor(() => { expect(seen.filter(state => state.attempt?.phase === 'waiting-browser').length).toBeGreaterThan(1) })
    now = 10_000
    const { pending: _pending, ...lapsed } = h.state.view
    h.state.view = lapsed
    await vi.waitFor(() => { expect(seen.some(state => state.attempt?.phase === 'expired')).toBe(true) })
    stop()
  })
})
