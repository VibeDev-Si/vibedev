/**
 * Publish one CI-built release to the VibeDev download server.
 *
 * The release workflow builds each platform and attaches the installers plus the electron-builder feed
 * to release `desktop-v<version>`. This script takes those assets instead of a local build directory:
 * the server pulls each file through the short-lived URL GitHub answers for it, verifies the bytes and
 * renames it into place, and the feed goes last — rewritten, because electron-builder writes a relative
 * payload name that would otherwise resolve below the feed directory instead of the binary directory.
 *
 * `publish-release.ts --tag desktop-v<version> --target <win-x64|mac-arm64|mac-x64>
 *   --ssh user@host --identity <key> --known-hosts <file> --root <dir> [--latest] [--dry-run]`
 *
 * @module dsh-desktop/publish-release
 */

import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, posix, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { dump, load } from 'js-yaml'
import { prerelease } from 'semver'
import { desktopUpdateMetadataFilename, resolveDesktopAutoUpdateConfig } from './desktop-auto-update-environment.mjs'
import { validateDesktopBuildVersion } from './desktop-build-version.mjs'
import type { DesktopPackageTargetName } from './package-target.ts'
import { githubAssetDownloadUrl, githubRelease, quote, sshRemote, type GitHubAsset, type ServerRemote } from './upload-server.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')

/** Platform and architecture of each publishable target. */
const TARGET_PLATFORM: Readonly<Record<DesktopPackageTargetName, { platform: 'darwin' | 'win32'; arch: string }>> = {
  'win-x64': { platform: 'win32', arch: 'x64' },
  'mac-arm64': { platform: 'darwin', arch: 'arm64' },
  'mac-x64': { platform: 'darwin', arch: 'x64' },
}

/** One file to put on the server: a release asset, or contents generated here. */
export interface ReleasePublishStep {
  /** Destination path below the server root. */
  readonly key: string
  /** Binaries are cached as immutable; the feed is meant to change. */
  readonly kind: 'binary' | 'feed'
  /** Release asset to fetch; absent for generated contents. */
  readonly assetName?: string
  /** Generated file contents (the rewritten feed). */
  readonly contents?: string
  /** Hash the feed promises for this payload, checked after the server fetched it. */
  readonly sha512?: string
  /** GitHub's own SHA-256 of the stored bytes, checked after the server fetched it. */
  readonly sha256?: string
  /** Size GitHub reports, used only when no digest is available. */
  readonly size?: number
}

/** What one publish will do. */
export interface ReleasePublishPlan {
  readonly version: string
  readonly target: DesktopPackageTargetName
  readonly origin: string
  readonly steps: readonly ReleasePublishStep[]
  /** The fixed-name download rebuilt from the versioned installer, when requested. */
  readonly latest?: { readonly key: string; readonly source: string }
}

/**
 * The build version a release tag names.
 * @param tag - release tag, for example `desktop-v0.2.1-alpha.2.20261013.4`.
 * @param productVersion - the version the desktop package declares.
 * @returns the validated build version.
 * @throws When the tag is not a `desktop-v<version>` tag holding a build of that product version.
 */
