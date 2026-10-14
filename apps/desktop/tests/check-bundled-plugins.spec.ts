import { describe, expect, it } from 'vitest'
import {
  bundledPluginPins,
  bundledPluginVerdict,
  compareVersions,
  formatBundledPluginVerdict,
  npmLatestUrl,
  pinnedVersion,
  type BundledPluginPin,
} from '../scripts/check-bundled-plugins.ts'

const ACCOUNT = '@vibedev-si/dsh-vibedev'
const ECOSYSTEM = '@vibedev-si/dsh-ecosystem'
const CLI = 'apps/cli/package.json'
const DEFAULTS = 'packages/vibedev/defaults/package.json'
const SHA = 'dca322d3772ba1ee14aabd44cdf7b84330b45023'

function archive(version: string): string {
  return `https://raw.githubusercontent.com/VibeDev-Si/dsh-vibedev/${SHA}/bundled/vibedev-si-dsh-vibedev-${version}.tgz`
}

function pin(manifest: string, specifier: string, name = ACCOUNT): BundledPluginPin {
  return { manifest, name, specifier }
}

describe('pinnedVersion', () => {
  it('reads an exact version pin as that version', () => {
    expect(pinnedVersion('0.1.15')).toBe('0.1.15')
    expect(pinnedVersion('1.0.0-rc.1')).toBe('1.0.0-rc.1')
  })

  it('reads the version from the archive name of a raw GitHub pin', () => {
    expect(pinnedVersion(archive('0.3.4'))).toBe('0.3.4')
    expect(pinnedVersion(archive('0.4.0-beta.2'))).toBe('0.4.0-beta.2')
  })

  it('refuses a range or any other form', () => {
    for (const specifier of [
      '^1.0.0', '~0.1.15', '>=0.1.15', '0.1', '*', 'latest', 'v0.1.15', 'workspace:*',
      'npm:@vibedev-si/dsh-ecosystem@0.1.15', 'github:VibeDev-Si/dsh-vibedev',
      'https://example.com/vibedev-si-dsh-vibedev-0.3.4.tgz',
      `http://raw.githubusercontent.com/VibeDev-Si/dsh-vibedev/${SHA}/bundled/vibedev-si-dsh-vibedev-0.3.4.tgz`,
      `https://raw.githubusercontent.com/VibeDev-Si/dsh-vibedev/${SHA}/bundled/plugin.tgz`,
    ]) {
      expect(() => pinnedVersion(specifier), specifier).toThrow('pin exactly')
    }
  })
})

describe('bundledPluginPins', () => {
  it('lists the @vibedev-si dependencies a manifest declares', () => {
    expect(bundledPluginPins(CLI, {
      dependencies: {
        '@vibedev/dsh-defaults': 'workspace:*', [ACCOUNT]: archive('0.3.4'), [ECOSYSTEM]: '0.1.15', commander: '^15.0.0',
      },
      devDependencies: { '@vibedev-si/dsh-other': '^1.0.0' },
    })).toEqual([pin(CLI, archive('0.3.4')), pin(CLI, '0.1.15', ECOSYSTEM)])
  })

  it('lists nothing for a manifest without dependencies', () => {
    expect(bundledPluginPins(DEFAULTS, { name: '@vibedev/dsh-defaults' })).toEqual([])
  })

  it('refuses a manifest whose dependencies are not a map of strings', () => {
    expect(() => bundledPluginPins(CLI, { dependencies: { [ACCOUNT]: 3 } })).toThrow(CLI)
    expect(() => bundledPluginPins(CLI, [])).toThrow(CLI)
  })
})

describe('compareVersions', () => {
  it('orders major, minor and patch numerically', () => {
    expect(compareVersions('0.3.3', '0.3.4')).toBeLessThan(0)
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareVersions('0.1.15', '0.1.15')).toBe(0)
  })

  it('orders prereleases by semver precedence, below their release', () => {
    const ordered = [
      '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0',
    ]
    expect([...ordered].reverse().sort(compareVersions)).toEqual(ordered)
  })

  it('ignores build metadata', () => {
    expect(compareVersions('1.0.0+build.7', '1.0.0')).toBe(0)
  })
})

