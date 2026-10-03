import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importDshSessions } from '../src/vibedev-dsh-import.ts'

const NOW = Date.parse('2026-10-03T12:00:00.000Z')
const CREATED = '2026-10-01T00:00:00.000Z'
const NOTHING = { copied: 0, workspaces: 0, deferred: 0, attachmentFailures: 0 }

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function homes() {
  const root = mkdtempSync(join(tmpdir(), 'vibedev-dsh-import-'))
  roots.push(root)
  return { from: join(root, 'dsh'), to: join(root, 'vibedev'), a: join(root, 'work', 'a'), b: join(root, 'work', 'b') }
}

function writeSession(home: string, project: string, dir: string, options: { writtenAt?: number; files?: Record<string, string> } = {}) {
  const directory = join(home, 'sessions', project, dir)
  mkdirSync(directory, { recursive: true })
  const at = (options.writtenAt ?? NOW - 60 * 60_000) / 1000
  for (const [name, content] of Object.entries(options.files ?? { 'session.v4.jsonl.zstd': `log of ${dir}` })) {
    writeFileSync(join(directory, name), content)
    utimesSync(join(directory, name), at, at)
  }
  utimesSync(directory, at, at)
}

function writeStore(home: string, rows: Record<string, { path: string; title?: string; sessionIds: string[] }>, global: object = {}) {
  const workspaces = Object.fromEntries(Object.entries(rows).map(([id, row]) =>
    [id, { path: row.path, title: row.title ?? id, sessionIds: row.sessionIds, createdAt: CREATED, updatedAt: CREATED }]))
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: Object.keys(rows), archivedSessionIds: [], pinnedSessionIds: [], ...global },
    tables: { workspaces },
  }))
}

interface StoredWorkspaces {
  global: Record<string, unknown>
  tables: { workspaces: Record<string, { path: string; title: string; sessionIds: string[]; updatedAt: string }> }
}

function readStore(home: string): StoredWorkspaces {
  return JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8')) as StoredWorkspaces
}

function sessionDirs(home: string): string[] {
  const root = join(home, 'sessions')
  return readdirSync(root).flatMap(project => readdirSync(join(root, project)).map(dir => `${project}/${dir}`)).sort()
}

