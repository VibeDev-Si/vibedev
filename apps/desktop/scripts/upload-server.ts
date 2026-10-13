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
import { basename, join, posix, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import type { DesktopPackageTargetName } from './package-target.ts'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { createDesktopUploadPlan, type DesktopUploadPlan } from './desktop-upload-plan.ts'
import { desktopReleaseTag } from './desktop-release-tag.ts'
import { prerelease } from 'semver'

/** Commands on the download server; injectable so the upload order and checks are testable without one. */
export interface ServerRemote {
  /** Run one POSIX shell command on the server and return its standard output. */
  ssh(command: string): Promise<string>
  /** Copy one local file to an absolute server path. */
  copy(local: string, remotePath: string): Promise<void>
  /** Have the server download one URL to an absolute path. */
  fetch(url: string, remotePath: string): Promise<void>
}

/**
 * A faster route for the large files: this machine's upload to the server is slow (about 60 KB/s measured,
 * 80 minutes for an installer), while its upload to GitHub and the server's download from GitHub are fast
 * (85 s and 57 s). The relay puts a file on a release and answers a short-lived URL the server can fetch
 * without credentials.
 */
export interface ReleaseRelay {
  /**
   * Make release asset `name` hold exactly the local file and return a short-lived download URL for it.
   * An asset that already exists with other bytes is an error: published files are immutable.
   */
  publish(local: string, name: string, sha256: string): Promise<string>
}

/** What one upload did. */
export interface ServerUploadResult {
  readonly uploaded: readonly string[]
  readonly unchanged: readonly string[]
  readonly readback: readonly { readonly key: string; readonly status: number; readonly ok: boolean }[]
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u

/** Single-quote one argument for a POSIX shell. */
export function quote(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

/**
 * Upload one plan to the server.
 * @param plan - Validated plan from `createDesktopUploadPlan`; its bucket and credential names are not used.
 * @param remote - Server commands.
 * @param root - Absolute directory nginx serves at the plan's origin.
 * @param say - Progress output.
 * @param relay - Optional route for the binary files (installer, blockmap); the feed always goes over SSH.
 * @returns Uploaded and unchanged keys, and what nginx answers for each key on the server itself.
 */
export async function uploadDesktopReleaseToServer(
  plan: DesktopUploadPlan, remote: ServerRemote, root: string, say: (line: string) => void = line => process.stdout.write(`${line}\n`),
  relay?: ReleaseRelay,
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
      const bytes = await readFile(local)
      const hash = createHash('sha512').update(bytes).digest('hex')
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
      if (relay !== undefined && artifact.contents === undefined && !artifact.channelMetadata) {
        // Named after the file on disk, so the fixed-name download reuses the versioned installer's asset.
        const url = await relay.publish(local, basename(artifact.path), createHash('sha256').update(bytes).digest('hex'))
        await remote.fetch(url, staged)
      } else {
        await remote.copy(local, staged)
      }
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
    async fetch(url, remotePath) {
      await run('ssh', ['-n', ...common, '-p', String(options.port ?? 22), options.destination,
        `curl -fsS --retry 3 --retry-delay 2 -o ${quote(remotePath)} ${quote(url)}`],
      { maxBuffer: 1 << 20, windowsHide: true, timeout: 30 * 60_000 })
    },
  }
}

/** One GitHub REST request with the local `gh` login; the token never leaves this machine. */
async function github(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url.startsWith('https://') ? url : `https://api.github.com${url}`, { ...init,
    headers: { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', Accept: 'application/vnd.github+json', ...init.headers } })
}

/** One release asset as the REST API reports it. `digest` is GitHub's own SHA-256 of the stored bytes. */
export interface GitHubAsset {
  readonly id: number
  readonly name: string
  readonly size?: number
  readonly digest?: string | null
  readonly state: string
}

/** The release a CI build published to, with its assets. */
export interface GitHubRelease {
  readonly id: number
  readonly tag: string
  readonly assets: readonly GitHubAsset[]
}

/**
 * Read one published release and its assets. Used by the release-driven publish, which takes the
 * installers a CI run uploaded instead of a local build directory.
 * @param options - repository, tag and the local `gh` token.
 * @returns the release and every asset it holds.
 * @throws When the release is absent or its assets cannot be listed.
 */
export async function githubRelease(options: { repo: string; tag: string; token: string }): Promise<GitHubRelease> {
  const response = await github(options.token, `/repos/${options.repo}/releases/tags/${encodeURIComponent(options.tag)}`)
  if (!response.ok) {
    throw new Error(`desktop release publish: release ${options.tag} is not in ${options.repo} (${response.status}); publish the draft release first`)
  }
  const release = await response.json() as { id: number; tag_name: string; assets: GitHubAsset[] }
  return { id: release.id, tag: release.tag_name, assets: release.assets }
}

/**
 * The short-lived URL GitHub answers for one asset download. The server follows it with curl, so it
 * never needs a GitHub credential of its own.
 * @param options - repository and the local `gh` token.
 * @param assetId - asset to download.
 * @returns the signed download URL.
 * @throws When GitHub does not answer with a redirect.
 */
export async function githubAssetDownloadUrl(options: { repo: string; token: string }, assetId: number): Promise<string> {
  const redirect = await github(options.token, `/repos/${options.repo}/releases/assets/${assetId}`,
    { headers: { Accept: 'application/octet-stream' }, redirect: 'manual' })
  const location = redirect.headers.get('location')
  if (redirect.status < 300 || redirect.status >= 400 || location === null) {
    throw new Error(`desktop release publish: GitHub gave no download link for asset ${assetId} (${redirect.status})`)
  }
  return location
}

/**
 * The release `tag` of `repo` as a relay, created on `commit` when absent. The server fetches each asset
 * through the redirect GitHub answers for an authorized download: a signed URL valid for a few minutes,
 * so the server holds no GitHub credential.
 */
export function githubRelay(options: {
  repo: string
  tag: string
  commit: string
  name: string
  prerelease: boolean
  token: string
}): ReleaseRelay {
  let release: Promise<{ id: number; uploadUrl: string }> | undefined
  const ensureRelease = () => release ??= (async () => {
    let response = await github(options.token, `/repos/${options.repo}/releases/tags/${encodeURIComponent(options.tag)}`)
    if (response.status === 404) {
      response = await github(options.token, `/repos/${options.repo}/releases`, { method: 'POST', body: JSON.stringify({
        tag_name: options.tag, target_commitish: options.commit, name: options.name, prerelease: options.prerelease,
        body: `${options.name}. Installer and update files, as published to the VibeDev download server.` }) })
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300)
      // GitHub creates the tag on the packaged commit, so that commit must already be pushed to the repository.
      throw new Error(`desktop server upload: GitHub release ${options.tag} unavailable (${response.status}${response.status === 422
        ? `; is commit ${options.commit} pushed to ${options.repo}?` : ''}): ${detail}`)
    }
    const body = await response.json() as { id: number; upload_url: string }
    return { id: body.id, uploadUrl: body.upload_url.replace(/\{.*$/u, '') }
  })()
  return {
    async publish(local, name, sha256) {
      const { id, uploadUrl } = await ensureRelease()
      const listed = await github(options.token, `/repos/${options.repo}/releases/${id}/assets?per_page=100`)
      if (!listed.ok) throw new Error(`desktop server upload: cannot list release assets (${listed.status})`)
      let asset = (await listed.json() as GitHubAsset[]).find(entry => entry.name === name)
      if (asset !== undefined && asset.state !== 'uploaded') {
        throw new Error(`desktop server upload: release asset ${name} is ${asset.state}; delete it and retry`)
      }
      if (asset !== undefined && asset.digest !== `sha256:${sha256}`) {
        throw new Error(`desktop server upload: release asset ${name} already holds different bytes; published files are immutable`)
      }
      if (asset === undefined) {
        const uploaded = await github(options.token, `${uploadUrl}?name=${encodeURIComponent(name)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await readFile(local) })
        if (!uploaded.ok) throw new Error(`desktop server upload: uploading ${name} to GitHub failed (${uploaded.status})`)
        asset = await uploaded.json() as GitHubAsset
        if (asset.digest !== undefined && asset.digest !== null && asset.digest !== `sha256:${sha256}`) {
          throw new Error(`desktop server upload: GitHub stored ${name} with a different digest`)
        }
      }
      const redirect = await github(options.token, `/repos/${options.repo}/releases/assets/${asset.id}`,
        { headers: { Accept: 'application/octet-stream' }, redirect: 'manual' })
      const location = redirect.headers.get('location')
      if (redirect.status < 300 || redirect.status >= 400 || location === null) {
        throw new Error(`desktop server upload: GitHub gave no download link for ${name} (${redirect.status})`)
      }
      return location
    },
  }
}

/**
 * `upload-server.ts <target> --ssh user@host --identity <key> --known-hosts <file> --root <dir> [--latest] [--via-github owner/repo]`.
 * `--via-github` sends the installer and blockmap through release `desktop-v<version>` of that repository (created on the
 * packaged commit; a build with uncommitted changes is refused); the feed still goes over SSH, last.
 * Release settings (deployment, origin) come from the target's dotenv file, as for the COS upload.
 */
export async function uploadDesktopTargetToServer(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    latest: { type: 'boolean' }, ssh: { type: 'string' }, identity: { type: 'string' },
    'known-hosts': { type: 'string' }, root: { type: 'string' }, port: { type: 'string' }, 'via-github': { type: 'string' },
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
  let relay: ReleaseRelay | undefined
  const repo = values['via-github']
  if (repo !== undefined) {
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(repo)) throw new Error('desktop server upload: --via-github expects owner/repo')
    if (plan.commit === undefined || plan.dirty !== false) {
      throw new Error('desktop server upload: --via-github needs a build of a committed tree, so its release tag names what users receive')
    }
    const { stdout } = await promisify(execFile)('gh', ['auth', 'token'], { windowsHide: true })
    relay = githubRelay({ repo, tag: desktopReleaseTag(plan.version), commit: plan.commit, name: `VibeDev ${plan.version}`,
      prerelease: prerelease(plan.version) !== null, token: stdout.trim() })
  }
  const result = await uploadDesktopReleaseToServer(plan, remote, values.root!, undefined, relay)
  process.stdout.write(`desktop server upload: done (${result.uploaded.length} uploaded, ${result.unchanged.length} unchanged; nginx serves all)\n`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  uploadDesktopTargetToServer(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
