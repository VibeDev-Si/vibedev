import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'
import { uploadDesktopReleaseToServer, type ServerRemote } from '../scripts/upload-server.ts'

const ROOT = '/data/vibedev-download/public'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const sha512 = (body: string | Buffer) => createHash('sha512').update(body).digest('hex')

/** A server whose files live in a map; every command is recorded, and copies and renames really move bytes. */
function fakeServer(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const staged = new Map<string, string>()
  const log: string[] = []
  const remote: ServerRemote = {
    async ssh(command) {
      log.push(`ssh ${command}`)
      const hash = /^sha512sum -- '([^']+)' 2>\/dev\/null \|\| true$/u.exec(command)
      if (hash) return files.has(hash[1]!) ? `${sha512(files.get(hash[1]!)!)}  ${hash[1]}\n` : ''
      if (command.startsWith('mkdir -p -- ')) return ''
      const move = /sha512sum < '([^']+)'.* = '([0-9a-f]+)' \] && chmod 644 -- '[^']+' && mv -f -- '[^']+' '([^']+)'/u.exec(command)
      if (move) {
        const body = staged.get(move[1]!)
        if (body === undefined || sha512(body) !== move[2]) throw new Error('remote checksum mismatch')
        files.set(move[3]!, body)
        staged.delete(move[1]!)
        return ''
      }
      const read = /--resolve '([^:]+):443:127\.0\.0\.1'.* 'https:\/\/[^/]+\/([^']+)'$/u.exec(command)
      if (read) return files.has(`${ROOT}/${read[2]}`) ? `200 ${Buffer.byteLength(files.get(`${ROOT}/${read[2]}`)!)}` : '404 0'
      throw new Error(`unexpected command ${command}`)
    },
    async copy(local, remotePath) {
      log.push(`copy ${remotePath}`)
      const { readFileSync } = await import('node:fs')
      staged.set(remotePath, readFileSync(local, 'utf8'))
    },
  }
  return { remote, files, log }
}

function plan(): DesktopUploadPlan {
  const dir = mkdtempSync(join(tmpdir(), 'upload-server-'))
  dirs.push(dir)
  const exe = join(dir, 'vibedev-1.2.3-win-x64.exe')
  const map = join(dir, 'vibedev-1.2.3-win-x64.exe.blockmap')
  const yml = join(dir, 'nightly.yml')
  writeFileSync(exe, 'installer bytes')
  writeFileSync(map, 'blockmap bytes')
  writeFileSync(yml, 'local feed, replaced by contents')
  return {
    environment: 'production', target: 'win-x64', version: '1.2.3',
    publicUrl: 'https://download.vibedev.studio/dsh-desk/feeds/win-x64/', bucket: 'unused',
    secretIdEnvName: 'unused', secretKeyEnvName: 'unused',
    artifacts: [
      { path: exe, filename: 'vibedev-1.2.3-win-x64.exe', key: 'dsh-desk/bin/win-x64/vibedev-1.2.3-win-x64.exe', contentType: 'x', channelMetadata: false },
      { path: map, filename: 'vibedev-1.2.3-win-x64.exe.blockmap', key: 'dsh-desk/bin/win-x64/vibedev-1.2.3-win-x64.exe.blockmap', contentType: 'x', channelMetadata: false },
      { path: yml, filename: 'nightly.yml', key: 'dsh-desk/feeds/win-x64/nightly.yml', contentType: 'x', channelMetadata: true, contents: 'version: 1.2.3\n' },
    ],
  }
}

describe('upload to the VibeDev download server', () => {
  it('stages, verifies and renames every file, the feed last and with the rewritten contents', async () => {
    const server = fakeServer()
    const result = await uploadDesktopReleaseToServer(plan(), server.remote, ROOT, () => {})
    expect(result.uploaded).toEqual([
      'dsh-desk/bin/win-x64/vibedev-1.2.3-win-x64.exe',
      'dsh-desk/bin/win-x64/vibedev-1.2.3-win-x64.exe.blockmap',
      'dsh-desk/feeds/win-x64/nightly.yml',
    ])
    expect(server.files.get(`${ROOT}/dsh-desk/feeds/win-x64/nightly.yml`)).toBe('version: 1.2.3\n')
    expect(server.files.get(`${ROOT}/dsh-desk/bin/win-x64/vibedev-1.2.3-win-x64.exe`)).toBe('installer bytes')
    // Nothing is ever copied straight onto a public name.
    expect(server.log.filter(line => line.startsWith('copy ')).every(line => /\.uploading-[0-9a-f]+$/u.test(line))).toBe(true)
    // The feed is the last file to become public, so an updater never sees it before its installer.
    const renames = server.log.filter(line => line.includes('mv -f'))
    expect(renames.at(-1)).toContain('nightly.yml')
    expect(result.readback).toEqual(result.uploaded.map(key => ({ key, status: 200, ok: true })))
  })

  it('leaves an identical published file alone', async () => {
    const server = fakeServer({ [`${ROOT}/dsh-desk/bin/win-x64/vibedev-1.2.3-win-x64.exe`]: 'installer bytes' })
    const result = await uploadDesktopReleaseToServer(plan(), server.remote, ROOT, () => {})
    expect(result.unchanged).toEqual(['dsh-desk/bin/win-x64/vibedev-1.2.3-win-x64.exe'])
    expect(server.log.some(line => line.startsWith('copy ') && line.includes('win-x64.exe.uploading'))).toBe(false)
  })

  it('refuses to replace a published installer with different bytes, before the feed moves', async () => {
    const server = fakeServer({ [`${ROOT}/dsh-desk/bin/win-x64/vibedev-1.2.3-win-x64.exe`]: 'other bytes' })
    await expect(uploadDesktopReleaseToServer(plan(), server.remote, ROOT, () => {})).rejects.toThrow(/immutable/u)
    expect(server.files.has(`${ROOT}/dsh-desk/feeds/win-x64/nightly.yml`)).toBe(false)
  })

  it('replaces an older feed (the feed is the one file that changes)', async () => {
    const server = fakeServer({ [`${ROOT}/dsh-desk/feeds/win-x64/nightly.yml`]: 'version: 1.2.2\n' })
    await uploadDesktopReleaseToServer(plan(), server.remote, ROOT, () => {})
    expect(server.files.get(`${ROOT}/dsh-desk/feeds/win-x64/nightly.yml`)).toBe('version: 1.2.3\n')
  })

  it('rejects a key that could leave the download root', async () => {
    const bad = plan()
    ;(bad.artifacts[0] as { key: string }).key = 'dsh-desk/../../etc/x'
    await expect(uploadDesktopReleaseToServer(bad, fakeServer().remote, ROOT, () => {})).rejects.toThrow(/key/u)
  })
})
