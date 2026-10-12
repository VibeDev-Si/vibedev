/** Boots real host services and the packed account component through the production Loader. */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The account plugin version the defaults pin (the archive name in the immutable tarball URL). */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }
const pinned = /vibedev-si-dsh-vibedev-([0-9A-Za-z.-]+)\.tgz$/u.exec(manifest.dependencies['@vibedev-si/dsh-vibedev'] ?? '')?.[1]

describe('American production default real composition', () => {
  it('starts signed out without reading historical state and uses the new account for catalog, search and cancellable SSE', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/us-gateway-composition.mjs', import.meta.url))], { timeout: 30_000, windowsHide: true })
    const proof = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
    expect(pinned).toBeDefined()
    expect(proof).toMatchObject({
      ok: true, installedPlugin: pinned, loader: true, upgradedProfileUsesBuiltInPrimary: true, originIsolation: true,
      hiddenBeforeLogin: true, sseHeartbeatAndCancel: true, classifiedSignInFailure: true, callbackRedaction: true,
      noRedeemRetry: true, preservedLegacyAndOtherData: true, disposed: true,
    })
  }, 35_000)
})
