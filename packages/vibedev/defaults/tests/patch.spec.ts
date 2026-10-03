/** The VibeDev defaults bundle stops DeepSeek data uploads and replaces the harness identity line. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const root = fileURLToPath(new URL('..', import.meta.url))
const basePatch = resolve(root, '../../bundle/base/cordis.patch.yml')
/** The dsh family version every packed member shares. */
const rootVersion = (JSON.parse(readFileSync(resolve(root, '../../../package.json'), 'utf8')) as { version: string }).version

interface Manifest {
  name?: string
  private?: boolean
  version?: string
  dsh?: { bundle?: { patch?: string } }
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
}

interface Row {
  id?: string
  name?: string
  config?: Record<string, unknown>
}

/** Rows anywhere in a parsed entry list, including inside insert lists. */
function rows(entries: unknown): Row[] {
  if (!Array.isArray(entries)) return []
  return entries.flatMap((entry: { insert?: unknown } & Row) => entry.insert === undefined ? [entry] : rows(entry.insert))
}

/** Top-level patch entries that change an existing row, as opposed to insert lists. */
function targeted(entries: unknown): Row[] {
  return Array.isArray(entries) ? entries.filter((entry: { insert?: unknown }) => entry.insert === undefined) as Row[] : []
}

/** Rows this patch adds through insert lists. */
function inserted(entries: unknown): Row[] {
  return Array.isArray(entries)
    ? entries.flatMap((entry: { insert?: unknown }) => entry.insert === undefined ? [] : rows(entry.insert))
    : []
}

const loadPatch = (path: string): unknown => yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })

describe('VibeDev defaults bundle', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest

  it('ships with the dsh family version and declares its patch', () => {
    expect(manifest.name).toBe('@vibedev/dsh-defaults')
    expect(manifest.private).toBeUndefined()
    expect(manifest.version).toBe(rootVersion)
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports?.['./cordis.patch.yml']).toBe('./cordis.patch.yml')
  })

  it('disables every DeepSeek upload and states the VibeDev identity', () => {
    expect(targeted(loadPatch(resolve(root, 'cordis.patch.yml'))).slice(0, 4)).toEqual([
      { id: 'session-log-deepseek', disabled: true },
      { id: 'plugin-package-inventory-deepseek', disabled: true },
      { id: 'session-telemetry-otel', disabled: true },
      { id: 'system-prompt', config: {
        includeHarnessIdentity: false,
        personaPrefix: 'You are an AI agent running in VibeDev.',
      } },
    ])
  })

  it('replaces the DeepSeek account and its models with the VibeDev account and gateway models', () => {
    const parsed = loadPatch(resolve(root, 'cordis.patch.yml'))
    expect(targeted(parsed).slice(4, 8)).toEqual([
      { id: 'deepseek-account', disabled: true },
      { id: 'llm-deepseek-account', disabled: true },
      { id: 'llm-deepseek', disabled: true },
      { id: 'agent-default-model', config: { provider: 'deepseek-account', model: 'deepseek-v4-flash' } },
    ])
    const upstream = rows(loadPatch(basePatch)).find(row => row.id === 'deepseek-account')
    expect(inserted(parsed).slice(0, 2)).toEqual([
      { id: 'vibedev-account', name: '@vibedev/dsh-account', config: { desktopPlatform: upstream?.config?.desktopPlatform } },
      { id: 'llm-vibedev-gateway', name: '@vibedev/dsh-llm-gateway' },
    ])
    expect(manifest.dependencies).toEqual({
      '@vibedev/dsh-account': 'workspace:*',
      '@vibedev/dsh-llm-gateway': 'workspace:*',
      '@vibedev/dsh-web-search-gateway': 'workspace:*',
    })
  })

  it('searches through the gateway instead of DeepSeek, keeping the upstream fetch provider', () => {
    const parsed = loadPatch(resolve(root, 'cordis.patch.yml'))
    const upstream = rows(loadPatch(basePatch)).find(row => row.id === 'web')?.config
    expect(targeted(parsed).slice(8)).toEqual([
      { id: 'web-search-deepseek', disabled: true },
      { id: 'web', config: { ...upstream, searchProvider: 'vibedev-gateway' } },
    ])
    expect(inserted(parsed).slice(2)).toEqual([{ id: 'web-search-vibedev', name: '@vibedev/dsh-web-search-gateway' }])
  })

  it('changes only rows that dsh-base defines and inserts only new ones, so no patch is dropped with a warning', () => {
    const defined = new Set(rows(loadPatch(basePatch)).map(row => row.id))
    const parsed = loadPatch(resolve(root, 'cordis.patch.yml'))
    expect(targeted(parsed).map(row => row.id).filter(id => !defined.has(id))).toEqual([])
    expect(inserted(parsed).map(row => row.id).filter(id => defined.has(id))).toEqual([])
  })
})
