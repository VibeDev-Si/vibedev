/** The VibeDev account provider against a loopback gateway that speaks the app-token protocol. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { AccountClientMetadata, AccountView } from '@deepseek-ai/dsh-deepseek-account'
import { CALLBACK_PATH, VibeDevAccount } from '../src/index.ts'

const KEY = credentialKey('vibedev-account', 'default')
const client: AccountClientMetadata = { version: '1.2.3', locale: 'zh-CN', timezoneOffsetSeconds: 28_800 }
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** Mutable behaviour of the fake gateway, and what it received. */
interface Gateway {
  origin: string
  challenge: string | undefined
  redeemStatus: number
  refreshStatus: number | 'drop'
  meStatus: number
  accessTtl: number
  issued: number
  redeems: Array<Record<string, unknown>>
  refreshes: Array<Record<string, unknown>>
  revokes: Array<Record<string, unknown>>
  meAuthorizations: string[]
  rejectAccess: Set<string>
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
}

async function startGateway(): Promise<Gateway> {
  const gateway: Gateway = {
    origin: '', challenge: undefined, redeemStatus: 200, refreshStatus: 200, meStatus: 200, accessTtl: 3600, issued: 0,
    redeems: [], refreshes: [], revokes: [], meAuthorizations: [], rejectAccess: new Set(),
  }
  const pair = () => {
    gateway.issued += 1
    return {
      token_type: 'Bearer', access_token: `vdat_access${gateway.issued}`, expires_in: gateway.accessTtl,
      refresh_token: `vdrt_refresh${gateway.issued}`, refresh_expires_in: 2_592_000, session_id: 'session-1',
    }
  }
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'POST' && url.pathname === '/api/v1/vibedev/link/redeem') {
        const input = await body(req)
        gateway.redeems.push(input)
        const verifier = String(input.code_verifier)
        const matches = createHash('sha256').update(verifier).digest('base64url') === gateway.challenge
        if (gateway.redeemStatus !== 200 || !matches || input.token_type !== 'app') {
          json(res, gateway.redeemStatus === 200 ? 403 : gateway.redeemStatus, { code: 'INVALID_GRANT' }); return
        }
        json(res, 200, { code: 0, message: 'success', data: { ...pair(), user: { id: 7, email: 'u***@example.invalid' } } })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/vibedev/app-token/refresh') {
        const input = await body(req)
        gateway.refreshes.push(input)
        if (gateway.refreshStatus === 'drop') { req.socket.destroy(); return }
        if (gateway.refreshStatus !== 200) { json(res, gateway.refreshStatus, { code: 'REFRESH_TOKEN_INVALID' }); return }
        json(res, 200, { code: 0, data: { ...pair(), session_id: undefined } })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/vibedev/app-token/revoke') {
        gateway.revokes.push(await body(req))
        res.writeHead(204).end()
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/account/auth/me') {
        const authorization = req.headers.authorization ?? ''
        gateway.meAuthorizations.push(authorization)
        if (gateway.rejectAccess.has(authorization.replace(/^Bearer /, ''))) { json(res, 401, { code: 'APP_TOKEN_EXPIRED' }); return }
        if (gateway.meStatus !== 200) { json(res, gateway.meStatus, {}); return }
        json(res, 200, { code: 0, data: { id: 7, email: 'u***@example.invalid', nickname: '测试用户', balance: 12.5, frozen_balance: 0 } })
        return
      }
      res.writeHead(404).end()
    })()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no gateway address')
  gateway.origin = `http://127.0.0.1:${address.port}`
  cleanups.push(() => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }))
  return gateway
}

