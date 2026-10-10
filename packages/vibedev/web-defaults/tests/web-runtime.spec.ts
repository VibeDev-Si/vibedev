/** The `webRuntime` compatibility plugin gives plugins written before dsh-v0.2.1-alpha.2 the service they inject. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name, resolveLanTrust } from '../src/index.ts'

const interfaces = {
  loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  ethernet: [{ address: '192.168.1.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
} as unknown as Parameters<typeof resolveLanTrust>[2]

describe('webRuntime compatibility', () => {
  it('waits for the web server and the startup values', () => {
    expect(name).toBe('vibedev-web-runtime')
    expect(inject).toEqual(['webServer', 'webStartup'])
  })

  it('trusts only the explicit hosts on a loopback bind, as dsh-v0.2.1-alpha.1 did', () => {
    expect(resolveLanTrust('127.0.0.1', ['app.internal'], interfaces)).toEqual({ lanAddresses: [], trustedHosts: ['app.internal'] })
  })

  it('adds the LAN IPv4 addresses first when the server listens on every interface', () => {
    expect(resolveLanTrust('0.0.0.0', ['app.internal'], interfaces)).toEqual({
      lanAddresses: ['192.168.1.20'], trustedHosts: ['192.168.1.20', 'app.internal'],
    })
  })

  it('provides webRuntime from the bound web server and the --trusted-host values', () => {
    const provided: Record<string, unknown> = {}
    const ctx = {
      webServer: { host: '127.0.0.1' },
      webStartup: { trustedHosts: ['tv.local:3180'] },
      provide: (key: string, value: unknown) => { provided[key] = value },
    } as unknown as Context
    apply(ctx)
    expect(provided.webRuntime).toEqual({ lanAddresses: [], trustedHosts: ['tv.local:3180'] })
  })
})
