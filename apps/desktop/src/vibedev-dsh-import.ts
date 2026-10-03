/**
 * VibeDev fork: bring sessions over from an installed DeepSeek Harness, so
 * people who switch keep their history.
 *
 * Desktop runs this while preparing each Host start, when no Host holds the
 * VibeDev home. It copies the session directories the VibeDev home lacks, with
 * the attachments they may reference and the projection checkpoints the session
 * list reads titles from, and files them into VibeDev's workspace store. The
 * DeepSeek Harness home is only read. A ledger in the VibeDev home
 * remembers every copied directory, so a session deleted in VibeDev stays
 * deleted, and sessions DeepSeek Harness writes later arrive on a later start.
 * A session written in the last few minutes may still be open in DeepSeek
 * Harness and waits for a later start.
 *
 * The layouts are those of `@deepseek-ai/dsh-session-persistence-jsonl`
 * (`sessions/<project>/<session>/`, Zstandard logs), `@deepseek-ai/dsh-attachment-local`
 * (`attachments/v1/`), `@deepseek-ai/dsh-session-projection-cache`
 * (`storages/session_projcache/sessions/<id>.json`), and `@deepseek-ai/dsh-workspace`
 * (`storages/workspace.json`, unit version 2). A workspace store or ledger this module does not recognize,
 * or a store in the middle of a mutation, means nothing is imported that start.
 */

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const LEDGER_FILE = 'vibedev-dsh-import.json'
const STAGING_DIR = '.vibedev-dsh-import'
/** The session persistence lease file; a copy would only be a stale lock. */
const LEASE_FILE = 'session.lock'
const DEFAULT_ACTIVE_WINDOW_MS = 3 * 60_000

type Json = Record<string, unknown>

interface WorkspaceRecord {
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

interface WorkspaceGlobal {
  initialized: boolean
  defaultWorkspaceId?: unknown
  workspaceIds: string[]
  archivedSessionIds?: string[]
  pinnedSessionIds?: string[]
  pendingMutation?: unknown
}

interface WorkspaceStore {
  /** The parsed document; `global` and `workspaces` are views into it, so edits to them are written back. */
  readonly document: Json
  readonly global: WorkspaceGlobal
  readonly workspaces: Record<string, WorkspaceRecord>
}

type StoreRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'store'; readonly store: WorkspaceStore }

interface Ledger {
  version: 1
  /** Copied session directory names. */
  sessions: string[]
  /** Set while an attachment failed to copy, so the next start tries again. */
  retryAttachments?: true
}

/** What one import did. */
export interface DshImportResult {
  /** Session directories copied. */
  readonly copied: number
  /** Workspaces added to the VibeDev store. */
  readonly workspaces: number
  /** Session directories left for a later start: possibly still open in DeepSeek Harness, or not copyable now. */
  readonly deferred: number
  /** Attachment files that could not be copied; the next start tries again. */
  readonly attachmentFailures: number
  /** Why nothing was imported although DeepSeek Harness has a workspace store. */
  readonly skipped?: string
}

/** Where to import from and to, plus test seams. */
export interface DshImportOptions {
  /** The DeepSeek Harness home, usually `~/.dsh`. */
  readonly from: string
  /** The VibeDev home. */
  readonly to: string
  /** Clock for the active-session window. */
  readonly now?: () => number
  /** A session directory written within this window is deferred. */
  readonly activeWindowMs?: number
}

