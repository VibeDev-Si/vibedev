/** Verify application qualification commands without invoking Apple tools. */

import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyMacOSNotarizedApplication } from '../scripts/verify-macos-signature.mjs'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(),
}))

const expected = { signingIdentity: 'Example Company (TEAMID1234)', teamId: 'TEAMID1234' }
const appPath = '/private build/DeepSeek Harness.app'
const commands = [
  ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]],
  ['/usr/bin/codesign', ['--display', '--verbose=4', appPath]],
  ['/usr/bin/xcrun', ['stapler', 'validate', appPath]],
  ['/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]],
] as const

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })

describe('notarized application qualification', () => {
  it.each([undefined, 0, 1, 2, 3])('stops at failed command %s or verifies every qualification', (failedCommand) => {
    let index = 0
    vi.mocked(spawnSync).mockImplementation(() => ({
      pid: 1,
      output: [],
      stdout: '',
      stderr: `Authority=Developer ID Application: ${expected.signingIdentity}\nTeamIdentifier=${expected.teamId}\n`,
      status: index++ === failedCommand ? 1 : 0,
      signal: null,
    }))
    if (failedCommand === undefined) {
      expect(() => { verifyMacOSNotarizedApplication(appPath, expected) }).not.toThrow()
    } else {
      expect(() => { verifyMacOSNotarizedApplication(appPath, expected) }).toThrow('exited with 1')
    }
    const calledCommands = commands.slice(0, failedCommand === undefined ? commands.length : failedCommand + 1)
    expect(spawnSync).toHaveBeenCalledTimes(calledCommands.length)
    for (const [index, [command, args]] of calledCommands.entries()) {
      expect(spawnSync).toHaveBeenNthCalledWith(index + 1, command, args, { encoding: 'utf8', ...index === 2 ? { timeout: 120_000 } : {} })
    }
  })

  it('retries a lost validation connection before allowing Gatekeeper assessment', () => {
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let validations = 0
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const interrupted = command === '/usr/bin/xcrun' && Array.isArray(args) && args[1] === 'validate' && validations++ < 2
      return { pid: 1, output: [], stdout: interrupted ? 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."' : '', stderr: `Authority=Developer ID Application: ${expected.signingIdentity}\nTeamIdentifier=${expected.teamId}\n`, status: interrupted ? 68 : 0, signal: null }
    })
    expect(() => { verifyMacOSNotarizedApplication(appPath, expected) }).not.toThrow()
    expect(validations).toBe(3)
    expect(wait.mock.calls.map(call => call[3])).toEqual([10_000, 30_000])
    expect(spawnSync).toHaveBeenLastCalledWith('/usr/sbin/spctl', commands[3][1], { encoding: 'utf8' })
  })

  it('bounds recovery when a transport code ends stdout without a newline before stderr', () => {
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(spawnSync).mockImplementation(command => ({ pid: 1, output: [], stdout: command === '/usr/bin/xcrun' ? 'Error Domain=NSURLErrorDomain Code=-1005' : '', stderr: `Authority=Developer ID Application: ${expected.signingIdentity}\nTeamIdentifier=${expected.teamId}\n`, status: command === '/usr/bin/xcrun' ? 68 : 0, signal: null }))
    expect(() => { verifyMacOSNotarizedApplication(appPath, expected) }).toThrow('stapler validate exited with 68')
    expect(wait.mock.calls.map(call => call[3])).toEqual([10_000, 30_000, 60_000, 120_000])
    expect(vi.mocked(spawnSync).mock.calls.some(call => call[0] === '/usr/sbin/spctl')).toBe(false)
  })

  it.each([
    { name: 'execution timeout', error: new Error('fixture timeout'), signal: null, status: null, message: 'could not execute stapler validate' },
    { name: 'termination with zero exit', error: undefined, signal: 'SIGTERM' as const, status: 0, message: 'terminated by SIGTERM' },
  ])('does not recover $name', ({ error, signal, status, message }) => {
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
    vi.mocked(spawnSync).mockImplementation(command => ({ pid: 1, output: [], stdout: '', stderr: `Authority=Developer ID Application: ${expected.signingIdentity}\nTeamIdentifier=${expected.teamId}\n`, status: command === '/usr/bin/xcrun' ? status : 0, signal: command === '/usr/bin/xcrun' ? signal : null, ...command === '/usr/bin/xcrun' && error !== undefined ? { error } : {} }))
    expect(() => { verifyMacOSNotarizedApplication(appPath, expected) }).toThrow(message)
    expect(wait).not.toHaveBeenCalled()
    expect(vi.mocked(spawnSync).mock.calls.some(call => call[0] === '/usr/sbin/spctl')).toBe(false)
  })

  it.each([
    ['ticket rejection', '/usr/bin/xcrun', 'ticket signature invalid'],
    ['signature tool connection error', '/usr/bin/codesign', 'Error Domain=NSURLErrorDomain Code=-1005'],
  ])('does not retry %s', (_name, failingTool, diagnostic) => {
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
    vi.mocked(spawnSync).mockImplementation(command => ({ pid: 1, output: [], stdout: command === failingTool ? diagnostic : '', stderr: `Authority=Developer ID Application: ${expected.signingIdentity}\nTeamIdentifier=${expected.teamId}\n`, status: command === failingTool ? 68 : 0, signal: null }))
    expect(() => { verifyMacOSNotarizedApplication(appPath, expected) }).toThrow('exited with 68')
    expect(wait).not.toHaveBeenCalled()
  })
})
