/**
 * VibeDev fork: publish validated Desktop update artifacts to VibeDev's own download server over SSH,
 * instead of Tencent COS. The plan is the one `upload-target.ts` uploads (same validation, same keys,
 * channel metadata last); the server serves `<root>/<key>` at the plan's origin (nginx, see FORK-DELTA.md).
 *
 * Every file is copied to a temporary name, verified by SHA-512 on the server, and renamed into place,
 * so a public name never holds a partial file. A versioned file that is already public is immutable:
 * identical bytes are left alone, different bytes stop the upload before the feed moves.
 */

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import type { DesktopPackageTargetName } from './package-target.ts'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { createDesktopUploadPlan, type DesktopUploadPlan } from './desktop-upload-plan.ts'

/** Commands on the download server; injectable so the upload order and checks are testable without one. */
export interface ServerRemote {
  /** Run one POSIX shell command on the server and return its standard output. */
  ssh(command: string): Promise<string>
  /** Copy one local file to an absolute server path. */
  copy(local: string, remotePath: string): Promise<void>
}

/** What one upload did. */
export interface ServerUploadResult {
  readonly uploaded: readonly string[]
  readonly unchanged: readonly string[]
  readonly readback: readonly { readonly key: string; readonly status: number; readonly ok: boolean }[]
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u

/** Single-quote one argument for a POSIX shell. */
function quote(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

/**
 * Upload one plan to the server.
 * @param plan - Validated plan from `createDesktopUploadPlan`; its bucket and credential names are not used.
 * @param remote - Server commands.
 * @param root - Absolute directory nginx serves at the plan's origin.
 * @param say - Progress output.
 * @returns Uploaded and unchanged keys, and what nginx answers for each key on the server itself.
 */
export async function uploadDesktopReleaseToServer(
  plan: DesktopUploadPlan, remote: ServerRemote, root: string, say: (line: string) => void = line => process.stdout.write(`${line}\n`),
): Promise<ServerUploadResult> {
  if (!root.startsWith('/') || root.includes('/../') || root.endsWith('/..')) throw new Error('desktop server upload: root must be an absolute path')
  for (const artifact of plan.artifacts) {
    if (!KEY.test(artifact.key) || artifact.key.split('/').some(part => part === '..' || part === '.')) {
      throw new Error(`desktop server upload: unsafe key ${JSON.stringify(artifact.key)}`)
    }
  }
  const scratch = await mkdtemp(join(tmpdir(), 'vibedev-server-upload-'))
  const uploaded: string[] = []
  const unchanged: string[] = []
  try {
    for (const artifact of plan.artifacts) {
      let local = artifact.path
      if (artifact.contents !== undefined) {
        local = join(scratch, artifact.filename)
        await writeFile(local, artifact.contents)
      }
      const hash = createHash('sha512').update(await readFile(local)).digest('hex')
      const target = posix.join(root, artifact.key)
      const existing = (await remote.ssh(`sha512sum -- ${quote(target)} 2>/dev/null || true`)).trim().split(/\s+/u)[0] ?? ''
      if (existing === hash) {
        unchanged.push(artifact.key)
        say(`desktop server upload: unchanged ${artifact.key}`)
        continue
      }
      // Versioned files are cached as immutable; a fixed name (feed, latest download) is meant to change.
      if (existing !== '' && !artifact.channelMetadata && artifact.filename.includes(plan.version)) {
        throw new Error(`desktop server upload: ${artifact.key} is already public with different bytes; published files are immutable`)
      }
      const staged = `${target}.uploading-${randomBytes(6).toString('hex')}`
      await remote.ssh(`mkdir -p -- ${quote(posix.dirname(target))}`)
      await remote.copy(local, staged)
      await remote.ssh(`if [ "$(sha512sum < ${quote(staged)} | cut -d' ' -f1)" = ${quote(hash)} ] && chmod 644 -- ${quote(staged)} && mv -f -- ${quote(staged)} ${quote(target)}; then :; else rm -f -- ${quote(staged)}; exit 1; fi`)
      uploaded.push(artifact.key)
      say(`desktop server upload: uploaded ${artifact.key}`)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  // Read back through nginx on the server itself, so the check does not depend on DNS.
  const host = new URL(plan.publicUrl).hostname
  const readback = []
  for (const key of [...uploaded, ...unchanged]) {
    const answer = (await remote.ssh(`curl -sS -o /dev/null -w '%{http_code} %{size_download}' --resolve ${quote(`${host}:443:127.0.0.1`)} ${quote(`https://${host}/${key}`)}`)).trim()
    const status = Number(answer.split(' ')[0])
    readback.push({ key, status, ok: status === 200 })
  }
  const failed = readback.filter(entry => !entry.ok)
  if (failed.length > 0) throw new Error(`desktop server upload: nginx does not serve ${failed.map(entry => `${entry.key} (${entry.status})`).join(', ')}`)
  return { uploaded, unchanged, readback }
}

/**
 * Real SSH and SCP with a pinned host key; no password prompts. `ssh -n`: Windows OpenSSH does not exit after the
 * remote command until its stdin closes, and execFile gives it a pipe that never does. Timeouts end any other hang.
 */
export function sshRemote(options: { destination: string; identity: string; knownHosts: string; port?: number }): ServerRemote {
  const common = ['-i', options.identity, '-o', `UserKnownHostsFile=${options.knownHosts}`, '-o', 'StrictHostKeyChecking=yes',
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20']
  const run = promisify(execFile)
  return {
    async ssh(command) {
      const { stdout } = await run('ssh', ['-n', ...common, '-p', String(options.port ?? 22), options.destination, command],
        { maxBuffer: 1 << 20, windowsHide: true, timeout: 120_000 })
      return stdout
    },
    async copy(local, remotePath) {
      await run('scp', [...common, '-P', String(options.port ?? 22), '-q', local, `${options.destination}:${remotePath}`],
        { maxBuffer: 1 << 20, windowsHide: true, timeout: 3 * 60 * 60_000 })
    },
  }
}

/**
 * `upload-server.ts <target> --ssh user@host --identity <key> --known-hosts <file> --root <dir> [--latest]`.
 * Release settings (deployment, origin) come from the target's dotenv file, as for the COS upload.
 */
export async function uploadDesktopTargetToServer(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    latest: { type: 'boolean' }, ssh: { type: 'string' }, identity: { type: 'string' },
    'known-hosts': { type: 'string' }, root: { type: 'string' }, port: { type: 'string' },
  } })
  const target = positionals[0] as DesktopPackageTargetName | undefined
  if (positionals.length !== 1 || !['mac-arm64', 'mac-x64', 'win-x64'].includes(target ?? '')) {
    throw new Error('desktop server upload: expected exactly one target: mac-arm64, mac-x64 or win-x64')
  }
  for (const name of ['ssh', 'identity', 'known-hosts', 'root'] as const) {
    if (values[name] === undefined || values[name] === '') throw new Error(`desktop server upload: --${name} is required`)
  }
  const fileEnvironment = loadDesktopPackageEnvironment(target === 'win-x64' ? 'win32' : 'darwin')
  // The plan names a COS bucket; the server upload ignores it, so a placeholder satisfies validation.
  const environment = { DOWNLOAD_PROD_COS_BUCKET: 'vibedev-server', DOWNLOAD_TEST_COS_BUCKET: 'vibedev-server', ...fileEnvironment }
  const plan = await createDesktopUploadPlan(target!, { environment, latest: values.latest === true })
  process.stdout.write(`desktop server upload: ${plan.target} ${plan.version} -> ${plan.publicUrl}\n`)
  const remote = sshRemote({ destination: values.ssh!, identity: resolve(values.identity!), knownHosts: resolve(values['known-hosts']!),
    ...values.port === undefined ? {} : { port: Number(values.port) } })
  const result = await uploadDesktopReleaseToServer(plan, remote, values.root!)
  process.stdout.write(`desktop server upload: done (${result.uploaded.length} uploaded, ${result.unchanged.length} unchanged; nginx serves all)\n`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  uploadDesktopTargetToServer(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