describe('bundledPluginVerdict', () => {
  it('passes a plugin pinned to npm latest in every file', () => {
    expect(bundledPluginVerdict(ACCOUNT, [pin(CLI, archive('0.3.4')), pin(DEFAULTS, archive('0.3.4'))], { version: '0.3.4' }))
      .toEqual({ name: ACCOUNT, pinned: '0.3.4', latest: '0.3.4', ok: true, problems: [] })
  })

  it('fails a pin older than npm latest', () => {
    const verdict = bundledPluginVerdict(ECOSYSTEM, [pin(CLI, '0.1.14', ECOSYSTEM)], { version: '0.1.15' })
    expect(verdict.ok).toBe(false)
    expect(verdict.problems).toEqual(['0.1.14 is older than npm latest 0.1.15; bump the pin'])
  })

  it('fails a pin newer than npm latest, which npm does not serve', () => {
    const verdict = bundledPluginVerdict(ECOSYSTEM, [pin(CLI, '0.1.16', ECOSYSTEM)], { version: '0.1.15' })
    expect(verdict.ok).toBe(false)
    expect(verdict.problems).toEqual(['0.1.16 is newer than npm latest 0.1.15; publish it to npm first'])
  })

  it('fails a package pinned to different versions in different files', () => {
    const verdict = bundledPluginVerdict(ACCOUNT, [pin(CLI, archive('0.3.4')), pin(DEFAULTS, archive('0.3.3'))], { version: '0.3.4' })
    expect(verdict.ok).toBe(false)
    expect(verdict.pinned).toBe('0.3.3, 0.3.4')
    expect(verdict.problems).toContain(`pinned to different versions: 0.3.4 in ${CLI}, 0.3.3 in ${DEFAULTS}`)
  })

  it('fails a pin that is not exact', () => {
    const verdict = bundledPluginVerdict(ECOSYSTEM, [pin(CLI, '^0.1.15', ECOSYSTEM)], { version: '0.1.15' })
    expect(verdict.ok).toBe(false)
    expect(verdict.pinned).toBe('^0.1.15')
    expect(verdict.problems).toEqual([expect.stringMatching(new RegExp(`^${CLI}: .*pin exactly`))])
  })

  it('orders prerelease pins against npm latest by semver precedence', () => {
    expect(bundledPluginVerdict(ACCOUNT, [pin(CLI, archive('0.3.4-rc.1'))], { version: '0.3.4' }).problems)
      .toEqual(['0.3.4-rc.1 is older than npm latest 0.3.4; bump the pin'])
    expect(bundledPluginVerdict(ACCOUNT, [pin(CLI, archive('1.0.0-beta.11'))], { version: '1.0.0-beta.2' }).problems)
      .toEqual(['1.0.0-beta.11 is newer than npm latest 1.0.0-beta.2; publish it to npm first'])
    expect(bundledPluginVerdict(ACCOUNT, [pin(CLI, archive('1.0.0-beta.11'))], { version: '1.0.0-beta.11' }).ok).toBe(true)
  })

  it('fails when npm latest could not be read', () => {
    expect(bundledPluginVerdict(ECOSYSTEM, [pin(CLI, '0.1.15', ECOSYSTEM)], { error: 'fetch failed' })).toEqual({
      name: ECOSYSTEM, pinned: '0.1.15', latest: 'unavailable', ok: false, problems: ['cannot read npm latest: fetch failed'],
    })
  })

  it('fails when npm answers a latest that is not a semantic version', () => {
    expect(bundledPluginVerdict(ECOSYSTEM, [pin(CLI, '0.1.15', ECOSYSTEM)], { version: 'next' }).problems)
      .toEqual(['npm latest "next" is not a semantic version'])
  })
})

describe('formatBundledPluginVerdict', () => {
  it('prints the name, the pinned version, npm latest and the verdict on one line', () => {
    expect(formatBundledPluginVerdict({ name: ACCOUNT, pinned: '0.3.4', latest: '0.3.4', ok: true, problems: [] }))
      .toBe(`${ACCOUNT}  pinned 0.3.4  npm latest 0.3.4  OK`)
    expect(formatBundledPluginVerdict({
      name: ACCOUNT, pinned: '0.3.3', latest: '0.3.4', ok: false, problems: ['0.3.3 is older than npm latest 0.3.4; bump the pin'],
    })).toBe(`${ACCOUNT}  pinned 0.3.3  npm latest 0.3.4  FAIL: 0.3.3 is older than npm latest 0.3.4; bump the pin`)
  })
})

describe('npmLatestUrl', () => {
  it('asks the npm registry for the latest dist-tag of the encoded name', () => {
    expect(npmLatestUrl(ACCOUNT)).toBe('https://registry.npmjs.org/%40vibedev-si%2Fdsh-vibedev/latest')
  })
})