/** Every file below `root` with its bytes and modification time. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else files[relative(root, path)] = `${readFileSync(path, 'base64')}@${statSync(path).mtimeMs}`
    }
  }
  walk(root)
  return files
}

const run = (h: ReturnType<typeof homes>, now = NOW) => importDshSessions({ from: h.from, to: h.to, now: () => now })

describe('DeepSeek Harness session import', () => {
  it('copies the whole history into a fresh VibeDev home and only reads DeepSeek Harness', async () => {
    const h = homes()
    writeSession(h.from, '--a--', 'session-1')
    writeSession(h.from, '--a--', 'child-1')
    writeSession(h.from, '--b--', 'session-2', { files: { 'session.v4.jsonl.zstd': 'log', 'session.lock': '' } })
    writeStore(h.from, {
      wa: { path: h.a, title: 'Project A', sessionIds: ['session-1'] },
      wb: { path: h.b, sessionIds: ['session-2'] },
    }, { defaultWorkspaceId: 'wb', archivedSessionIds: ['session-2'], pinnedSessionIds: ['session-1'] })
    const image = join(h.from, 'attachments', 'v1', 'objects', 'ab', 'ab12')
    mkdirSync(dirname(image), { recursive: true })
    writeFileSync(image, 'png')
    mkdirSync(join(h.from, 'attachments', 'v1', 'tmp'))
    writeFileSync(join(h.from, 'attachments', 'v1', 'tmp', 'partial'), 'half')
    const checkpoints = join(h.from, 'storages', 'session_projcache', 'sessions')
    mkdirSync(checkpoints, { recursive: true })
    writeFileSync(join(checkpoints, 'session-1.json'), '{"version":7,"record":{"rows":{"title":{"val":"Hello"}}}}\n')
    const before = snapshot(h.from)

    expect(await run(h)).toEqual({ copied: 3, workspaces: 2, deferred: 0, attachmentFailures: 0 })

    expect(snapshot(h.from)).toEqual(before)
    expect(sessionDirs(h.to)).toEqual(['--a--/child-1', '--a--/session-1', '--b--/session-2'])
    expect(readdirSync(join(h.to, 'sessions', '--b--', 'session-2'))).toEqual(['session.v4.jsonl.zstd'])
    expect(readFileSync(join(h.to, 'sessions', '--a--', 'session-1', 'session.v4.jsonl.zstd'), 'utf8')).toBe('log of session-1')
    expect(readFileSync(join(h.to, 'attachments', 'v1', 'objects', 'ab', 'ab12'), 'utf8')).toBe('png')
    expect(existsSync(join(h.to, 'attachments', 'v1', 'tmp'))).toBe(false)
    expect(readdirSync(join(h.to, 'storages', 'session_projcache', 'sessions'))).toEqual(['session-1.json'])
    expect(readFileSync(join(h.to, 'storages', 'session_projcache', 'sessions', 'session-1.json'), 'utf8'))
      .toBe(readFileSync(join(checkpoints, 'session-1.json'), 'utf8'))
    const store = readStore(h.to)
    expect(store.global).toEqual({
      initialized: true, defaultWorkspaceId: 'wb', workspaceIds: ['wa', 'wb'],
      archivedSessionIds: ['session-2'], pinnedSessionIds: ['session-1'],
    })
    expect(store.tables.workspaces.wa).toEqual({ path: h.a, title: 'Project A', sessionIds: ['session-1'], createdAt: CREATED, updatedAt: CREATED })
    expect(readdirSync(h.to).sort()).toEqual(['attachments', 'sessions', 'storages'])
  })

  it('files sessions under the VibeDev workspace for the same folder and adds the other workspaces', async () => {
    const h = homes()
    writeSession(h.to, '--a--', 'session-own')
    writeStore(h.to, { mine: { path: h.a, title: 'Mine', sessionIds: ['session-own'] } },
      { defaultWorkspaceId: 'mine', pinnedSessionIds: ['session-own'] })
    writeSession(h.from, '--a--', 'session-1')
    writeSession(h.from, '--b--', 'session-2')
    writeStore(h.from, {
      wa: { path: h.a, sessionIds: ['session-1'] },
      wb: { path: h.b, title: 'Mine', sessionIds: ['session-2'] },
    }, { archivedSessionIds: ['session-1'], pinnedSessionIds: ['session-2'] })

    expect(await run(h)).toEqual({ copied: 2, workspaces: 1, deferred: 0, attachmentFailures: 0 })

    const store = readStore(h.to)
    expect(store.global).toEqual({
      initialized: true, defaultWorkspaceId: 'mine', workspaceIds: ['mine', 'wb'],
      archivedSessionIds: ['session-1'], pinnedSessionIds: ['session-own', 'session-2'],
    })
    expect(store.tables.workspaces.mine).toEqual({
      path: h.a, title: 'Mine', sessionIds: ['session-own', 'session-1'], createdAt: CREATED, updatedAt: new Date(NOW).toISOString(),
    })
    expect(store.tables.workspaces.wb).toEqual({
      path: h.b, title: 'Mine (DeepSeek Harness)', sessionIds: ['session-2'], createdAt: CREATED, updatedAt: CREATED,
    })
  })

  it('brings later sessions on a later start, keeps sessions deleted in VibeDev deleted, and idles without writes', async () => {
    const h = homes()
    writeSession(h.from, '--a--', 'session-1')
    writeSession(h.from, '--a--', 'session-2')
    writeStore(h.from, { wa: { path: h.a, sessionIds: ['session-1', 'session-2'] } })
    await run(h)
    rmSync(join(h.to, 'sessions', '--a--', 'session-2'), { recursive: true })
    writeStore(h.to, { wa: { path: h.a, sessionIds: ['session-1'] } })
    writeSession(h.from, '--a--', 'session-3')
    writeStore(h.from, { wa: { path: h.a, sessionIds: ['session-3', 'session-1', 'session-2'] } })

    expect(await run(h)).toEqual({ copied: 1, workspaces: 0, deferred: 0, attachmentFailures: 0 })
    expect(sessionDirs(h.to)).toEqual(['--a--/session-1', '--a--/session-3'])
    expect(readStore(h.to).tables.workspaces.wa?.sessionIds).toEqual(['session-1', 'session-3'])

    const settled = snapshot(h.to)
    expect(await run(h)).toEqual(NOTHING)
    expect(snapshot(h.to)).toEqual(settled)
    expect(readdirSync(h.to).sort()).toEqual(['sessions', 'storages'])
  })

  it('waits for a later start while DeepSeek Harness may still be writing a session', async () => {
    const h = homes()
    writeSession(h.from, '--a--', 'session-1', { writtenAt: NOW - 30_000 })
    writeStore(h.from, { wa: { path: h.a, sessionIds: ['session-1'] } })

    expect(await run(h)).toEqual({ ...NOTHING, deferred: 1 })
    expect(existsSync(join(h.to, 'sessions'))).toBe(false)
    expect(existsSync(join(h.to, 'storages'))).toBe(false)

    expect(await run(h, NOW + 5 * 60_000)).toEqual({ copied: 1, workspaces: 1, deferred: 0, attachmentFailures: 0 })
    expect(readStore(h.to).tables.workspaces.wa?.sessionIds).toEqual(['session-1'])
  })

  it('leaves a VibeDev store it does not recognize, or one with a mutation to recover, untouched', async () => {
    for (const store of [
      { unit: { name: 'workspace', version: 3 }, global: {}, tables: {} },
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: [], pendingMutation: { operation: 'create', workspaceId: 'w' } },
        tables: { workspaces: {} },
      },
    ]) {
      const h = homes()
      writeSession(h.from, '--a--', 'session-1')
      writeStore(h.from, { wa: { path: h.a, sessionIds: ['session-1'] } })
      mkdirSync(join(h.to, 'storages'), { recursive: true })
      writeFileSync(join(h.to, 'storages', 'workspace.json'), JSON.stringify(store))
      const before = snapshot(h.to)

      const result = await run(h)

      expect(result).toMatchObject(NOTHING)
      expect(result.skipped).toMatch(/VibeDev workspace store/)
      expect(snapshot(h.to)).toEqual(before)
    }
  })

  it('never copies a session the VibeDev home already holds, nor a plaintext session log', async () => {
    const h = homes()
    writeSession(h.to, '--elsewhere--', 'session-1')
    writeStore(h.to, { mine: { path: h.a, sessionIds: ['session-1'] } })
    writeSession(h.from, '--a--', 'session-1')
    writeSession(h.from, '--a--', 'session-2', { files: { 'session.v4.jsonl': 'plain' } })
    writeStore(h.from, { wa: { path: h.a, sessionIds: ['session-1', 'session-2'] } })
    const store = readFileSync(join(h.to, 'storages', 'workspace.json'), 'utf8')

    expect(await run(h)).toEqual(NOTHING)
    expect(sessionDirs(h.to)).toEqual(['--elsewhere--/session-1'])
    expect(readFileSync(join(h.to, 'storages', 'workspace.json'), 'utf8')).toBe(store)
  })

  it('files a session an interrupted start copied before recording it', async () => {
    const h = homes()
    writeSession(h.from, '--a--', 'session-1')
    writeStore(h.from, { wa: { path: h.a, sessionIds: ['session-1'] } })
    writeSession(h.to, '--a--', 'session-1')
    writeStore(h.to, {})

    expect(await run(h)).toEqual({ copied: 0, workspaces: 1, deferred: 0, attachmentFailures: 0 })
    expect(readStore(h.to).tables.workspaces.wa?.sessionIds).toEqual(['session-1'])
  })

  it('finds a session by the escaped directory name its id is stored under', async () => {
    const h = homes()
    writeSession(h.from, '--a--', 'session~003A1')
    writeStore(h.from, { wa: { path: h.a, sessionIds: ['session:1'] } })
    writeStore(h.to, {})

    expect(await run(h)).toEqual({ copied: 1, workspaces: 1, deferred: 0, attachmentFailures: 0 })
    expect(readStore(h.to).tables.workspaces.wa?.sessionIds).toEqual(['session:1'])
  })

  it('does nothing without a DeepSeek Harness home, or when both homes are one', async () => {
    const h = homes()
    expect(await run(h)).toEqual(NOTHING)
    writeSession(h.from, '--a--', 'session-1')
    writeStore(h.from, { wa: { path: h.a, sessionIds: ['session-1'] } })
    expect(await importDshSessions({ from: h.from, to: join(h.from, '.'), now: () => NOW })).toEqual(NOTHING)
    expect(existsSync(h.to)).toBe(false)
  })
})
