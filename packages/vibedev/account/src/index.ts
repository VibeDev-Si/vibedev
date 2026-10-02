/**
 * VibeDev account provider for the DSH account seam (`ctx.deepseekAccount`).
 * Browser sign-in uses the gateway's `/vibedev-link` page in authorization-code
 * mode with PKCE; the gateway returns an app access token and a rotating
 * refresh token, which model requests use instead of signed API keys.
 * Adapted from `@deepseek-ai/dsh-deepseek-account-platform` (MIT).
 *
 * @module @vibedev/dsh-account
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { arch, platform, release } from 'node:os'
import { promises as streamPromises } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import {
  DeepSeekAccount, installAccountTaskCancellation, platformClientHeaders, platformWireLocale,
  type AccountBonusBatch, type AccountClientMetadata, type AccountDetails, type AccountUserId,
  type AccountView, type PlatformSession, type SignInAttemptId, type SignInAttemptView,
} from '@deepseek-ai/dsh-deepseek-account'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { balanceOf, profileOf, type ReadyProfile } from './details.ts'
import { writeCallbackPage } from './pages.ts'
import {
  AccountUnauthorizedError, CALLBACK_PATH, CLIENT_ID, VibeDevAuthError, accountMe, authorizeUrl, expectShape,
  gatewayOrigin, gatewayRequest, loginOrigin, tokenPair, type AccountMe, type TokenPair,
} from './protocol.ts'

export { CALLBACK_PATH, CLIENT_ID, VibeDevAuthError, AccountUnauthorizedError } from './protocol.ts'

const KEY = credentialKey('vibedev-account', 'default')
const DEVICE = credentialKey('vibedev-account', 'device')

/** The stored app session. Tokens never leave the Host except as request credentials. */
const grant = z.object({
  version: z.literal(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** Access-token expiry, epoch milliseconds. */
  expiresAt: z.number().int(),
  issuer: z.url(),
  sessionId: z.string().min(1).optional(),
})
type Grant = z.infer<typeof grant>
const device = z.object({ id: z.uuid() })

/** Deployment choices. */
export interface Config {
  /** VibeDev gateway origin serving the sign-in page, token endpoints, account reads and models. */
  gatewayOrigin?: string
  /** Native desktop identity for gateway requests; null identifies the client as web. */
  desktopPlatform?: 'darwin' | 'win32' | null
  /** Allow HTTP only on loopback, for a development or test gateway. */
  allowLoopbackHttp?: boolean
  /** Deadline for each gateway HTTP request. */
  requestTimeoutMs?: number
  /** Upper bound for one browser sign-in attempt. */
  attemptTimeoutMs?: number
  /** Refresh the access token when it has less than this long left. */
  refreshSkewMs?: number
  /** Additional revoke attempts after the first one fails, at most five. */
  logoutMaxRetries?: number
  /** Delay before the first revoke retry; each later delay doubles. */
  logoutRetryDelayMs?: number
}

/** Validated deployment choices. */
export const Config = Schema.object({
  gatewayOrigin: Schema.string().default('https://vibedev.jzsaas.com'),
  desktopPlatform: Schema.union([Schema.const('darwin'), Schema.const('win32'), Schema.const(null)]).default(null),
  allowLoopbackHttp: Schema.boolean().default(false),
  requestTimeoutMs: Schema.number().min(1).max(120_000).default(30_000),
  attemptTimeoutMs: Schema.number().min(1).max(3_600_000).default(600_000),
  refreshSkewMs: Schema.number().min(0).max(3_600_000).default(300_000),
  logoutMaxRetries: Schema.number().min(0).max(5).step(1).default(5),
  logoutRetryDelayMs: Schema.number().min(1).max(60_000).default(1_000),
})

interface Attempt {
  locale: 'en_US' | 'zh_CN'
  clientHeaders: Record<string, string>
  view: SignInAttemptView
  controller: AbortController
  done: Promise<void>
  running: Promise<void>
  origin: string
  loginSource: 'web' | 'desktop'
  disposeCallback?: () => Promise<void>
  callback?: ServerResponse
}

/** Identity of one sign-in session across refreshes, used to keep the cached profile through a token rotation. */
function lineage(value: Grant): string {
  return value.sessionId === undefined ? `token:${value.refreshToken}` : `session:${value.sessionId}`
}

/** The VibeDev implementation owns the stored app session and its refresh. */
export class VibeDevAccount extends DeepSeekAccount {
  static inject = ['credentials', 'authorization']
  static Config = Config
  private readonly origin: string
  private readonly platform: 'darwin' | 'win32' | null
  private readonly requestTimeout: number
  private readonly attemptTimeout: number
  private readonly refreshSkew: number
  private readonly logoutRetries: number
  private readonly logoutDelay: number
  /** Provider lifetime for background requests: revocation and remote cancellation. */
  private readonly lifetime = new AbortController()
  private readonly background = new Set<Promise<void>>()
  private attempt: Attempt | undefined
  private readonly listeners = new Set<() => void>()
  /** Last ready profile, bound to the sign-in session it was read under. */
  private lastProfile: { readonly lineage: string; readonly profile: ReadyProfile } | undefined
  private detailsLifetime = new AbortController()
  private closed = false
  private removing: Promise<AccountView> | undefined
  private refreshing: Promise<Grant> | undefined
  private meRead: { readonly token: string; readonly promise: Promise<AccountMe> } | undefined
  /** Lineage of the stored session as of the last record notification; a rotation keeps it. */
  private sessionLineage: string | undefined

  /** @param ctx - Host with authorization and credentials services. @param config - deployment options. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    installAccountTaskCancellation(ctx)
    const resolved = Config(config)
    this.origin = gatewayOrigin(resolved.gatewayOrigin, resolved.allowLoopbackHttp)
    this.platform = resolved.desktopPlatform
    this.requestTimeout = resolved.requestTimeoutMs
    this.attemptTimeout = resolved.attemptTimeoutMs
    this.refreshSkew = resolved.refreshSkewMs
    this.logoutRetries = resolved.logoutMaxRetries
    this.logoutDelay = resolved.logoutRetryDelayMs
    ctx.authorization.registerFlow({
      key: KEY, label: 'VibeDev', methods: [{ id: 'browser', label: 'VibeDev' }],
      run: (session) => {
        const attempt = this.attempt
        if (attempt === undefined) return Promise.reject(new VibeDevAuthError('protocol'))
        attempt.running = this.run(session, attempt)
        return attempt.running
      },
    })
    ctx.on('credentials/record-updated', (key) => {
      if (key !== KEY) return
      void this.onRecordUpdated()
    })
    ctx.effect(() => async () => {
      this.closed = true
      this.lifetime.abort()
      this.invalidateDetails()
      const active = this.attempt
      if (active !== undefined) {
        if (active.view.phase !== 'committing') active.controller.abort()
        await active.done
      }
      await this.removing
      await this.refreshing?.catch(() => undefined)
      await Promise.all(this.background)
      this.changed()
    }, 'vibedev-account: provider lifetime')
  }

  async [Service.init](): Promise<void> {
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined) return
    if (record.kind !== 'grant') throw new VibeDevAuthError('storage')
    const parsed = grant.safeParse(record.payload)
    if (!parsed.success) throw new VibeDevAuthError('storage')
    if (parsed.data.issuer === this.origin) {
      this.sessionLineage = lineage(parsed.data)
      return
    }
    // A session issued by another gateway environment is never forwarded to this one.
    await this.ctx.credentials.deleteRecord(KEY)
    console.info('[vibedev-account] stored session discarded', { reason: 'issuer-mismatch' })
  }

  override async getState(): Promise<AccountView> {
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record !== undefined && (record.kind !== 'grant' || !grant.safeParse(record.payload).success)) {
      throw new VibeDevAuthError('storage')
    }
    const attempt = this.attempt?.view ?? null
    return {
      status: record === undefined ? 'signed-out' : 'credential-stored',
      // Credential removal can notify watchers before sign-out finishes clearing the attempt.
      attempt: record === undefined && attempt?.phase === 'succeeded' ? null : attempt,
      links: { usageUrl: `${this.origin}/usage`, topUpUrl: `${this.origin}/purchase` },
    }
  }

  override async getProfile(_client: AccountClientMetadata): Promise<AccountDetails['profile'] | null> {
    const lifetime = this.detailsLifetime
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null) return null
    try {
      const me = await this.readMe(lifetime)
      if (me === null || this.detailsLifetime !== lifetime) return null
      const ready = profileOf(me)
      this.cacheProfile(stored, ready)
      return ready
    } catch (error) {
      if (error instanceof AccountUnauthorizedError) return null
      // Only this same session's last ready read may stand in for a failed refresh.
      const cached = this.lastProfile?.lineage === lineage(stored) ? this.lastProfile.profile : undefined
      return cached ?? { status: 'failed' }
    }
  }

  override async getBalance(_client: AccountClientMetadata): Promise<AccountDetails['balance'] | null> {
    const lifetime = this.detailsLifetime
    try {
      const me = await this.readMe(lifetime)
      if (me === null || this.detailsLifetime !== lifetime) return null
      return balanceOf(me)
    } catch (error) {
      if (error instanceof AccountUnauthorizedError) return null
      return { status: 'failed' }
    }
  }

  /** The gateway has no bonus notifications yet; a signed-in account always has an empty batch. */
  override async getUnnotifiedBonuses(client: AccountClientMetadata): Promise<AccountBonusBatch | null> {
    const profile = await this.getProfile(client)
    if (profile === null || profile.status !== 'ready' || profile.value.id === null) return null
    return { accountId: profile.value.id, bonuses: [] }
  }

  /** Nothing is ever shown, so nothing is acknowledged. */
  override ackBonusNotified(): Promise<boolean> {
    return Promise.resolve(false)
  }

  override async getDeviceIdentity(): Promise<{ deviceId?: string; userId?: AccountUserId; osVersion: string }> {
    const [record, session] = await Promise.all([
      this.ctx.credentials.readRecord(DEVICE),
      this.getPlatformSession(),
    ])
    const parsed = record?.kind === 'grant' ? device.safeParse(record.payload) : undefined
    return {
      ...parsed?.success ? { deviceId: parsed.data.id } : {},
      ...session?.userId == null ? {} : { userId: session.userId },
      osVersion: deviceOsVersion(),
    }
  }

  override async getPlatformSession(): Promise<PlatformSession | null> {
    const lifetime = this.detailsLifetime
    let stored: Grant | null
    try { stored = await this.freshGrant(lifetime) } catch { return null }
    if (stored === null || lifetime.signal.aborted) return null
    return {
      origin: this.origin, token: stored.accessToken,
      userId: this.lastProfile?.lineage === lineage(stored) ? this.lastProfile.profile.value.id : null,
      requestHeaders: {},
    }
  }

  override async resolveToken(url: string): Promise<string | undefined> {
    if (this.closed || this.removing !== undefined) return undefined
    let destination: URL
    try { destination = new URL(url) } catch { return undefined }
    if (destination.origin !== this.origin || destination.username || destination.password) return undefined
    try {
      return (await this.freshGrant(this.detailsLifetime))?.accessToken
    } catch {
      // The session was rejected (and removed) or storage failed: no credential to offer.
      return undefined
    }
  }

  /**
   * A model request was rejected with 401. Refresh once: a still-valid session keeps the login and the
   * caller retries with the new token; a rejected refresh removes the login and emits session-expired.
   */
  override async rejectToken(token: string): Promise<void> {
    const lifetime = this.detailsLifetime
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null || stored.accessToken !== token || this.detailsLifetime !== lifetime) return
    try { await this.refresh(stored, lifetime) } catch {
      // refresh() already removed a rejected session; a network failure keeps it for the next attempt.
    }
  }

  override async startSignIn(client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop'): Promise<AccountView> {
    if (this.removing !== undefined) await this.removing
    const origin = loginOrigin(callbackOrigin)
    if (this.closed) throw new VibeDevAuthError('protocol')
    if (this.attempt !== undefined && ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(this.attempt.view.phase)) {
      return this.getState()
    }
    const previous = this.attempt
    if (previous !== undefined) {
      await previous.done
      // Disposal can close the provider while the previous attempt settles.
      if (this.closed) throw new VibeDevAuthError('protocol')
      if (this.attempt !== previous) return this.getState()
    }
    const attempt: Attempt = {
      origin, loginSource,
      locale: platformWireLocale(client.locale),
      clientHeaders: platformClientHeaders(this.platform, client),
      view: { id: randomUUID() as SignInAttemptId, phase: 'initializing' },
      controller: new AbortController(), done: Promise.resolve(), running: Promise.resolve(),
    }
    this.attempt = attempt
    attempt.done = this.ctx.authorization.begin({
      key: KEY, signal: attempt.controller.signal,
      interaction: { notify: () => undefined, prompt: () => Promise.reject(new VibeDevAuthError('protocol')) },
    }).then((outcome) => {
      this.update(attempt, { phase: outcome.status === 'authorized' ? 'succeeded' : 'cancelled' })
      if (attempt.callback !== undefined) {
        if (outcome.status === 'authorized') writeCallbackPage(attempt.callback, 'succeeded', attempt.locale)
        else attempt.callback.writeHead(204, { 'cache-control': 'no-store' }).end()
      }
    }).catch((error: unknown) => {
      const code = error instanceof VibeDevAuthError ? error.code : 'protocol'
      console.info('[vibedev-account] sign-in failed', { errorCode: code })
      this.update(attempt, { phase: code === 'expired' ? 'expired' : 'failed', errorCode: code })
      if (attempt.callback !== undefined) {
        // Desktop focuses its own window and explains the failure there; the Web tab gets a page.
        if (attempt.loginSource === 'web') writeCallbackPage(attempt.callback, 'failed', attempt.locale)
        else attempt.callback.writeHead(204, { 'cache-control': 'no-store' }).end()
      }
    }).then(async () => {
      // begin() may report cancellation before the HTTP work observes its signal.
      await attempt.running.catch(() => undefined)
      if (attempt.callback !== undefined) {
        await streamPromises.finished(attempt.callback, { cleanup: true }).catch(() => undefined)
      }
      await attempt.disposeCallback?.()
    })
    this.changed()
    return this.getState()
  }

  override async cancelSignIn(id: SignInAttemptId): Promise<AccountView> {
    const attempt = this.attempt
    if (attempt?.view.id === id) {
      if (attempt.view.phase !== 'committing') {
        attempt.controller.abort()
        this.ctx.authorization.cancel(KEY)
      }
      await attempt.done
    }
    return this.getState()
  }

  override signOut(client: AccountClientMetadata): Promise<AccountView> {
    this.removing ??= (async () => {
      if (this.closed) throw new VibeDevAuthError('protocol')
      if (this.attempt !== undefined) await this.cancelSignIn(this.attempt.view.id)
      const record = await this.ctx.credentials.readRecord(KEY)
      if (record !== undefined) {
        if (record.kind !== 'grant') throw new VibeDevAuthError('storage')
        const parsed = grant.safeParse(record.payload)
        if (!parsed.success) throw new VibeDevAuthError('storage')
        await this.ctx.credentials.deleteRecord(KEY)
        if (parsed.data.issuer === this.origin) this.revoke(parsed.data.refreshToken, platformClientHeaders(this.platform, client))
      }
      this.attempt = undefined
      this.ctx.emit('deepseek-account/signed-out')
      this.changed()
      return this.getState()
    })().finally(() => { this.removing = undefined })
    return this.removing
  }

  override async *watch(signal: AbortSignal): AsyncIterable<AccountView> {
    let dirty = true
    let wake: (() => void) | undefined
    const changed = (): void => { dirty = true; wake?.() }
    this.listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (!this.closed && !signal.aborted) {
        if (dirty) { dirty = false; yield await this.getState(); continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.listeners.delete(changed)
      signal.removeEventListener('abort', changed)
    }
  }

  /**
   * The stored session with an access token that has at least `refreshSkewMs` left, refreshing if needed.
   * A network failure during refresh returns the stored session unchanged, so a transient outage never signs out.
   * @param lifetime - credential lifetime the read belongs to.
   * @returns the session, or null while signed out.
   * @throws AccountUnauthorizedError after the gateway rejected the session (it has been removed).
   */
  private async freshGrant(lifetime: AbortController): Promise<Grant | null> {
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null) return null
    if (stored.expiresAt - Date.now() > this.refreshSkew) return stored
    try {
      return await this.refresh(stored, lifetime)
    } catch (error) {
      if (error instanceof AccountUnauthorizedError) throw error
      return stored
    }
  }

  /**
   * Rotate the token pair once per process, under the credential store's cross-process lock: a concurrent
   * refresh elsewhere is picked up instead of repeated, because replaying a rotated refresh token makes the
   * gateway revoke the whole session.
   * @param stored - the session the caller holds.
   * @param lifetime - credential lifetime; a rejected refresh removes the session only within it.
   * @returns the session after rotation (possibly another process's).
   */
  private refresh(stored: Grant, lifetime: AbortController): Promise<Grant> {
    this.refreshing ??= this.refreshUnderLock(stored, lifetime).finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  private async refreshUnderLock(stored: Grant, lifetime: AbortController): Promise<Grant> {
    // Read outside the lock: the store serializes its operations, so a nested read would wait on this write.
    const deviceRecord = await this.ctx.credentials.readRecord(DEVICE)
    const deviceId = deviceRecord?.kind === 'grant' ? device.safeParse(deviceRecord.payload).data?.id : undefined
    let result: Grant | undefined
    let failure: unknown
    await this.ctx.credentials.modifyRecord(KEY, async (current) => {
      if (current?.kind !== 'grant') { failure = new AccountUnauthorizedError(); return undefined }
      const parsed = grant.safeParse(current.payload)
      if (!parsed.success) { failure = new VibeDevAuthError('storage'); return undefined }
      if (parsed.data.refreshToken !== stored.refreshToken) { result = parsed.data; return undefined }
      if (parsed.data.issuer !== this.origin) { failure = new VibeDevAuthError('protocol'); return undefined }
      try {
        const pair = expectShape(tokenPair, await gatewayRequest(this.origin, '/api/v1/vibedev/app-token/refresh', {
          method: 'POST', body: { refresh_token: parsed.data.refreshToken, ...deviceId === undefined ? {} : { device_id: deviceId } },
          signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.requestTimeout)]),
        }))
        result = this.grantOf(pair, parsed.data.sessionId)
        return { kind: 'grant', payload: result }
      } catch (error) {
        failure = error
        return undefined
      }
    })
    if (result !== undefined) return result
    if (failure instanceof AccountUnauthorizedError) await this.expireCredential(stored.refreshToken, lifetime)
    throw failure ?? new VibeDevAuthError('storage')
  }

  /** Read the account once per access token at a time; a 401 refreshes and retries once. */
  private async readMe(lifetime: AbortController): Promise<AccountMe | null> {
    const stored = await this.freshGrant(lifetime)
    if (stored === null) return null
    try {
      return await this.readMeWith(stored.accessToken, lifetime)
    } catch (error) {
      if (!(error instanceof AccountUnauthorizedError)) throw error
      const rotated = await this.refresh(stored, lifetime)
      return this.readMeWith(rotated.accessToken, lifetime)
    }
  }

  private readMeWith(token: string, lifetime: AbortController): Promise<AccountMe> {
    if (this.meRead?.token === token) return this.meRead.promise
    const promise = gatewayRequest(this.origin, '/v1/account/auth/me', {
      method: 'GET', token, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(this.requestTimeout)]),
    }).then(payload => expectShape(accountMe, payload)).finally(() => {
      if (this.meRead?.promise === promise) this.meRead = undefined
    })
    this.meRead = { token, promise }
    return promise
  }

  private grantOf(pair: TokenPair, previousSession?: string): Grant {
    const sessionId = pair.session_id ?? previousSession
    return {
      version: 1, accessToken: pair.access_token, refreshToken: pair.refresh_token,
      expiresAt: Date.now() + pair.expires_in * 1000, issuer: this.origin,
      ...sessionId === undefined ? {} : { sessionId },
    }
  }

  private cacheProfile(stored: Grant, profile: ReadyProfile): void {
    // Identity publishers re-read the session snapshot; wake them only when the stable ID changes.
    const previous = this.lastProfile?.profile.value.id ?? null
    this.lastProfile = { lineage: lineage(stored), profile }
    if (previous !== profile.value.id) this.changed()
  }

  private async readCurrentGrant(lifetime: AbortController): Promise<Grant | null> {
    if (this.closed) return null
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined || lifetime.signal.aborted) return null
    if (record.kind !== 'grant') throw new VibeDevAuthError('storage')
    const parsed = grant.safeParse(record.payload)
    if (!parsed.success) throw new VibeDevAuthError('storage')
    if (parsed.data.issuer !== this.origin) throw new VibeDevAuthError('protocol')
    return parsed.data
  }

  /**
   * A token rotation within one gateway session keeps in-flight reads and the profile cache; any other change
   * (a new sign-in, sign-out, or a session without an id) starts a new credential lifetime.
   */
  private async onRecordUpdated(): Promise<void> {
    const record = await this.ctx.credentials.readRecord(KEY).catch(() => undefined)
    const parsed = record?.kind === 'grant' ? grant.safeParse(record.payload) : undefined
    const next = parsed?.success === true ? lineage(parsed.data) : undefined
    const sameSession = next !== undefined && next.startsWith('session:') && next === this.sessionLineage
    this.sessionLineage = next
    if (!sameSession) this.invalidateDetails()
    this.changed()
  }

  private async expireCredential(refreshToken: string, lifetime: AbortController): Promise<void> {
    this.removing ??= (async () => {
      if (this.attempt !== undefined) await this.cancelSignIn(this.attempt.view.id)
      const record = await this.ctx.credentials.readRecord(KEY)
      if (this.closed || this.detailsLifetime !== lifetime || record?.kind !== 'grant') return this.getState()
      const current = grant.safeParse(record.payload)
      if (!current.success || current.data.refreshToken !== refreshToken) return this.getState()
      await this.ctx.credentials.deleteRecord(KEY)
      this.ctx.emit('deepseek-account/session-expired')
      this.attempt = undefined
      this.ctx.emit('deepseek-account/signed-out')
      this.changed()
      return this.getState()
    })().finally(() => { this.removing = undefined })
    await this.removing
  }

  /** Revoke a session already removed locally; failures retry in the background and never restore it. */
  private revoke(refreshToken: string, headers: Record<string, string>): void {
    if (this.closed) return
    const revocation = (async () => {
      for (let attempt = 0; attempt <= this.logoutRetries; attempt++) {
        if (this.lifetime.signal.aborted) return
        if (attempt > 0) {
          try { await sleep(this.logoutDelay * 2 ** (attempt - 1), undefined, { signal: this.lifetime.signal, ref: false }) }
          catch { return }
        }
        try {
          await gatewayRequest(this.origin, '/api/v1/vibedev/app-token/revoke', {
            method: 'POST', body: { refresh_token: refreshToken }, headers,
            signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.requestTimeout)]),
          })
          return
        } catch {
          // HTTP and transport failures consume one attempt without restoring the session.
        }
      }
    })().finally(() => { this.background.delete(revocation) })
    this.background.add(revocation)
  }

  private invalidateDetails(): void {
    this.lastProfile = undefined
    this.meRead = undefined
    this.detailsLifetime.abort()
    this.detailsLifetime = new AbortController()
  }

  private changed(): void { for (const listener of this.listeners) listener() }

  private update(attempt: Attempt, value: Partial<SignInAttemptView>): void {
    const { authorizeUrl: _url, ...rest } = attempt.view
    attempt.view = { ...rest, ...value }
    this.changed()
  }

  private async run(session: AuthorizationSession, attempt: Attempt): Promise<void> {
    const webServer = this.ctx.get('webServer')
    if (webServer === undefined) throw new VibeDevAuthError('protocol')
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const code = Promise.withResolvers<string>()
    // Callback requests may race the attempt's own settlement; the rejection is observed immediately.
    void code.promise.catch(() => undefined)
    const deadline = new AbortController()
    const expiresAt = Date.now() + this.attemptTimeout
    const signal = AbortSignal.any([session.signal, deadline.signal])
    const timer = setTimeout(() => { deadline.abort() }, this.attemptTimeout)
    const abort = (): void => { code.reject(new VibeDevAuthError('expired')) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      attempt.disposeCallback = this.ctx.effect(() => webServer.register({
        kind: 'exact', path: CALLBACK_PATH, handler: (req, res) => {
          let url: URL
          try { url = new URL(req.url ?? '/', 'http://127.0.0.1') }
          catch { res.writeHead(400, { 'cache-control': 'no-store' }).end(); return }
          const receivedCode = url.searchParams.get('code')
          const receivedState = url.searchParams.get('state') ?? ''
          const validState = Buffer.byteLength(receivedState) === Buffer.byteLength(state)
            && timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))
          if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH || !validState || !receivedCode
            || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1
            || url.searchParams.has('payload')) {
            res.writeHead(400, { 'cache-control': 'no-store' }).end(); return
          }
          if (signal.aborted || attempt.callback !== undefined || attempt.view.phase !== 'waiting-browser') {
            res.writeHead(410, { 'cache-control': 'no-store' }).end(); return
          }
          attempt.callback = res
          code.resolve(receivedCode)
        },
      }), 'vibedev-account: browser callback')
      signal.throwIfAborted()
      const url = authorizeUrl(this.origin, { callback: `${attempt.origin}${CALLBACK_PATH}`, state, challenge })
      this.update(attempt, { phase: 'waiting-browser', authorizeUrl: url, expiresAt })
      const receivedCode = await code.promise
      signal.throwIfAborted()
      this.update(attempt, { phase: 'exchanging' })
      const deviceRecord = await this.ctx.credentials.modifyRecord(DEVICE, current => Promise.resolve(current === undefined
        ? { kind: 'grant', payload: { id: randomUUID() } } : undefined))
      if (deviceRecord?.kind !== 'grant') throw new VibeDevAuthError('storage')
      const identity = device.parse(deviceRecord.payload)
      const pair = expectShape(tokenPair, await gatewayRequest(this.origin, '/api/v1/vibedev/link/redeem', {
        method: 'POST', headers: attempt.clientHeaders,
        body: {
          code: receivedCode, code_verifier: verifier, token_type: 'app', client: CLIENT_ID,
          device_id: identity.id, device_model: `${platform()}-${arch()}`, os_version: deviceOsVersion(),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeout)]),
      }).catch((error: unknown) => {
        // An unusable code or verifier is a failed sign-in, not an expired session.
        throw error instanceof AccountUnauthorizedError ? new VibeDevAuthError('protocol') : error
      }))
      if (Date.now() >= expiresAt) deadline.abort()
      signal.throwIfAborted()
      this.update(attempt, { phase: 'committing' })
      clearTimeout(timer)
      try { await session.commit({ kind: 'grant', payload: this.grantOf(pair) }) }
      catch { throw new VibeDevAuthError('storage') }
    } catch (error) {
      if (deadline.signal.aborted) throw new VibeDevAuthError('expired')
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      // begin() settles the browser response and removes only this attempt's route.
    }
  }
}
export default VibeDevAccount

/** OS identification shared by sign-in and credential-free identity reads. */
function deviceOsVersion(): string {
  return `${platform()} ${release()}`
}
