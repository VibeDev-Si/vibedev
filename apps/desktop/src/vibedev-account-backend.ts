/**
 * VibeDev: the VibeDev account for the native welcome flow. The account comes from the built-in
 * `@vibedev-si/dsh-vibedev` plugin, which serves it on the Host's `/api/dsh-vibedev/account` routes (the same ones its
 * Settings section and sidebar row use). This presents it in the DeepSeek account's `AccountView` shape, so the welcome
 * window and its main-process wiring stay as they are: the plugin opens the browser itself, and a poll stands in for
 * the account stream, reporting `succeeded` once when a waiting sign-in ends signed in. No credential reaches this
 * process: the routes answer with who is signed in, the balance and the sign-in link only.
 */

import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import { nativeVibeDevAttempt, type DesktopAccountView, type DesktopSignInAttempt } from './vibedev-sign-in-diagnostics.ts'

/** The plugin's account route. */
export const VIBEDEV_ACCOUNT_ROUTE = '/api/dsh-vibedev/account'

/** What the plugin's route answers with (the fields this flow reads). */
interface PluginAccountView {
  readonly source: 'host' | 'plugin' | 'key' | 'none'
  readonly pending?: { readonly url: string; readonly expiresAt: number }
  readonly links: { readonly topUp: string; readonly usage: string }
  readonly primary?: boolean
  readonly attempt?: DesktopSignInAttempt
}