const NOTHING: DshImportResult = { copied: 0, workspaces: 0, deferred: 0, attachmentFailures: 0 }

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** The session persistence directory name for a session id (`encodeSegment` in its format module). */
function sessionDirName(id: string): string {
  if (id === '.') return '~002E'
  if (id === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < id.length; i++) {
    const unit = id.charAt(i)
    out += /^[A-Za-z0-9._-]$/.test(unit) ? unit : `~${id.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

function parseStore(text: string): WorkspaceStore | undefined {
  let document: unknown
  try { document = JSON.parse(text) } catch { return undefined }
  if (!isJson(document) || !isJson(document.unit) || !isJson(document.global) || !isJson(document.tables)) return undefined
  if (document.unit.name !== 'workspace' || document.unit.version !== 2) return undefined
  const global = document.global
  if (typeof global.initialized !== 'boolean' || !isStrings(global.workspaceIds)) return undefined
  for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
    if (global[key] !== undefined && !isStrings(global[key])) return undefined
  }
  document.tables.workspaces ??= {}
  const workspaces = document.tables.workspaces
  if (!isJson(workspaces)) return undefined
  for (const record of Object.values(workspaces)) {
    if (!isJson(record) || typeof record.path !== 'string' || typeof record.title !== 'string' || !isStrings(record.sessionIds)
      || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') return undefined
  }
  return {
    document,
    global: global as unknown as WorkspaceGlobal,
    workspaces: workspaces as unknown as Record<string, WorkspaceRecord>,
  }
}

async function readStore(path: string): Promise<StoreRead> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'invalid' }
  }
  const store = parseStore(text)
  return store === undefined ? { kind: 'invalid' } : { kind: 'store', store }
}

async function readLedger(path: string): Promise<Ledger | undefined> {
  let raw: unknown
  try { raw = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    return isMissing(error) ? { version: 1, sessions: [] } : undefined
  }
  if (!isJson(raw) || raw.version !== 1 || !isStrings(raw.sessions)) return undefined
  return { version: 1, sessions: raw.sessions, ...raw.retryAttachments === true ? { retryAttachments: true } : {} }
}

/** Write through a sibling temporary file and rename it over the target, as the JSON storage backend does. */
async function writeText(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * A session's projection checkpoint document. The session list takes titles only from these, so a
 * copied session without one would read as untitled until first opened. The checkpoint is bound to
 * the log header, not the file, so it stays valid for the copy; reading it before the log is copied
 * keeps it from leading the copied log. Only path-safe ids have a checkpoint document, and for
 * those the directory name is the id.
 */
function checkpointPath(home: string, dir: string): string | undefined {
  return /^[a-zA-Z0-9_-]+$/.test(dir) ? join(home, 'storages', 'session_projcache', 'sessions', `${dir}.json`) : undefined
}

async function copyCheckpoint(to: string, dir: string, document: string): Promise<void> {
  const target = checkpointPath(to, dir)
  if (target === undefined) return
  try {
    if (await exists(target)) return
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeText(target, document)
  } catch {
    // Without a checkpoint the title appears once the session is first opened.
  }
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch { return [] }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

async function canonical(path: string): Promise<string> {
  const resolved = await realpath(path).catch(() => resolve(path))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Whether a session directory holds Zstandard logs only (a plaintext generation would make the
 * VibeDev session store refuse its whole root), and when anything in it was last written.
 */
async function inspectSession(directory: string): Promise<{ readonly importable: boolean; readonly lastWrite: number }> {
  let zstd = false
  let plain = false
  let lastWrite = (await stat(directory)).mtimeMs
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.endsWith('.jsonl.zstd')) zstd = true
    else if (entry.name.endsWith('.jsonl')) plain = true
    const info = await stat(join(directory, entry.name)).catch(() => undefined)
    if (info !== undefined && info.mtimeMs > lastWrite) lastWrite = info.mtimeMs
  }
  return { importable: zstd && !plain, lastWrite }
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === LEASE_FILE) continue
    if (entry.isDirectory()) await copyTree(join(from, entry.name), join(to, entry.name))
    else if (entry.isFile()) await copyFile(join(from, entry.name), join(to, entry.name), constants.COPYFILE_EXCL)
  }
}

/**
 * Copy the files the target tree lacks. Attachments are content-addressed and immutable, so a file
 * already at its path holds the same bytes.
 * @returns how many files could not be copied.
 */
async function copyMissingFiles(from: string, to: string, staging: string, skip: ReadonlySet<string> = new Set()): Promise<number> {
  let entries
  try { entries = await readdir(from, { withFileTypes: true }) } catch { return 0 }
  let failures = 0
  for (const entry of entries) {
    if (skip.has(entry.name)) continue
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      failures += await copyMissingFiles(source, target, staging)
      continue
    }
    if (!entry.isFile() || await exists(target)) continue
    const stage = join(staging, randomUUID())
    try {
      await copyFile(source, stage, constants.COPYFILE_EXCL)
      await mkdir(to, { recursive: true, mode: 0o700 })
      await rename(stage, target)
    } catch {
      await rm(stage, { force: true })
      failures++
    }
  }
  return failures
}

/** The DeepSeek Harness store as a fresh VibeDev store, keeping only rows the registry order names. */
function copiedStore(source: WorkspaceStore): { readonly document: Json; readonly workspaces: number } {
  const workspaces: Record<string, WorkspaceRecord> = {}
  const workspaceIds: string[] = []
  const paths = new Set<string>()
  const accounted = new Set<string>()
  for (const id of source.global.workspaceIds) {
    const record = source.workspaces[id]
    if (record === undefined || workspaces[id] !== undefined || paths.has(record.path)) continue
    const sessionIds = [...new Set(record.sessionIds)].filter(sessionId => !accounted.has(sessionId))
    for (const sessionId of sessionIds) accounted.add(sessionId)
    paths.add(record.path)
    workspaces[id] = { path: record.path, title: record.title, sessionIds, createdAt: record.createdAt, updatedAt: record.updatedAt }
    workspaceIds.push(id)
  }
  const archivedSessionIds = [...new Set(source.global.archivedSessionIds ?? [])]
  const pinnedSessionIds = [...new Set(source.global.pinnedSessionIds ?? [])].filter(id => !archivedSessionIds.includes(id))
  const defaultWorkspaceId = source.global.defaultWorkspaceId
  return {
    document: {
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        ...typeof defaultWorkspaceId === 'string' ? { defaultWorkspaceId } : {},
        workspaceIds,
        archivedSessionIds,
        pinnedSessionIds,
      },
      tables: { workspaces },
    },
    workspaces: workspaceIds.length,
  }
}

/**
 * File imported sessions into an existing VibeDev store: into the workspace for the same folder,
 * or a new workspace appended to the registry order. Sessions the store already accounts stay put.
 * A new workspace whose title a VibeDev workspace already uses, such as both apps'
 * `default-workspace`, is told apart by a suffix.
 * @returns how many workspaces were added and whether the store changed.
 */
function mergeStore(
  target: WorkspaceStore,
  source: WorkspaceStore,
  imported: ReadonlySet<string>,
  stamp: string,
): { readonly workspaces: number; readonly changed: boolean } {
  const byPath = new Map(Object.entries(target.workspaces).map(([id, record]) => [record.path, id]))
  const titles = new Set(Object.values(target.workspaces).map(record => record.title))
  const accounted = new Set(Object.values(target.workspaces).flatMap(record => record.sessionIds))
  let workspaces = 0
  let changed = false
  for (const sourceId of source.global.workspaceIds) {
    const record = source.workspaces[sourceId]
    if (record === undefined) continue
    const sessionIds = [...new Set(record.sessionIds)]
      .filter(id => imported.has(sessionDirName(id)) && !accounted.has(id))
    if (sessionIds.length === 0) continue
    let targetId = byPath.get(record.path)
    let row = targetId === undefined ? undefined : target.workspaces[targetId]
    if (row === undefined) {
      targetId = target.workspaces[sourceId] === undefined && !target.global.workspaceIds.includes(sourceId) ? sourceId : randomUUID()
      const title = titles.has(record.title) ? `${record.title} (DeepSeek Harness)` : record.title
      row = { path: record.path, title, sessionIds: [], createdAt: record.createdAt, updatedAt: record.updatedAt }
      target.workspaces[targetId] = row
      target.global.workspaceIds.push(targetId)
      byPath.set(record.path, targetId)
      workspaces++
    } else {
      row.updatedAt = stamp
    }
    row.sessionIds.push(...sessionIds)
    for (const id of sessionIds) accounted.add(id)
    changed = true
  }
  target.global.archivedSessionIds ??= []
  target.global.pinnedSessionIds ??= []
  const archived = target.global.archivedSessionIds
  const pinned = target.global.pinnedSessionIds
  for (const id of source.global.archivedSessionIds ?? []) {
    if (!imported.has(sessionDirName(id)) || archived.includes(id) || pinned.includes(id)) continue
    archived.push(id)
    changed = true
  }
  for (const id of source.global.pinnedSessionIds ?? []) {
    if (!imported.has(sessionDirName(id)) || archived.includes(id) || pinned.includes(id)) continue
    pinned.push(id)
    changed = true
  }
  return { workspaces, changed }
}

/**
 * Import the sessions an installed DeepSeek Harness has that the VibeDev home lacks.
 * @param options - the two homes, plus test seams for the clock and the active-session window.
 * @returns what was copied, added, and left for a later start.
 */
export async function importDshSessions(options: DshImportOptions): Promise<DshImportResult> {
  const from = resolve(options.from)
  const to = resolve(options.to)
  if (await canonical(from) === await canonical(to)) return NOTHING
  const sourceRead = await readStore(join(from, 'storages', 'workspace.json'))
  if (sourceRead.kind === 'missing') return NOTHING
  if (sourceRead.kind === 'invalid' || !sourceRead.store.global.initialized) {
    return { ...NOTHING, skipped: 'the DeepSeek Harness workspace store is not one this version reads' }
  }
  const source = sourceRead.store
  const storePath = join(to, 'storages', 'workspace.json')
  const targetRead = await readStore(storePath)
  if (targetRead.kind === 'invalid') return { ...NOTHING, skipped: 'the VibeDev workspace store is not one this version reads' }
  if (targetRead.kind === 'store' && targetRead.store.global.pendingMutation !== undefined) {
    return { ...NOTHING, skipped: 'the VibeDev workspace store has a mutation to recover first' }
  }
  const ledgerPath = join(to, 'storages', LEDGER_FILE)
  const ledger = await readLedger(ledgerPath)
  if (ledger === undefined) return { ...NOTHING, skipped: `${LEDGER_FILE} is not readable` }
  const now = options.now?.() ?? Date.now()
  const activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS
  const recorded = new Set(ledger.sessions)

  // Session ids are unique across project directories in one home: the session store refuses to list a
  // root where an id appears twice, so a session already anywhere in the VibeDev home is never copied.
  const present = new Set<string>()
  for (const project of await directories(join(to, 'sessions'))) {
    for (const dir of await directories(join(to, 'sessions', project))) present.add(dir)
  }
  // Every directory is a candidate, filed or not: subagent sessions are reached through their parent.
  const candidates: Array<{ readonly project: string; readonly dir: string }> = []
  const imported = new Set<string>()
  for (const project of await directories(join(from, 'sessions'))) {
    for (const dir of await directories(join(from, 'sessions', project))) {
      // A present directory nobody recorded was copied by an earlier start that stopped before recording it.
      if (present.has(dir)) {
        if (!recorded.has(dir)) imported.add(dir)
      } else if (!recorded.has(dir)) {
        candidates.push({ project, dir })
      }
    }
  }
  const staging = join(to, STAGING_DIR)
  // Leftovers of an interrupted start.
  await rm(staging, { recursive: true, force: true })
  if (candidates.length === 0 && imported.size === 0 && ledger.retryAttachments !== true) return NOTHING

  await mkdir(staging, { recursive: true, mode: 0o700 })
  try {
    let copied = 0
    let deferred = 0
    for (const { project, dir } of candidates) {
      const origin = join(from, 'sessions', project, dir)
      const stage = join(staging, randomUUID())
      const checkpointSource = checkpointPath(from, dir)
      let checkpoint: string | undefined
      try {
        const session = await inspectSession(origin)
        if (!session.importable) continue
        if (now - session.lastWrite < activeWindowMs) {
          deferred++
          continue
        }
        if (checkpointSource !== undefined) checkpoint = await readFile(checkpointSource, 'utf8').catch(() => undefined)
        await copyTree(origin, stage)
        await mkdir(join(to, 'sessions', project), { recursive: true, mode: 0o700 })
        await rename(stage, join(to, 'sessions', project, dir))
      } catch {
        await rm(stage, { recursive: true, force: true })
        deferred++
        continue
      }
      imported.add(dir)
      copied++
      if (checkpoint !== undefined) await copyCheckpoint(to, dir, checkpoint)
    }

    let attachmentFailures = 0
    if (imported.size > 0 || ledger.retryAttachments === true) {
      attachmentFailures = await copyMissingFiles(join(from, 'attachments', 'v1'), join(to, 'attachments', 'v1'), staging,
        new Set(['tmp']))
    }

    let workspaces = 0
    if (imported.size > 0) {
      await mkdir(join(to, 'storages'), { recursive: true, mode: 0o700 })
      if (targetRead.kind === 'missing') {
        const fresh = copiedStore(source)
        await writeJson(storePath, fresh.document)
        workspaces = fresh.workspaces
      } else {
        const merged = mergeStore(targetRead.store, source, imported, new Date(now).toISOString())
        if (merged.changed) await writeJson(storePath, targetRead.store.document)
        workspaces = merged.workspaces
      }
    }

    const sessions = [...ledger.sessions, ...[...imported].filter(dir => !recorded.has(dir))]
    const next: Ledger = { version: 1, sessions, ...attachmentFailures > 0 ? { retryAttachments: true } : {} }
    if (sessions.length !== ledger.sessions.length || next.retryAttachments !== ledger.retryAttachments) {
      await mkdir(join(to, 'storages'), { recursive: true, mode: 0o700 })
      await writeJson(ledgerPath, next)
    }
    return { copied, workspaces, deferred, attachmentFailures }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
