/** Which copy of an application-owned plugin a profile runs. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applicationCopyOf } from '../src/application-copy.ts'

const NAME = '@vibedev-si/dsh-ecosystem'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

/** An installation shipping 0.1.12 and an empty profile beside it. */
function layout(): { anchor: string; profile: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-application-copy-'))
  roots.push(root)
  const install = join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh')
  json(join(install, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.2.1', dependencies: { [NAME]: '0.1.12' } })
  json(join(install, 'node_modules', NAME, 'package.json'), { name: NAME, version: '0.1.12' })
  const profile = join(root, 'profiles', 'desktop')
  json(join(profile, 'package.json'), { name: 'dsh-profile-desktop', dependencies: {} })
  return { anchor: join(install, 'package.json'), profile }
}

function localCopy(profile: string, manifest: Record<string, unknown>, declared = true): void {
  json(join(profile, 'package.json'), { name: 'dsh-profile-desktop', dependencies: declared ? { [NAME]: String(manifest.version) } : {} })
  json(join(profile, 'node_modules', NAME, 'package.json'), manifest)
}

describe('applicationCopyOf', () => {
  it('runs the shipped copy when the profile holds none', () => {
    const { anchor, profile } = layout()
    expect(applicationCopyOf(NAME, anchor, profile)).toEqual({ name: NAME, shipped: '0.1.12', selected: 'installation' })
  })

  it('runs a strictly newer, compatible profile copy', () => {
    const { anchor, profile } = layout()
    localCopy(profile, { name: NAME, version: '0.1.13', peerDependencies: { '@deepseek-ai/dsh': '*' } })
    expect(applicationCopyOf(NAME, anchor, profile)).toEqual({ name: NAME, shipped: '0.1.12', local: '0.1.13', selected: 'profile' })
  })

  it('keeps the shipped copy over a copy left behind by an earlier installation, or the same version', () => {
    const { anchor, profile } = layout()
    localCopy(profile, { name: NAME, version: '0.1.8' })
    expect(applicationCopyOf(NAME, anchor, profile)).toMatchObject({ local: '0.1.8', selected: 'installation', reason: 'not-newer' })
    localCopy(profile, { name: NAME, version: '0.1.12' })
    expect(applicationCopyOf(NAME, anchor, profile)).toMatchObject({ selected: 'installation', reason: 'not-newer' })
  })

  it('keeps the shipped copy when the newer copy declares a dsh peer the runtime does not satisfy', () => {
    const { anchor, profile } = layout()
    localCopy(profile, { name: NAME, version: '0.9.0', peerDependencies: { '@deepseek-ai/dsh': '>=999.0.0' } })
    expect(applicationCopyOf(NAME, anchor, profile, {})).toMatchObject({ local: '0.9.0', selected: 'installation', reason: 'incompatible' })
  })

  it('ignores a copy the profile does not declare, and refuses one that is not the named package', () => {
    const { anchor, profile } = layout()
    localCopy(profile, { name: NAME, version: '0.9.0' }, false)
    expect(applicationCopyOf(NAME, anchor, profile)).toEqual({ name: NAME, shipped: '0.1.12', selected: 'installation' })
    localCopy(profile, { name: 'someone-else', version: '0.9.0' })
    expect(applicationCopyOf(NAME, anchor, profile)).toMatchObject({ selected: 'installation', reason: 'unreadable' })
    localCopy(profile, { name: NAME, version: 'latest' })
    expect(applicationCopyOf(NAME, anchor, profile)).toMatchObject({ selected: 'installation', reason: 'unreadable' })
  })
})
