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
}

interface Row {
  id?: string
}

/** Rows anywhere in a parsed entry list, including inside insert lists. */
function rows(entries: unknown): Row[] {
  if (!Array.isArray(entries)) return []
  return entries.flatMap((entry: { insert?: unknown } & Row) => entry.insert === undefined ? [entry] : rows(entry.insert))
}

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
    const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    expect(parsed).toEqual([
      { id: 'session-log-deepseek', disabled: true },
      { id: 'plugin-package-inventory-deepseek', disabled: true },
      { id: 'session-telemetry-otel', disabled: true },
      { id: 'system-prompt', config: {
        includeHarnessIdentity: false,
        personaPrefix: 'You are an AI agent running in VibeDev.',
      } },
    ])
  })

  it('only targets rows that dsh-base defines, so no patch is dropped with a warning', () => {
    const defined = new Set(rows(yaml.load(readFileSync(basePatch, 'utf8'), { schema: entryListSchema })).map(row => row.id))
    const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    expect(rows(parsed).map(row => row.id).filter(id => !defined.has(id))).toEqual([])
  })
})
