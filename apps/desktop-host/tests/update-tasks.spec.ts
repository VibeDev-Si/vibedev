import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { installDesktopUpdateTaskControl } from '../src/update-tasks.ts'

interface Response { writeHead(code: number): unknown; end(): unknown }
type Handler = (request: { method?: string }, response: Response, next: () => Promise<unknown>) => Promise<unknown>

/** The parts of the Host context the update control uses: the request hook and the task services. */
function host() {
  let handler: Handler | undefined
  const ctx = {
    effect: () => undefined,
    on: (_name: string, listener: Handler) => { handler = listener },
    get: (name: string) => name === 'agents' ? { list: () => [] } : name === 'jobs' ? { list: () => [] } : undefined,
  } as unknown as Context
  const control = installDesktopUpdateTaskControl(ctx)
  /** One request that stays open until `finish` is called. */
  const open = (method: string) => {
    const done = Promise.withResolvers<undefined>()
    const status: number[] = []
    const response: Response = { writeHead: (code) => { status.push(code) }, end: () => undefined }
    const settled = handler!({ method }, response, () => done.promise)
    return { finish: () => { done.resolve(undefined) }, settled, status }
  }
  return { control, open }
}

const within = <T>(promise: Promise<T>, ms: number) => Promise.race([promise, new Promise<'pending'>((resolve) => { setTimeout(() => { resolve('pending') }, ms) })])

describe('desktop update admission', () => {
  // VibeDev fork: the account plugin keeps a GET long poll open for up to 25 s; waiting for it made the
  // 10 s update deadline fail about every other attempt ("task inspection timed out").
  it('does not wait for an open read request (a long poll) before installing', async () => {
    const { control, open } = host()
    const poll = open('GET')
    expect(await within(control('lock'), 200)).toBe(false)
    poll.finish(); await poll.settled
  })

  it('still waits for an admitted write to finish', async () => {
    const { control, open } = host()
    const write = open('POST')
    expect(await within(control('lock'), 200)).toBe('pending')
    write.finish(); await write.settled
    expect(await within(control('lock'), 200)).toBe(false)
  })

  it('refuses new requests of any kind while locked, and admits them again after unlock', async () => {
    const { control, open } = host()
    await control('lock')
    const refused = open('GET'); await refused.settled
    expect(refused.status).toEqual([503])
    await control('unlock')
    const admitted = open('GET'); admitted.finish(); await admitted.settled
    expect(admitted.status).toEqual([])
  })
})