async function fixture(options: { refreshSkewMs?: number } = {}) {
  const gateway = await startGateway()
  const home = await mkdtemp(join(tmpdir(), 'vibedev-account-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  const web = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await web
  const credentials = ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await credentials
  const authorization = ctx.plugin(AuthorizationService)
  await authorization
  const provider = ctx.plugin(VibeDevAccount, {
    gatewayOrigin: gateway.origin, allowLoopbackHttp: true, logoutRetryDelayMs: 1,
    ...options.refreshSkewMs === undefined ? {} : { refreshSkewMs: options.refreshSkewMs },
  })
  await provider
  cleanups.push(async () => { await provider.dispose(); await authorization.dispose(); await credentials.dispose(); await web.dispose() })
  const account = ctx.deepseekAccount as VibeDevAccount
  const events: string[] = []
  ctx.on('deepseek-account/session-expired', () => { events.push('session-expired') })
  ctx.on('deepseek-account/signed-out', () => { events.push('signed-out') })
  const callbackOrigin = `http://127.0.0.1:${ctx.webServer.port}`
  const states = new AbortController()
  cleanups.push(async () => { states.abort() })
  async function waitFor(predicate: (view: AccountView) => boolean): Promise<AccountView> {
    for await (const view of account.watch(states.signal)) if (predicate(view)) return view
    throw new Error('watch ended')
  }
  /** Run the browser half: open the authorize URL's callback with the issued code. */
  async function signIn(): Promise<Response> {
    await account.startSignIn(client, callbackOrigin, 'desktop')
    const waiting = await waitFor(view => view.attempt?.phase === 'waiting-browser')
    const authorize = new URL(waiting.attempt!.authorizeUrl!)
    gateway.challenge = authorize.searchParams.get('code_challenge') ?? undefined
    const callback = new URL(authorize.searchParams.get('callback')!)
    callback.searchParams.set('code', 'one-time-code')
    callback.searchParams.set('state', authorize.searchParams.get('state')!)
    return fetch(callback, { redirect: 'manual' })
  }
  return { ctx, account, gateway, events, callbackOrigin, waitFor, signIn, credentials: ctx.credentials }
}

describe('VibeDev account sign-in', () => {
  it('sends the browser to the gateway link page in authorization-code mode with PKCE', async () => {
    const f = await fixture()
    await f.account.startSignIn(client, f.callbackOrigin, 'desktop')
    const waiting = await f.waitFor(view => view.attempt?.phase === 'waiting-browser')
    const url = new URL(waiting.attempt!.authorizeUrl!)
    expect(url.origin).toBe(f.gateway.origin)
    expect(url.pathname).toBe('/vibedev-link')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('client')).toBe('vibedev-desktop')
    expect(url.searchParams.get('callback')).toBe(`${f.callbackOrigin}${CALLBACK_PATH}`)
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
  })

  it('redeems the code with the verifier and device identity, then stores the app session', async () => {
    const f = await fixture()
    const response = await f.signIn()
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('登录成功')
    const done = await f.waitFor(view => view.attempt?.phase === 'succeeded')
    expect(done.status).toBe('credential-stored')
    expect(f.gateway.redeems).toHaveLength(1)
    expect(f.gateway.redeems[0]).toMatchObject({ code: 'one-time-code', token_type: 'app', client: 'vibedev-desktop' })
    expect(f.gateway.redeems[0]?.device_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await f.account.resolveToken(`${f.gateway.origin}/v1/messages`)).toBe('vdat_access1')
  })

  it('rejects a callback with the wrong state or a legacy payload', async () => {
    const f = await fixture()
    await f.account.startSignIn(client, f.callbackOrigin, 'desktop')
    const waiting = await f.waitFor(view => view.attempt?.phase === 'waiting-browser')
    const authorize = new URL(waiting.attempt!.authorizeUrl!)
    const callback = new URL(authorize.searchParams.get('callback')!)
    callback.searchParams.set('code', 'x')
    callback.searchParams.set('state', 'wrong')
    expect((await fetch(callback)).status).toBe(400)
    callback.searchParams.set('state', authorize.searchParams.get('state')!)
    callback.searchParams.set('payload', 'eyJhcGlfa2V5Ijoic2sifQ')
    expect((await fetch(callback)).status).toBe(400)
  })

  it('fails the attempt when the gateway refuses the code', async () => {
    const f = await fixture()
    f.gateway.redeemStatus = 403
    const response = await f.signIn()
    expect(response.status).toBe(204)
    const failed = await f.waitFor(view => view.attempt?.phase === 'failed')
    expect(failed.attempt?.errorCode).toBe('protocol')
    expect(failed.status).toBe('signed-out')
  })
})

describe('VibeDev account tokens', () => {
  it('only hands the token to the gateway origin', async () => {
    const f = await fixture()
    await f.signIn()
    await f.waitFor(view => view.attempt?.phase === 'succeeded')
    expect(await f.account.resolveToken('https://api.deepseek.com/anthropic')).toBeUndefined()
    expect(await f.account.resolveToken(`${f.gateway.origin.replace('127.0.0.1', 'localhost')}/v1/messages`)).toBeUndefined()
  })

  it('refreshes an expiring token once for concurrent callers and keeps the session', async () => {
    const f = await fixture({ refreshSkewMs: 3_600_000 })
    await f.signIn()
    await f.waitFor(view => view.attempt?.phase === 'succeeded')
    // The sign-in token (1 h) is inside the 1 h refresh window; the rotated one (2 h) is not.
    f.gateway.accessTtl = 7200
    const tokens = await Promise.all([1, 2, 3].map(() => f.account.resolveToken(`${f.gateway.origin}/v1/messages`)))
    expect(f.gateway.refreshes).toHaveLength(1)
    expect(f.gateway.refreshes[0]).toMatchObject({ refresh_token: 'vdrt_refresh1' })
    expect(new Set(tokens)).toEqual(new Set(['vdat_access2']))
    expect((await f.account.getState()).status).toBe('credential-stored')
    expect(f.events).toEqual([])
  })

  it('signs out with session-expired when the gateway rejects the refresh', async () => {
    const f = await fixture({ refreshSkewMs: 3_600_000 })
    await f.signIn()
    await f.waitFor(view => view.attempt?.phase === 'succeeded')
    f.gateway.refreshStatus = 401
    expect(await f.account.resolveToken(`${f.gateway.origin}/v1/messages`)).toBeUndefined()
    expect((await f.account.getState()).status).toBe('signed-out')
    expect(f.events).toEqual(['session-expired', 'signed-out'])
  })

  it('keeps the session and the stored token when the refresh cannot reach the gateway', async () => {
    const f = await fixture({ refreshSkewMs: 3_600_000 })
    await f.signIn()
    await f.waitFor(view => view.attempt?.phase === 'succeeded')
    f.gateway.refreshStatus = 'drop'
    expect(await f.account.resolveToken(`${f.gateway.origin}/v1/messages`)).toBe('vdat_access1')
    expect((await f.account.getState()).status).toBe('credential-stored')
    expect(f.events).toEqual([])
  })

  it('refreshes instead of signing out when a model request rejects the current token', async () => {
    const f = await fixture()
    await f.signIn()
    await f.waitFor(view => view.attempt?.phase === 'succeeded')
    await f.account.rejectToken('vdat_not-current')
    expect(f.gateway.refreshes).toHaveLength(0)
    await f.account.rejectToken('vdat_access1')
    expect(f.gateway.refreshes).toHaveLength(1)
    expect(await f.account.resolveToken(`${f.gateway.origin}/v1/messages`)).toBe('vdat_access2')
  })
})

describe('VibeDev account details and sign-out', () => {
  it('projects the gateway account onto the profile and a CNY wallet', async () => {
    const f = await fixture()
    await f.signIn()
    await f.waitFor(view => view.attempt?.phase === 'succeeded')
    expect(await f.account.getProfile(client)).toEqual({
      status: 'ready', value: { id: '7', name: '测试用户', contact: 'u***@example.invalid', avatarUrl: null },
    })
    expect(await f.account.getBalance(client)).toEqual({
      status: 'ready', value: [{ currency: 'CNY', balance: '12.5' }], bonusWallets: [],
    })
    expect(f.gateway.meAuthorizations.every(value => value === 'Bearer vdat_access1')).toBe(true)
    expect(await f.account.getUnnotifiedBonuses(client)).toEqual({ accountId: '7', bonuses: [] })
    expect((await f.account.getPlatformSession())?.userId).toBe('7')
  })

  it('refreshes once when the account read rejects the access token', async () => {
    const f = await fixture()
    await f.signIn()
    await f.waitFor(view => view.attempt?.phase === 'succeeded')
    f.gateway.rejectAccess.add('vdat_access1')
    expect((await f.account.getBalance(client))?.status).toBe('ready')
    expect(f.gateway.refreshes).toHaveLength(1)
    expect(f.gateway.meAuthorizations.at(-1)).toBe('Bearer vdat_access2')
  })

  it('reports a failed read without inventing a balance', async () => {
    const f = await fixture()
    await f.signIn()
    await f.waitFor(view => view.attempt?.phase === 'succeeded')
    f.gateway.meStatus = 500
    expect(await f.account.getBalance(client)).toEqual({ status: 'failed' })
  })

  it('removes the session locally first and revokes it in the background', async () => {
    const f = await fixture()
    await f.signIn()
    await f.waitFor(view => view.attempt?.phase === 'succeeded')
    const view = await f.account.signOut(client)
    expect(view.status).toBe('signed-out')
    expect(await f.credentials.readRecord(KEY)).toBeUndefined()
    expect(f.events).toEqual(['signed-out'])
    for (let tries = 0; tries < 50 && f.gateway.revokes.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.gateway.revokes).toEqual([{ refresh_token: 'vdrt_refresh1' }])
    expect(await f.account.resolveToken(`${f.gateway.origin}/v1/messages`)).toBeUndefined()
  })
})
