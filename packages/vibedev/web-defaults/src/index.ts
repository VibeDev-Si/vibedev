/**
 * VibeDev defaults over dsh-web-app. The patched rows live in
 * cordis.patch.yml; this module is also the one plugin the bundle inserts
 * itself (row `vibedev-web-runtime`).
 *
 * dsh-v0.2.1-alpha.2 replaced the `webRuntime` service with `webStartup`.
 * Plugins written for earlier releases inject `webRuntime` for the trusted
 * hosts and never load without it (the media viewer, Better Sidebar, the
 * VibeDev Ecosystem before 0.1.10). VibeDev Next keeps them working: this
 * plugin provides `webRuntime` exactly as dsh-v0.2.1-alpha.1 did, from the
 * bind host and the `--trusted-host` values the new service carries.
 *
 * @module @vibedev/dsh-web-defaults
 */
import { networkInterfaces } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'vibedev-web-runtime'

/** The bind host comes from the web server, the extra trusted hosts from the startup values. */
export const inject = ['webServer', 'webStartup']

/** What dsh-v0.2.1-alpha.1 provided as `webRuntime`. */
export interface WebRuntimeValues {
  /** Non-internal IPv4 addresses, when the server listens on every interface. */
  lanAddresses: string[]
  /** The LAN addresses, then each `--trusted-host` authority. */
  trustedHosts: string[]
}

const ALL_INTERFACES_HOST = '0.0.0.0'

/**
 * The trust values for a bind host, as dsh-v0.2.1-alpha.1 computed them.
 * @param bindHost - the address the web server listens on.
 * @param extra - explicit `--trusted-host` authorities.
 * @param interfaces - the machine's interfaces (injectable for tests).
 * @returns The `webRuntime` values.
 */
export function resolveLanTrust(
  bindHost: string, extra: readonly string[], interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): WebRuntimeValues {
  const lanAddresses = bindHost === ALL_INTERFACES_HOST
    ? Object.values(interfaces).flat()
      .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
      .map(iface => iface.address)
    : []
  return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] }
}

/**
 * Provide `webRuntime` for plugins written for dsh-v0.2.1-alpha.1 and earlier.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  const services = ctx as unknown as { webServer: { host: string }; webStartup: { trustedHosts?: readonly string[] } }
  ctx.provide('webRuntime', resolveLanTrust(services.webServer.host, services.webStartup.trustedHosts ?? []))
}
