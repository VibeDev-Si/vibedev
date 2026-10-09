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
  it('returns to the login entry when credentials expire after a retained successful attempt', async () => {
    const succeeded = { id: 'login-success', phase: 'succeeded', expiresAt: 9000, gatewayOrigin: 'https://api.vibedev.studio' }
    const h = host({ source: 'plugin', primary: true, attempt: succeeded })
    const account = (await connectVibeDevAccount(ORIGIN, h.send))!
    expect((await account.state()).attempt?.phase).toBe('succeeded')
    // A refresh rejection removes the credential, while Host retains the old attempt for diagnostics.
    h.state.view = { ...h.state.view, source: 'none' }
    expect(await account.state()).toMatchObject({ status: 'signed-out', attempt: null })
  })

  it('returns the authoritative failure immediately when sign-in could not start', async () => {
    const h = host({ source: 'none', primary: true })
    const send = async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input.endsWith('/sign-in')) {
        h.state.view = { source: 'none', primary: true, links: LINKS, attempt: {
          id: 'login-listener', phase: 'failed', expiresAt: 9000, gatewayOrigin: 'https://api.vibedev.studio',
          stage: 'listen', errorCode: 'callback',
        } }
        return Response.json({ error: { code: 'SIGN_IN_REFUSED' } }, { status: 500 })
      }
      return h.send(input, init)
    }
    const account = (await connectVibeDevAccount(ORIGIN, send))!
    await expect(account.start()).resolves.toMatchObject({ attempt: {
      id: 'login-listener', phase: 'failed', vibedevDiagnostic: { stage: 'listen', errorCode: 'callback' },
    } })
  })

  it('retains the plugin phase and safe failure details instead of guessing from pending', () => {
    const attempt = {
      id: 'login-123', phase: 'failed', expiresAt: 9000, gatewayOrigin: 'https://api.vibedev.studio',
      stage: 'redeem', errorCode: 'gateway-unavailable', httpStatus: 503,
      message: 'private-token', code: 'private-code', code_verifier: 'private-verifier',
    }
    const state = accountViewOf(pluginAccountView({ source: 'none', links: LINKS, attempt }))
    expect(state.attempt).toMatchObject({ id: 'login-123', phase: 'failed', errorCode: 'network' })
    expect(state.attempt).toHaveProperty('vibedevDiagnostic', {
      gatewayOrigin: 'https://api.vibedev.studio', stage: 'redeem', errorCode: 'gateway-unavailable', httpStatus: 503,
    })
    expect(JSON.stringify(state)).not.toContain('private-')
  })

  it.each(['exchanging', 'committing', 'succeeded', 'cancelled', 'expired'])('retains %s from the plugin', (phase) => {
    const state = accountViewOf(pluginAccountView({
      source: phase === 'succeeded' ? 'plugin' : 'none', links: LINKS,
      attempt: { id: 'login-123', phase, expiresAt: 9000, gatewayOrigin: 'https://api.vibedev.studio' },
    }))
    expect(state.attempt?.phase).toBe(phase)
  })

  it('drops unknown diagnostic fields and network codes at the desktop boundary', () => {
    const state = accountViewOf(pluginAccountView({ source: 'none', links: LINKS, attempt: {
      id: 'login-123', phase: 'failed', expiresAt: 9000, gatewayOrigin: 'https://secret:password@api.vibedev.studio/path?token=hidden',
      stage: 'redeem', errorCode: 'network', networkCode: 'secret-token', httpStatus: 999, message: 'secret-message',
    } }))
    expect(JSON.stringify(state)).not.toMatch(/secret|password|hidden|999/)
    expect(state.attempt?.phase).toBe('failed')
  })

  it('keeps a fast terminal plugin failure across polls and lets a new attempt replace it', async () => {
    const h = host({ source: 'none', primary: true })
    const account = (await connectVibeDevAccount(ORIGIN, h.send, { pendingMs: 5, idleMs: 5 }))!
    const seen: AccountView[] = []
    const stop = account.watch((state) => { seen.push(state) }, () => {})
    try {
      h.state.view = { source: 'none', primary: true, links: LINKS, attempt: {
        id: 'login-first', phase: 'failed', expiresAt: 9000, gatewayOrigin: 'https://api.vibedev.studio',
        stage: 'redeem', errorCode: 'network', networkCode: 'ECONNRESET',
      } }
      await vi.waitFor(() => { expect(seen.at(-1)?.attempt).toMatchObject({ id: 'login-first', phase: 'failed' }) })
      expect((await account.state()).attempt?.phase).toBe('failed')
      h.state.view = { source: 'none', primary: true, links: LINKS,
        pending: { url: 'https://api.vibedev.studio/vibedev-link?state=new', expiresAt: 10000 },
        attempt: { id: 'login-next', phase: 'waiting-browser', expiresAt: 10000, gatewayOrigin: 'https://api.vibedev.studio' },
      }
      await vi.waitFor(() => { expect(seen.at(-1)?.attempt).toMatchObject({ id: 'login-next', phase: 'waiting-browser' }) })
    } finally { stop() }
  })

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
