import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotarizeOptions } from '@electron/notarize'
import { notarizeMacOS } from '../scripts/notarize-macos.mjs'

const { notarizeMock } = vi.hoisted(() => ({ notarizeMock: vi.fn<(options: NotarizeOptions) => Promise<void>>() }))
vi.mock('@electron/notarize', () => ({ notarize: notarizeMock }))

const options = { appPath: '/release with spaces/VibeDev.app', appleId: 'fixture@example.invalid', appleIdPassword: 'fixture-secret', teamId: 'TEAM123456' }
const transportFailure = () => new Error('Failed to staple your application with code: 68\nError Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\nThe staple and validate action failed! Error 68.')

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('DSH_DESKTOP_PACKAGING_RUN_DIR', undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('macOS stapling after Apple acceptance', () => {
  it('recovers a dropped ticket connection without submitting the signed artifact again', async () => {
    notarizeMock.mockRejectedValueOnce(transportFailure())
    const staple = vi.fn(async (_path: string) => {})
    const wait = vi.fn(async (_ms: number) => {})
    await expect(notarizeMacOS(options, { staple, wait })).resolves.toBeUndefined()
    expect(notarizeMock).toHaveBeenCalledTimes(1)
    expect(staple).toHaveBeenCalledExactlyOnceWith(options.appPath)
    expect(wait).toHaveBeenCalledExactlyOnceWith(10_000)
    const submitted = notarizeMock.mock.calls[0]?.[0]
    expect(submitted).toMatchObject(options)
    expect(submitted && 'notarytoolPath' in submitted ? submitted.notarytoolPath : undefined).toContain('logged-notarytool.mjs')
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toContain(options.appleIdPassword)
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toContain(options.appleId)
  })

  it('leaves a successful notarization untouched', async () => {
    notarizeMock.mockResolvedValueOnce(undefined)
    const staple = vi.fn(async (_path: string) => {})
    const wait = vi.fn(async (_ms: number) => {})
    await notarizeMacOS(options, { staple, wait })
    expect(staple).not.toHaveBeenCalled()
    expect(wait).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('retries a DMG ticket connection reported in stdout, without a second Apple submission', async () => {
    notarizeMock.mockRejectedValueOnce(transportFailure())
    const interrupted = Object.assign(new Error('Command failed: xcrun stapler'), { code: 68, stdout: 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."' })
    const staple = vi.fn(async (_path: string) => {}).mockRejectedValueOnce(interrupted)
    const wait = vi.fn(async (_ms: number) => {})
    const dmg = { ...options, appPath: '/release with spaces/VibeDev.dmg' }
    await notarizeMacOS(dmg, { staple, wait })
    expect(notarizeMock).toHaveBeenCalledTimes(1)
    expect(staple.mock.calls).toEqual([[dmg.appPath], [dmg.appPath]])
    expect(wait.mock.calls).toEqual([[10_000], [30_000]])
  })

  it.each([
    ['signature rejection', new Error('codesign verification failed')],
    ['credential rejection', new Error('notarytool rejected authorization')],
    ['submission connection loss', new Error('notarytool submission: Error Domain=NSURLErrorDomain Code=-1005')],
    ['invalid ticket', new Error('Failed to staple your application with code: 68\nTicket validation failed')],
    ['unrecognized stapler exit', new Error('Failed to staple your application with code: 65\nError Domain=NSURLErrorDomain Code=-1005')],
  ])('does not retry %s', async (_name, failure) => {
    notarizeMock.mockRejectedValueOnce(failure)
    const staple = vi.fn(async (_path: string) => {})
    const wait = vi.fn(async (_ms: number) => {})
    await expect(notarizeMacOS(options, { staple, wait })).rejects.toBe(failure)
    expect(staple).not.toHaveBeenCalled()
    expect(wait).not.toHaveBeenCalled()
  })

  it('fails after the bounded recovery budget with the final command failure as its cause', async () => {
    notarizeMock.mockRejectedValueOnce(transportFailure())
    const interrupted = Object.assign(new Error('Command failed: xcrun stapler'), { code: 68, stdout: 'Error Domain=NSURLErrorDomain Code=-1005' })
    const staple = vi.fn(async (_path: string) => { throw interrupted })
    const wait = vi.fn(async (_ms: number) => {})
    const operation = notarizeMacOS(options, { staple, wait })
    await expect(operation).rejects.toMatchObject({ cause: interrupted })
    await expect(operation).rejects.toThrow('recovery exhausted')
    expect(notarizeMock).toHaveBeenCalledTimes(1)
    expect(staple).toHaveBeenCalledTimes(4)
    expect(wait.mock.calls).toEqual([[10_000], [30_000], [60_000], [120_000]])
  })

  it('stops when a later ticket check fails for another reason', async () => {
    notarizeMock.mockRejectedValueOnce(transportFailure())
    const invalidTicket = Object.assign(new Error('Ticket validation failed'), { code: 68 })
    const staple = vi.fn(async (_path: string) => { throw invalidTicket })
    const wait = vi.fn(async (_ms: number) => {})
    await expect(notarizeMacOS(options, { staple, wait })).rejects.toBe(invalidTicket)
    expect(staple).toHaveBeenCalledTimes(1)
    expect(wait).toHaveBeenCalledTimes(1)
  })

  it('stops if the operation owner cancels the recovery wait', async () => {
    notarizeMock.mockRejectedValueOnce(transportFailure())
    const cancelled = new Error('fixture cancelled')
    const staple = vi.fn(async (_path: string) => {})
    await expect(notarizeMacOS(options, { staple, wait: async () => { throw cancelled } })).rejects.toBe(cancelled)
    expect(staple).not.toHaveBeenCalled()
  })
})