export function releaseVersionFromTag(tag: string, productVersion: string): string {
  if (!tag.startsWith('desktop-v')) throw new Error(`desktop release publish: ${JSON.stringify(tag)} is not a desktop-v<version> tag`)
  try {
    return validateDesktopBuildVersion(tag.slice('desktop-v'.length), productVersion)
  }
  catch (error) {
    throw new Error(`desktop release publish: ${tag} does not name a build of ${productVersion}: ${
      error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * The digest of the single update file a feed describes, after checking the feed against the release.
 * @param text - the feed as electron-builder wrote it.
 * @param expectedFilename - the payload this platform updates through.
 * @param expectedVersion - the version the feed must name.
 * @param label - the asset name, for diagnostics.
 * @returns the promised SHA-512 of the payload, as lowercase hexadecimal so it compares with `sha512sum`.
 * @throws When the feed is not a single-file feed for this version and payload.
 */
function feedPayloadSha512(
  text: string, expectedFilename: string, expectedVersion: string, label: string,
): { sha512: string; entry: Record<string, unknown>; metadata: Record<string, unknown> } {
  const loaded = load(text)
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) throw new Error(`desktop release publish: ${label} is not a YAML mapping`)
  const metadata = loaded as Record<string, unknown>
  if (metadata.version !== expectedVersion) {
    throw new Error(`desktop release publish: ${label} holds version ${String(metadata.version)}, expected ${expectedVersion}`)
  }
  if (!Array.isArray(metadata.files) || metadata.files.length !== 1) {
    throw new Error(`desktop release publish: ${label}.files must contain exactly one update file`)
  }
  const entry = metadata.files[0] as Record<string, unknown> | undefined
  if (typeof entry !== 'object' || entry === null || typeof entry.url !== 'string') {
    throw new Error(`desktop release publish: ${label}.files[0].url is missing`)
  }
  if (basename(entry.url) !== expectedFilename) {
    throw new Error(`desktop release publish: ${label} must reference ${expectedFilename}, received ${entry.url}`)
  }
  if (typeof entry.sha512 !== 'string' || entry.sha512 === '') {
    throw new Error(`desktop release publish: ${label}.files[0].sha512 is missing`)
  }
  // electron-builder writes base64; the server's sha512sum answers hexadecimal.
  const digest = Buffer.from(entry.sha512, 'base64')
  if (digest.length !== 64) {
    throw new Error(`desktop release publish: ${label}.files[0].sha512 is not a base64 SHA-512 of 64 bytes`)
  }
  return { sha512: digest.toString('hex'), entry, metadata }
}

/**
 * Turn one release's assets into the steps that publish them, rewriting the feed so its payload points
 * at the download server.
 * @param input - release assets, tag, target, options and the already-read feed text.
 * @returns the plan to execute.
 * @throws When the release lacks an asset this target needs, or its feed does not describe it.
 */
export function planReleasePublish(input: {
  readonly assets: readonly GitHubAsset[]
  readonly tag: string
  readonly productVersion: string
  readonly target: DesktopPackageTargetName
  readonly environment: 'test' | 'production'
  readonly latest: boolean
  readonly feedText: string
}): ReleasePublishPlan {
  const { platform, arch } = TARGET_PLATFORM[input.target]
  const version = releaseVersionFromTag(input.tag, input.productVersion)
  const update = resolveDesktopAutoUpdateConfig({ DSH_DESKTOP_AUTO_UPDATE_ENV: input.environment }, platform, arch)
  const base = `vibedev-${version}-${input.target}`
  const metadataFilename = desktopUpdateMetadataFilename(version, platform)
  const updaterFilename = platform === 'darwin' ? `${base}.zip` : `${base}.exe`
  const installerFilename = platform === 'darwin' ? `${base}.dmg` : `${base}.exe`
  const binaryNames = platform === 'darwin'
    ? [installerFilename, updaterFilename, `${base}.zip.blockmap`]
    : [updaterFilename, `${base}.exe.blockmap`]
  const assetOf = (name: string): GitHubAsset => {
    const asset = input.assets.find(entry => entry.name === name)
    if (asset === undefined) {
      throw new Error(`desktop release publish: release ${input.tag} has no ${name}; it holds ${
        input.assets.map(entry => entry.name).join(', ')}`)
    }
    return asset
  }
  const digestOf = (asset: GitHubAsset): string | undefined =>
    asset.digest?.startsWith('sha256:') === true ? asset.digest.slice('sha256:'.length) : undefined

  const { sha512, entry, metadata } = feedPayloadSha512(input.feedText, updaterFilename, version, metadataFilename)
  const payloadUrl = `${update.origin}/${update.binaryKeyPrefix}/${updaterFilename}`
  const published = {
    ...metadata,
    files: [{ ...entry, url: payloadUrl }],
    ...metadata.path === undefined ? {} : { path: payloadUrl },
  }
  const rewritten = dump(published)
  const steps: ReleasePublishStep[] = binaryNames.map((name) => {
    const asset = assetOf(name)
    const digest = digestOf(asset)
    return {
      key: `${update.binaryKeyPrefix}/${name}`,
      kind: 'binary' as const,
      assetName: name,
      ...name === updaterFilename ? { sha512 } : {},
      ...digest === undefined ? {} : { sha256: digest },
      ...asset.size === undefined ? {} : { size: asset.size },
    }
  })
  steps.push({ key: `${update.keyPrefix}/${metadataFilename}`, kind: 'feed', contents: rewritten })
  if (prerelease(version) === null) {
    const stable = metadataFilename.replace('nightly', 'latest')
    steps.push({ key: `${update.keyPrefix}/${stable}`, kind: 'feed', contents: rewritten })
  }
  return {
    version,
    target: input.target,
    origin: update.origin,
    steps,
    ...input.latest ? {
      latest: {
        key: `desktop/dsh-latest-${platform === 'darwin' ? 'macos' : 'windows'}-${arch}.${platform === 'darwin' ? 'dmg' : 'exe'}`,
        source: `${update.binaryKeyPrefix}/${installerFilename}`,
      },
    } : {},
  }
}

/**
 * Execute one plan against the server: fetch each asset through a signed URL, verify the bytes on the
 * server, then rename into place; the feed is last, so it never points at a binary that is not there.
 * @param plan - the plan to execute.
 * @param options - how to reach GitHub and the server.
 * @returns the keys written and the keys already identical.
 * @throws When the server root is not absolute, a versioned file is already public with other bytes, or a check fails.
 */
export async function publishReleasePlan(plan: ReleasePublishPlan, options: {
  readonly assets: readonly GitHubAsset[]
  readonly downloadUrl: (assetId: number) => Promise<string>
  readonly remote: ServerRemote
  readonly root: string
  readonly say?: (line: string) => void
}): Promise<{ uploaded: string[]; unchanged: string[] }> {
  const { remote, root } = options
  const say = options.say ?? ((line: string) => process.stdout.write(`${line}\n`))
  if (!root.startsWith('/') || root.includes('/../') || root.endsWith('/..')) {
    throw new Error('desktop release publish: root must be an absolute path')
  }
  const idOf = new Map(options.assets.map(asset => [asset.name, asset.id]))
  const scratch = await mkdtemp(join(tmpdir(), 'vibedev-release-publish-'))
  const uploaded: string[] = []
  const unchanged: string[] = []
  try {
    for (const step of plan.steps) {
      const target = posix.join(root, step.key)
      const local = step.contents === undefined ? undefined : join(scratch, basename(step.key))
      if (local !== undefined) await writeFile(local, step.contents as string)
      const expected = step.sha512 ?? (local === undefined ? undefined : createHash('sha512').update(step.contents as string).digest('hex'))
      // A feed the plan generated is hashed here; a release asset is hashed the way its source states:
      // the feed's SHA-512 for the updater payload, GitHub's SHA-256 for everything else.
      const algorithm = expected !== undefined ? 'sha512' as const : step.sha256 === undefined ? undefined : 'sha256' as const
      const wanted = algorithm === 'sha512' ? expected : algorithm === 'sha256' ? step.sha256 : undefined
      const existing = algorithm === undefined
        ? ''
        : (await remote.ssh(`${algorithm}sum -- ${quote(target)} 2>/dev/null || true`)).trim().split(/\s+/u)[0] ?? ''
      if (wanted !== undefined && existing === wanted) {
        unchanged.push(step.key)
        say(`desktop release publish: unchanged ${step.key}`)
        continue
      }
      if (step.kind === 'binary' && existing !== '' && wanted !== undefined && existing !== wanted) {
        throw new Error(`desktop release publish: ${step.key} is already public with different bytes; published files are immutable`)
      }
      const staged = `${target}.uploading-${randomBytes(6).toString('hex')}`
      await remote.ssh(`mkdir -p -- ${quote(posix.dirname(target))}`)
      if (local !== undefined) {
        await remote.copy(local, staged)
      }
      else {
        const assetId = step.assetName === undefined ? undefined : idOf.get(step.assetName)
        if (assetId === undefined) throw new Error(`desktop release publish: ${step.key} has no release asset to fetch`)
        await remote.fetch(await options.downloadUrl(assetId), staged)
      }
      const checks: string[] = []
      if (step.sha512 !== undefined) checks.push(`[ "$(sha512sum < ${quote(staged)} | cut -d' ' -f1)" = ${quote(step.sha512)} ]`)
      if (step.sha256 !== undefined) checks.push(`[ "$(sha256sum < ${quote(staged)} | cut -d' ' -f1)" = ${quote(step.sha256)} ]`)
      if (checks.length === 0 && step.size !== undefined) {
        checks.push(`[ "$(stat -c%s -- ${quote(staged)})" = ${quote(String(step.size))} ]`)
      }
      const verify = checks.length === 0 ? ':' : checks.join(' && ')
      await remote.ssh(`if ${verify} && chmod 644 -- ${quote(staged)} && mv -f -- ${quote(staged)} ${quote(target)}; then :; else rm -f -- ${quote(staged)}; exit 1; fi`)
      uploaded.push(step.key)
      say(`desktop release publish: uploaded ${step.key}`)
    }
    if (plan.latest !== undefined) {
      const source = posix.join(root, plan.latest.source)
      const target = posix.join(root, plan.latest.key)
      await remote.ssh(`mkdir -p -- ${quote(posix.dirname(target))}`)
      await remote.ssh(`if cp -f -- ${quote(source)} ${quote(target)} && [ "$(sha512sum < ${quote(source)} | cut -d' ' -f1)" = "$(sha512sum < ${quote(target)} | cut -d' ' -f1)" ]; then chmod 644 -- ${quote(target)}; else rm -f -- ${quote(target)}; exit 1; fi`)
      uploaded.push(plan.latest.key)
      say(`desktop release publish: uploaded ${plan.latest.key} (copy of ${plan.latest.source})`)
    }
  }
  finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return { uploaded, unchanged }
}

/**
 * The feed asset of one target inside a release.
 *
 * Both macOS architectures build a feed named `nightly-mac.yml`, so each job attaches its copy under
 * `<target>-<feed name>`; taking the plain name would silently hand an Intel user an Apple-silicon
 * payload. Releases published before 20261013.4 hold only the plain name, so that stays accepted.
 * @param assets - the release's assets.
 * @param target - the target being published.
 * @param metadataFilename - the feed name electron-builder wrote.
 * @returns the asset to rewrite, or undefined when the release holds neither name.
 */
export function feedAssetFor(
  assets: readonly GitHubAsset[], target: DesktopPackageTargetName, metadataFilename: string,
): GitHubAsset | undefined {
  return assets.find(asset => asset.name === `${target}-${metadataFilename}`)
    ?? assets.find(asset => asset.name === metadataFilename)
}

/**
 * Publish a release's installers and feed to the download server, then read every key back through nginx.
 * @param args - CLI arguments: `--tag`, `--target`, `--ssh`, `--identity`, `--known-hosts`, `--root`,
 *   optional `--repo`, `--port`, `--environment`, `--latest`, `--dry-run`.
 * @throws When a required argument is missing or any step fails.
 */
export async function publishReleaseToServer(args: string[]): Promise<void> {
  // `pnpm run <script> -- --tag …` forwards its separator, so accept one.
  const cleaned = args[0] === '--' ? args.slice(1) : args
  const { values } = parseArgs({ args: cleaned, options: {
    repo: { type: 'string', default: 'VibeDev-Si/vibedev' }, tag: { type: 'string' }, target: { type: 'string' },
    environment: { type: 'string', default: 'production' }, ssh: { type: 'string' }, identity: { type: 'string' },
    'known-hosts': { type: 'string' }, root: { type: 'string' }, port: { type: 'string' },
    latest: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  } })
  for (const name of ['tag', 'target', 'ssh', 'identity', 'known-hosts', 'root'] as const) {
    if (values[name] === undefined || values[name] === '') throw new Error(`desktop release publish: --${name} is required`)
  }
  const target = values.target as DesktopPackageTargetName
  if (TARGET_PLATFORM[target] === undefined) throw new Error('desktop release publish: --target must be win-x64, mac-arm64 or mac-x64')
  if (values.environment !== 'test' && values.environment !== 'production') {
    throw new Error('desktop release publish: --environment must be test or production')
  }
  const repo = values.repo as string
  const tag = values.tag as string
  const root = values.root as string
  const productVersion = (JSON.parse(await readFile(join(APP_ROOT, 'package.json'), 'utf8')) as { version: string }).version
  const token = (await promisify(execFile)('gh', ['auth', 'token'], { windowsHide: true })).stdout.trim()
  const release = await githubRelease({ repo, tag, token })
  const version = releaseVersionFromTag(tag, productVersion)
  const metadataFilename = desktopUpdateMetadataFilename(version, TARGET_PLATFORM[target].platform)
  const feed = feedAssetFor(release.assets, target, metadataFilename)
  if (feed === undefined) {
    throw new Error(`desktop release publish: release ${tag} has no ${target}-${metadataFilename} (nor ${metadataFilename}) to rewrite; it holds ${
      release.assets.map(asset => asset.name).join(', ')}`)
  }
  const feedUrl = await githubAssetDownloadUrl({ repo, token }, feed.id)
  const feedResponse = await fetch(feedUrl)
  if (!feedResponse.ok) throw new Error(`desktop release publish: cannot read ${metadataFilename} (${feedResponse.status})`)
  const plan = planReleasePublish({
    assets: release.assets, tag, productVersion, target,
    environment: values.environment as 'test' | 'production', latest: values.latest === true,
    feedText: await feedResponse.text(),
  })
  process.stdout.write(`desktop release publish: ${plan.target} ${plan.version} -> ${plan.origin}\n`)
  for (const step of plan.steps) process.stdout.write(`  ${step.kind.padEnd(6)} ${step.key}\n`)
  if (plan.latest !== undefined) process.stdout.write(`  latest ${plan.latest.key} (copy of ${plan.latest.source})\n`)
  if (values['dry-run'] === true) { process.stdout.write('desktop release publish: dry run, nothing sent\n'); return }
  const remote = sshRemote({
    destination: values.ssh as string, identity: resolve(values.identity as string),
    knownHosts: resolve(values['known-hosts'] as string),
    ...values.port === undefined ? {} : { port: Number(values.port) },
  })
  const result = await publishReleasePlan(plan, {
    assets: release.assets, remote, root,
    downloadUrl: assetId => githubAssetDownloadUrl({ repo, token }, assetId),
  })
  const host = new URL(plan.origin).hostname
  for (const key of [...result.uploaded, ...result.unchanged]) {
    const answer = (await remote.ssh(`curl -sS -o /dev/null -w '%{http_code}' --resolve ${quote(`${host}:443:127.0.0.1`)} ${quote(`https://${host}/${key}`)}`)).trim()
    if (answer !== '200') throw new Error(`desktop release publish: nginx does not serve ${key} (${answer})`)
  }
  process.stdout.write(`desktop release publish: done (${result.uploaded.length} uploaded, ${result.unchanged.length} unchanged; nginx serves all)\n`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  publishReleaseToServer(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
