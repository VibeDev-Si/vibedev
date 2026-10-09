/** Real Loader + packed built-in plugin. Only remote gateways are mocked; localhost PKCE remains real. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const defaults = fileURLToPath(new URL('../..', import.meta.url))
const repo = join(defaults, '../../..')
const require = createRequire(join(defaults, 'package.json'))
const yaml = require('js-yaml')
const { boot } = await import(pathToFileURL(join(repo, 'packages/boot/app-boot/lib/index.js')).href)
const { createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
const american = 'https://api.vibedev.studio'
const tmp = await mkdtemp(join(tmpdir(), 'vibedev-us-loader-'))
process.env.DSH_HOME = join(tmp, 'home')
const stateDir = join(tmp, 'media-state')
const nativeFetch = globalThis.fetch
const requests = []
const contexts = []
const model = () => ({ id: 'fixture-us-chat', protocol: 'openai', capabilities: { input_modalities: ['text'], allowed_endpoints: ['/v1/chat/completions'] } })
const answer = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const waitFor = async test => {
  for (let attempt = 0; attempt < 80; attempt++) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error('Fixture condition did not settle')
}
let authorize
let streamAborted = false

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.hostname === '127.0.0.1') return nativeFetch(input, init)
  assert.equal(url.origin, american, 'No request may use a historical or alternate gateway')
  const headers = new Headers(init.headers)
  const auth = headers.get('authorization')
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  requests.push({ origin: url.origin, path: url.pathname, auth, body, redirect: init.redirect })
  if (url.origin === american && auth !== null) assert.equal(auth, 'Bearer fixture-us-app', 'Domestic token must never be sent to America')
  assert.equal(init.redirect, 'error')
  if (url.pathname === '/api/v1/vibedev/link/redeem') {
    assert.equal(url.origin, american)
    assert.equal(body.token_type, 'app')
    assert.equal(body.client, 'vibedev-plugin')
    assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), authorize.searchParams.get('code_challenge'))
    assert.equal(body.hmac_secret, undefined)
    return answer({ access_token: 'fixture-us-app', refresh_token: 'fixture-us-refresh', expires_in: 3600, refresh_expires_in: 86400 })
  }
  if (url.pathname === '/api/v1/vibedev/app-token/revoke') return answer({ ok: true })
  if (url.pathname === '/v1/models') return answer({ data: [model(url.origin)] })
  if (url.pathname === '/v1/vibedev/web-search') return answer({ results: [{ url: 'https://example.com/mock-source', title: 'fixture result' }], answers: ['fixture search'] })
  if (url.pathname === '/v1/chat/completions') {
    assert.equal(url.origin, american)
    const signal = init.signal
    const bytes = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.encode(': heartbeat\n\n'))
        controller.enqueue(bytes.encode(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture stream' }, finish_reason: null }] })}\n\n`))
        if (body.messages.some(message => message.content === 'cancel fixture')) {
          const abort = () => { streamAborted = true; controller.error(new DOMException('cancelled', 'AbortError')) }
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        } else {
          controller.enqueue(bytes.encode(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
          controller.close()
        }
      },
      cancel() { streamAborted = true },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  }
  throw new Error(`Unscripted gateway route ${url.pathname}`)
}

try {
  await mkdir(join(stateDir, 'tasks'), { recursive: true })
  const legacyGrant = JSON.stringify({ accessToken: 'fixture-cn-app', refreshToken: 'fixture-cn-refresh', expiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 86_400_000 })
  await writeFile(join(stateDir, 'session.json'), legacyGrant)
  const history = JSON.stringify({ id: 'old-video', kind: 'video', model: 'fixture', label: 'old', createdAt: Date.now(), updatedAt: Date.now(), status: 'completed', outputs: [{ url: 'https://legacy.example/old.mp4?sig=keep%2Boriginal' }] })
  await writeFile(join(stateDir, 'tasks/old-video.json'), history)
  await writeFile(join(tmp, 'other-accounts.json'), '{"deepseek":"fixture-preserved"}')
  await writeFile(join(tmp, 'local-chat.json'), '{"conversation":"fixture-preserved"}')
  const production = yaml.load(await readFile(join(defaults, 'cordis.patch.yml'), 'utf8'))
  const productionRow = production.flatMap(entry => entry.insert ?? []).find(entry => entry.id === 'dsh-vibedev')
  assert.equal(productionRow.config.gatewayOrigin, american)
  assert.equal(productionRow.config.apiKeyEnv, '')
  const start = async (label, selected) => {
    const config = join(tmp, `${label}.cordis.yml`)
    const rows = [
      { id: 'system-prompt', name: createRequire(require.resolve('@deepseek-ai/dsh-tools')).resolve('@deepseek-ai/dsh-system-prompt') },
      { id: 'llm', name: require.resolve('@deepseek-ai/dsh-llm') },
      { id: 'tools', name: require.resolve('@deepseek-ai/dsh-tools') },
      { id: 'web', name: require.resolve('@deepseek-ai/dsh-web'), config: { searchProvider: 'vibedev-gateway' } },
      { ...productionRow, name: require.resolve('@vibedev-si/dsh-vibedev'), config: { ...selected, stateDir, openBrowserOnSignIn: false } },
    ]
    await writeFile(config, yaml.dump(rows))
    const ctx = await boot('migration-fixture', config, undefined, undefined, pathToFileURL(join(repo, 'apps/cli/package.json')).href)
    contexts.push(ctx)
    return ctx
  }
  const status = async (ctx, action) => {
    const result = await ctx.tools.execute({ callId: `fixture-${action}`, name: 'media_account', arguments: { action }, signal: new AbortController().signal })
    assert.notEqual(result.isError, true)
    return result.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
  }
  const oldTasks = []
  for (const kind of ['video', 'audio']) await writeFile(join(stateDir, `tasks/pending-${kind}.json`), JSON.stringify({
    id: `pending-${kind}`, kind, model: 'fixture', label: 'old pending task', createdAt: Date.now(), updatedAt: Date.now(),
    status: kind === 'video' ? 'pending' : 'submitting', gatewayId: kind === 'video' ? 'old-remote' : undefined,
    endpoint: kind === 'video' ? '/v1/videos' : '/v1/audio/generations', body: { reference: 'https://legacy.example/old.mp4?sig=keep' },
    outputDir: join(tmp, 'outputs'), stem: 'old',
  }))
  for (const kind of ['video', 'audio']) oldTasks.push(await readFile(join(stateDir, `tasks/pending-${kind}.json`), 'utf8'))
  const us = await start('american', productionRow.config)
  assert.match(await status(us, 'status'), /Nobody is signed in/)
  assert.deepEqual(await us.llm.listModels('vibedev-gateway'), [])
  assert.equal(requests.filter(request => request.origin === american).length, 0)
  const signIn = await status(us, 'sign_in')
  const match = signIn.match(/https:\/\/api\.vibedev\.studio\/vibedev-link\?\S+/)
  assert.ok(match)
  authorize = new URL(match[0])
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  const callback = new URL(authorize.searchParams.get('callback'))
  assert.equal(callback.hostname, '127.0.0.1')
  assert.equal(callback.pathname, '/dsh-media/callback')
  callback.search = new URLSearchParams({ state: 'wrong-fixture-state', code: 'fixture-code' }).toString()
  assert.equal((await nativeFetch(callback)).status, 400)
  assert.equal(requests.filter(request => request.path.endsWith('/redeem')).length, 0)
  callback.search = new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'fixture-code' }).toString()
  assert.equal((await nativeFetch(callback)).status, 200)
  await waitFor(async () => (await us.llm.listModels('vibedev-gateway')).some(model => model.id === 'fixture-us-chat'))
  assert.match(await status(us, 'status'), /this plugin's VibeDev sign-in/)
  const search = await us.web.search({ query: 'fixture search' })
  assert.equal(search.sources[0].url, 'https://example.com/mock-source')
  const chunks = []
  for await (const chunk of us.llm.stream({ provider: 'vibedev-gateway', model: 'fixture-us-chat', messages: [createUserMessage({ content: [{ type: 'text', text: 'stream fixture' }], source: { kind: 'user' } })] })) chunks.push(chunk)
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' || JSON.stringify(chunk).includes('fixture stream')))
  const stop = new AbortController()
  const cancellation = us.llm.stream({ provider: 'vibedev-gateway', model: 'fixture-us-chat', signal: stop.signal, messages: [createUserMessage({ content: [{ type: 'text', text: 'cancel fixture' }], source: { kind: 'user' } })] })
  for await (const chunk of cancellation) { if (JSON.stringify(chunk).includes('fixture stream')) stop.abort() }
  assert.equal(streamAborted, true)
  await status(us, 'sign_out')
  await waitFor(async () => (await us.llm.listModels('vibedev-gateway')).length === 0)
  assert.equal(await readFile(join(stateDir, 'session.json'), 'utf8'), legacyGrant)
  assert.equal(await readFile(join(stateDir, 'tasks/old-video.json'), 'utf8'), history)
  for (const [index, kind] of ['video', 'audio'].entries()) assert.equal(await readFile(join(stateDir, `tasks/pending-${kind}.json`), 'utf8'), oldTasks[index])
  assert.equal(await readFile(join(tmp, 'other-accounts.json'), 'utf8'), '{"deepseek":"fixture-preserved"}')
  assert.equal(await readFile(join(tmp, 'local-chat.json'), 'utf8'), '{"conversation":"fixture-preserved"}')
  await us.fiber.dispose()
  assert.equal(us.get('vibedevMedia'), undefined)
  console.log(JSON.stringify({ ok: true, installedPlugin: require('@vibedev-si/dsh-vibedev/package.json').version, loader: true, originIsolation: true, pkceStateLoopbackAppToken: true, hiddenBeforeLogin: true, searchOnSelectedAPI: true, sseHeartbeatAndCancel: true, preservedLegacyAndOtherData: true, disposed: true }))
} finally {
  for (const ctx of contexts) await ctx.fiber.dispose()
  globalThis.fetch = nativeFetch
  await rm(tmp, { recursive: true, force: true })
}
