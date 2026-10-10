/** The VibeDev Web defaults bundle removes DeepSeek analytics and brand, adds the VibeDev brand, and moves the default Web port. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const root = fileURLToPath(new URL('..', import.meta.url))
const webAppPatch = resolve(root, '../../bundle/web-app/cordis.patch.yml')
/** The dsh family version every packed member shares. */
const rootVersion = (JSON.parse(readFileSync(resolve(root, '../../../package.json'), 'utf8')) as { version: string }).version

interface Manifest {
  name?: string
  private?: boolean
  version?: string
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

interface Row {
  id?: string
  name?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: Row[]
}

/** Rows anywhere in a parsed entry list, including inside insert lists. */
function rows(entries: unknown): Row[] {
  if (!Array.isArray(entries)) return []
  return (entries as Row[]).flatMap(entry => entry.insert === undefined ? [entry] : rows(entry.insert))
}

function load(path: string): unknown {
  return yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
}

describe('VibeDev Web defaults bundle', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest
  const parsed = load(resolve(root, 'cordis.patch.yml')) as Row[]
  const targeted = parsed.filter(entry => entry.insert === undefined)
  const inserted = parsed.flatMap(entry => entry.insert ?? [])

  it('ships with the dsh family version and declares its patch', () => {
    expect(manifest.name).toBe('@vibedev/dsh-web-defaults')
    expect(manifest.private).toBeUndefined()
    expect(manifest.version).toBe(rootVersion)
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('disables DeepSeek analytics, the session-log upload toggle, and the official brand', () => {
    expect(targeted.filter(row => row.disabled === true).map(row => row.id)).toEqual([
      'desktop-product-telemetry', 'product-analytics', 'ui-settings-session-log', 'ui-brand-official',
    ])
  })

  it('inserts the VibeDev brand, the webRuntime compatibility row and the built-in VibeDev Ecosystem', () => {
    expect(inserted).toEqual([
      { id: 'vibedev-brand', name: '@vibedev/dsh-client-brand' },
      // This package itself: provides `webRuntime` for plugins written before dsh-v0.2.1-alpha.2.
      { id: 'vibedev-web-runtime', name: '@vibedev/dsh-web-defaults' },
      // Same row id as a user install, so the Desktop Host's installation copy replaces a profile copy.
      { id: 'vibedev-center', name: '@vibedev-si/dsh-ecosystem', config: { official: true } },
    ])
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@vibedev/dsh-client-brand', '@vibedev-si/dsh-ecosystem'])
  })

  it('pins the ecosystem exactly, at the version the CLI install anchor ships', () => {
    const cli = JSON.parse(readFileSync(resolve(root, '../../../apps/cli/package.json'), 'utf8')) as Manifest
    const pinned = manifest.dependencies?.['@vibedev-si/dsh-ecosystem']
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/)
    expect(cli.dependencies?.['@vibedev-si/dsh-ecosystem']).toBe(pinned)
  })

  it('restates the upstream webserver config (TLS included) with only the fallback port changed', () => {
    const upstream = rows(load(webAppPatch)).find(row => row.id === 'webserver')?.config
    const ours = targeted.find(row => row.id === 'webserver')?.config
    expect(ours).toEqual({ ...upstream, port: { __jsExpr: 'ctx.webStartup.port ?? 3180' } })
  })

  it('restates the web persona with the VibeDev identity and adds how VibeDev installs plugins', () => {
    const upstream = rows(load(webAppPatch)).find(row => row.id === 'system-prompt')?.config as { personaSuffix: string; personaPrefix: string }
    const ours = targeted.find(row => row.id === 'system-prompt')?.config as Record<string, string | boolean>
    expect(ours.includeHarnessIdentity).toBe(false)
    expect(ours.personaPrefix).toBe('You are a coding agent running in VibeDev, powered by the {{model}} model.')
    expect(upstream.personaPrefix).toContain('{{model}}')
    // Upstream has no persona suffix since dsh-v0.2.1-alpha.2 (the working_directory tool reports the
    // directory); if it grows one again, ours must lead with it.
    if (upstream.personaSuffix !== undefined) expect(String(ours.personaSuffix).startsWith(upstream.personaSuffix)).toBe(true)
    expect(ours.personaSuffix).toContain('vibedev-app plugin --profile desktop add <package>')
    expect(ours.personaSuffix).toContain('never run that for VibeDev')
    // Templates are strict: the only variables are the ones the system prompt defines ({{cwd}} is gone).
    expect([...(String(ours.personaPrefix) + String(ours.personaSuffix)).matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1])).toEqual(['model'])
  })

  it('makes the DeepSeek account the second account: a foot entry, without its product onboarding', () => {
    expect(targeted.find(row => row.id === 'ui-settings-account')).toEqual({
      id: 'ui-settings-account', config: { secondary: true, onboarding: false },
    })
  })

  it('only targets rows that dsh-web-app defines, so no patch is dropped with a warning', () => {
    const defined = new Set(rows(load(webAppPatch)).map(row => row.id))
    expect(targeted.map(row => row.id).filter(id => !defined.has(id))).toEqual([])
    expect(inserted.map(row => row.id).filter(id => defined.has(id))).toEqual([])
  })
})
