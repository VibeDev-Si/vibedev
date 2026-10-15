import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assertDesktopHostPackageFiles,
  assertPinnedDesktopAccountPackage,
  selectDesktopPackageClosure,
  type PackedDesktopPackage,
} from '../scripts/prepare-package-set.ts'

function packed(name: string, manifest: Record<string, unknown> = {}): PackedDesktopPackage {
  return { tarball: `${name}.tgz`, manifest: { name, version: '1.0.0', ...manifest } }
}

describe('desktop package-set selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not select a packaging target when imported as a library', async () => {
    vi.stubEnv('DSH_DESKTOP_TARGET_PLATFORM', 'linux')
    vi.stubEnv('DSH_DESKTOP_TARGET_ARCH', 'x64')
    vi.resetModules()
    await expect(import('../scripts/prepare-package-set.ts')).resolves.toHaveProperty('prepareDesktopPackageSet')
  })

  it('includes only the available internal production closure', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: { '@deepseek-ai/dsh-base': '^1.0.0', external: '^2.0.0' },
        optionalDependencies: { '@deepseek-ai/platform-package': '1.0.0', '@deepseek-ai/missing-platform': '1.0.0' },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', {
        dependencies: { '@deepseek-ai/dsh': '^1.0.0' },
      })],
      ['@deepseek-ai/dsh-base', packed('@deepseek-ai/dsh-base', {
        peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' },
      })],
      ['@deepseek-ai/cordis', packed('@deepseek-ai/cordis')],
      ['@deepseek-ai/platform-package', packed('@deepseek-ai/platform-package')],
      ['@deepseek-ai/unused', packed('@deepseek-ai/unused')],
    ])
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-desktop-host',
      '@deepseek-ai/platform-package',
    ])
  })

  it.each([
    '@deepseek-ai/dsh-base', '@deepseek-ai/cordis', '@deepseek-ai/node-addon-system',
  ])('rejects required prepared package %s absent from the packed release inputs', (dependency) => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: { [dependency]: '^1.0.0' },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', {
        dependencies: { '@deepseek-ai/dsh': '^1.0.0' },
      })],
    ])
    expect(() => selectDesktopPackageClosure(available)).toThrow(/unpacked package/u)
    expect(() => selectDesktopPackageClosure(new Map([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
    ]))).toThrow(/omit @deepseek-ai\/dsh-desktop-host/u)
  })

  it('leaves independently published Office packages to npm resolution', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: {
          '@deepseek-ai/libreoffice-kit': '0.0.1',
          '@deepseek-ai/libreoffice-kit-wasm': '0.0.1',
        },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
    ])
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host',
    ])
  })

  it('requires both Desktop Host and public CLI entries', () => {
    const files = [
      'package/lib/index.js',
      'package/lib/cli.js',
    ]
    expect(() => {
      assertDesktopHostPackageFiles(files)
    }).not.toThrow()
    expect(() => {
      assertDesktopHostPackageFiles(files.slice(1))
    }).toThrow(/lib\/index\.js/u)
    expect(() => { assertDesktopHostPackageFiles(files.slice(0, 1)) }).toThrow(/lib\/cli\.js/u)
  })

  it('requires the built-in account archive in the local production closure', () => {
    const available = new Map([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', { dependencies: { '@vibedev-si/dsh-vibedev': 'https://fixture.example/plugin.tgz' } })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
    ])
    expect(() => selectDesktopPackageClosure(available)).toThrow(/unpacked package/u)
    available.set('@vibedev-si/dsh-vibedev', packed('@vibedev-si/dsh-vibedev'))
    expect(selectDesktopPackageClosure(available).some(entry => entry.manifest.name === '@vibedev-si/dsh-vibedev')).toBe(true)
  })
})

describe('locked built-in account archive', () => {
  it('verifies the immutable pin, identity, version and complete archive bytes before packaging', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desktop-account-archive-'))
    try {
      const name = '@vibedev-si/dsh-vibedev'
      const version = '0.2.8-us.3'
      const spec = `https://raw.githubusercontent.com/VibeDev-Si/dsh-vibedev/${'a'.repeat(40)}/bundled/vibedev-si-dsh-vibedev-${version}.tgz`
      const tarball = join(dir, 'plugin.tgz')
      const bytes = Buffer.from('fixture archive bytes')
      writeFileSync(tarball, bytes)
      const available = new Map([[name, { tarball, manifest: { name, version } }]])
      const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
      const lock = JSON.stringify({ packages: { [`${name}@${spec}`]: { version, resolution: { tarball: spec, integrity } } } })
      expect(() => { assertPinnedDesktopAccountPackage(available, spec, lock) }).not.toThrow()
      expect(() => { assertPinnedDesktopAccountPackage(new Map(), spec, lock) }).toThrow(/missing/u)
      expect(() => { assertPinnedDesktopAccountPackage(available, spec.replace('a'.repeat(40), 'main'), lock) }).toThrow(/immutable/u)
      expect(() => { assertPinnedDesktopAccountPackage(available, spec, lock.replace(version, '0.2.0')) }).toThrow(/lockfile/u)
      available.get(name)!.manifest.version = '0.2.0'
      expect(() => { assertPinnedDesktopAccountPackage(available, spec, lock) }).toThrow(/identity/u)
      available.get(name)!.manifest.version = version
      writeFileSync(tarball, 'tampered fixture archive')
      expect(() => { assertPinnedDesktopAccountPackage(available, spec, lock) }).toThrow(/integrity/u)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