/** The welcome flow's view of the VibeDev account: the DeepSeek account backend's interface, minus its extra streams. */
export interface VibeDevAccountBackend {
  /** @returns current account snapshot. */
  state(): Promise<AccountView>
  /**
   * @param _client - the DeepSeek backend's client identity, unused here.
   * @returns state after starting a sign-in; the plugin opens the browser.
   */
  start(_client?: unknown): Promise<AccountView>
  /** @param id - attempt to cancel. @returns the settled state. */
  cancel(id: SignInAttemptId): Promise<AccountView>
  /** @param _client - unused, as for start. @returns state after signing out of the plugin's own sign-in. */
  signOut(_client?: unknown): Promise<AccountView>
  /**
   * Poll the account: every `pendingMs` while a sign-in waits for the browser, every `idleMs` otherwise.
   * @param listener - state recipient; a sign-in that ends signed in is reported once as `succeeded`.
   * @param failed - read failure recipient (the poll goes on).
   * @returns poll disposer.
   */
  watch(listener: (state: AccountView) => void, failed: () => void): () => void
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode the plugin's answer; anything else is a failed read.
 * @param value - parsed JSON.
 * @returns the fields this flow uses.
 */
export function pluginAccountView(value: unknown): PluginAccountView {
  if (!record(value) || !['host', 'plugin', 'key', 'none'].includes(String(value.source)) || !record(value.links)
    || typeof value.links.topUp !== 'string' || typeof value.links.usage !== 'string') {
    throw new Error('vibedev account: invalid state')
  }
  const pending = record(value.pending) && typeof value.pending.url === 'string' && typeof value.pending.expiresAt === 'number'
    ? { url: value.pending.url, expiresAt: value.pending.expiresAt } : undefined
  const attempt = nativeVibeDevAttempt(value.attempt)
  return {
    source: value.source as PluginAccountView['source'],
    links: { topUp: value.links.topUp, usage: value.links.usage },
    ...pending === undefined ? {} : { pending },
    ...typeof value.primary === 'boolean' ? { primary: value.primary } : {},
    ...attempt === undefined ? {} : { attempt },
  }
}

/**
 * The plugin's view as the welcome flow's `AccountView`.
 * @param view - the plugin's answer.
 * @param attempt - an attempt to report instead of the pending one (a finished sign-in).
 * @returns the account projection.
 */
export function accountViewOf(view: PluginAccountView, attempt?: AccountView['attempt']): DesktopAccountView {
  return {
    status: view.source === 'none' ? 'signed-out' : 'credential-stored',
    links: { usageUrl: view.links.usage, topUpUrl: view.links.topUp },
    // A retained success is historical once refresh/sign-out removes the credential.
    // The welcome window must return to its sign-in entry, rather than wait on that old success.
    attempt: view.source === 'none' && view.attempt?.phase === 'succeeded' ? null : view.attempt !== undefined ? {
      ...view.attempt,
      ...view.attempt.phase === 'waiting-browser' && view.pending !== undefined ? { authorizeUrl: view.pending.url } : {},
    } : attempt !== undefined ? attempt : view.pending === undefined ? null : {
      id: attemptId(view.pending.expiresAt), phase: 'waiting-browser', authorizeUrl: view.pending.url, expiresAt: view.pending.expiresAt,
    },
  }
}

/** A stable id for one waiting sign-in: its deadline is unique per attempt. */
const attemptId = (expiresAt: number): SignInAttemptId => `vibedev-${expiresAt}` as SignInAttemptId

/**
 * Connect the welcome flow to the plugin's account routes.
 * @param origin - Host Web origin.
 * @param send - authenticated fetch (the Electron session's, carrying the Web cookie).
 * @param options - poll intervals and clock, for tests.
 * @returns the backend, or undefined when the plugin does not serve the main account (absent, disabled, or not primary).
 */
export async function connectVibeDevAccount(
  origin: string,
  send: (input: string, init?: RequestInit) => Promise<Response>,
  options: {
    readonly pendingMs?: number
    readonly idleMs?: number
    readonly now?: () => number
    readonly probeTries?: number
    readonly probeDelayMs?: number
  } = {},
): Promise<VibeDevAccountBackend | undefined> {
  const url = (path = ''): string => new URL(`${VIBEDEV_ACCOUNT_ROUTE}${path}`, origin).href
  let latestAttempt: SignInAttemptId | undefined
  const read = async (fresh = false): Promise<PluginAccountView> => {
    const response = await send(url(fresh ? '?fresh=1' : ''), { credentials: 'include', redirect: 'error' })
    if (!response.ok) throw new Error(`vibedev account: HTTP ${response.status}`)
    const view = pluginAccountView(await response.json())
    latestAttempt = view.attempt?.id
    return view
  }
  const post = async (path: string, body: Record<string, unknown> = {}): Promise<void> => {
    const response = await send(url(path), {
      method: 'POST', credentials: 'include', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`vibedev account: HTTP ${response.status}`)
    await response.body?.cancel()
  }
  // Asked once the Host is ready, when its plugins have registered their routes. A network failure or an HTTP error is
  // asked again shortly; an answer that is not the plugin's (no plugin, or another page) is final.
  let first: PluginAccountView | undefined
  for (let tries = 0; tries < (options.probeTries ?? 3); tries++) {
    if (tries > 0) await new Promise(resolve => setTimeout(resolve, options.probeDelayMs ?? 300))
    let response: Response
    try { response = await send(url(), { credentials: 'include', redirect: 'error' }) } catch { continue }
    if (!response.ok) { await response.body?.cancel(); continue }
    try { first = pluginAccountView(await response.json()) } catch { return undefined }
    break
  }
  if (first?.primary !== true) return undefined
  latestAttempt = first.attempt?.id
  const now = options.now ?? Date.now
  let cancelled: SignInAttemptId | undefined
  // The sign-in the welcome flow waits for, shared by start() and the poll so a quick sign-in is not missed.
  let waiting: { readonly id: SignInAttemptId; readonly expiresAt: number } | undefined
  let kick: (() => void) | undefined
  return {
    state: async () => accountViewOf(await read()),
    async start() {
      // The plugin opens the system browser itself, as it does from its Settings section.
      cancelled = undefined
      const previousAttempt = latestAttempt
      let refused = false
      try { await post('/sign-in', { open: true }) } catch { refused = true }
      let view: PluginAccountView
      try { view = await read() } finally { kick?.() }
      // Listener/storage startup failures are retained by the Host even when the POST returns an error.
      // A previous attempt is not evidence that this new request reached the Host.
      if (refused && (view.attempt === undefined || view.attempt.id === previousAttempt)) {
        throw new Error('vibedev account: sign-in could not start')
      }
      if (view.attempt !== undefined) waiting = ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(view.attempt.phase)
        ? { id: view.attempt.id, expiresAt: view.attempt.expiresAt ?? now() } : undefined
      else if (view.pending !== undefined) waiting = { id: attemptId(view.pending.expiresAt), expiresAt: view.pending.expiresAt }
      return accountViewOf(view)
    },
    async cancel(id) {
      cancelled = id
      await post('/cancel')
      return accountViewOf(await read())
    },
    async signOut() {
      await post('/sign-out')
      return accountViewOf(await read())
    },
    watch(listener, failed) {
      let closed = false
      let timer: ReturnType<typeof setTimeout> | undefined
      // One read at a time: a wake during a read asks for another one right after it.
      let reading = false
      let again = false
      const poll = async (): Promise<void> => {
        if (reading) { again = true; return }
        reading = true
        try {
          const view = await read()
          if (closed) return
          let attempt: AccountView['attempt'] | undefined
          if (view.attempt !== undefined) waiting = ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(view.attempt.phase)
            ? { id: view.attempt.id, expiresAt: view.attempt.expiresAt ?? now() } : undefined
          else if (view.pending !== undefined) waiting = { id: attemptId(view.pending.expiresAt), expiresAt: view.pending.expiresAt }
          else if (waiting !== undefined) {
            // The waiting sign-in ended: say how, once.
            const phase = view.source !== 'none' ? 'succeeded' : cancelled === waiting.id ? 'cancelled' : now() >= waiting.expiresAt ? 'expired' : 'failed'
            attempt = { id: waiting.id, phase }
            waiting = undefined
          }
          listener(accountViewOf(view, attempt))
        } catch {
          if (!closed) failed()
        } finally {
          reading = false
        }
        if (closed) return
        if (again) { again = false; void poll(); return }
        timer = setTimeout(() => { void poll() }, waiting === undefined ? options.idleMs ?? 15_000 : options.pendingMs ?? 1_000)
      }
      kick = () => { clearTimeout(timer); void poll() }
      void poll()
      return () => { closed = true; kick = undefined; clearTimeout(timer) }
    },
  }
}
