/**
 * Release gate: the desktop installer must ship npm latest of every VibeDev plugin it bundles.
 *
 * The bundled copy of an application-owned plugin is the floor a profile copy can only raise, so users who never update
 * a plugin themselves run the version this check approves. Every `@vibedev-si/*` entry of `dependencies` in the
 * manifests below must pin one exact version (a semantic version, or a raw.githubusercontent.com archive whose file name
 * ends in `-<version>.tgz`), the same in every manifest, equal to the `latest` dist-tag on registry.npmjs.org.
 * It prints one line per package and exits 1 when any package fails or npm cannot be read.
 *
 * Only Node built-ins are imported: the release workflow runs it before any `pnpm install`.
 *
 * `check-bundled-plugins.ts [--root <repository checkout>]`
 *
 * @module dsh-desktop/check-bundled-plugins
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** Manifests, relative to the repository root, whose `@vibedev-si/*` dependencies are bundled into the installer. */
export const BUNDLED_PLUGIN_MANIFESTS = [
  'apps/cli/package.json',
  'packages/vibedev/defaults/package.json',
  'packages/vibedev/web-defaults/package.json',
] as const

const BUNDLED_PLUGIN_SCOPE = '@vibedev-si/'
const NPM_REGISTRY = 'https://registry.npmjs.org'
const NPM_TIMEOUT_MS = 30_000
const NUMERIC = String.raw`0|[1-9]\d*`
const PRERELEASE_IDENTIFIER = String.raw`(?:${NUMERIC}|\d*[A-Za-z-][0-9A-Za-z-]*)`
/** Semantic Versioning 2.0.0, section 9–10 grammar: core, optional prerelease, optional build metadata. */
const SEMVER = new RegExp([
  String.raw`^(${NUMERIC})\.(${NUMERIC})\.(${NUMERIC})`,
  String.raw`(?:-(${PRERELEASE_IDENTIFIER}(?:\.${PRERELEASE_IDENTIFIER})*))?`,
  String.raw`(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
].join(''))
/** The leftmost `-<major>.<minor>.<patch>…` before `.tgz` in an npm-pack archive name; the capture is validated by {@link SEMVER}. */
const ARCHIVE_VERSION = /-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)\.tgz$/

/** One `@vibedev-si/*` dependency as one manifest declares it. */
export interface BundledPluginPin {
  /** Manifest path relative to the repository root. */
  readonly manifest: string
  /** Package name. */
  readonly name: string
  /** Dependency specifier exactly as written. */
  readonly specifier: string
}

/** npm's `latest` dist-tag for one package, or why it could not be read. */
export type NpmLatest = { readonly version: string } | { readonly error: string }

/** The gate's answer for one package across every manifest that pins it. */
export interface BundledPluginVerdict {
  /** Package name. */
  readonly name: string
  /** Distinct pinned versions in ascending order, then any pin that names no exact version, comma separated. */
  readonly pinned: string
  /** npm's `latest` version, or `unavailable` when it could not be read. */
  readonly latest: string
  /** Whether the package may ship: one exact pin everywhere, equal to npm latest. */
  readonly ok: boolean
  /** Why it may not ship; empty when `ok`. */
  readonly problems: readonly string[]
}

/**
 * Read the exact version a dependency specifier pins.
 * @param specifier - A semantic version, or a raw.githubusercontent.com archive URL whose file name ends in `-<version>.tgz`.
 * @returns The pinned semantic version.
 * @throws Error mentioning "pin exactly" for a range, tag, protocol alias, other host or archive without a version.
 */
export function pinnedVersion(specifier: string): string {
  const version = exactVersion(specifier)
  if (version === undefined) throw new Error(notExact(specifier))
  return version
}

/**
 * List the `@vibedev-si/*` entries of a manifest's `dependencies`; only `dependencies` reach the installer.
 * @param manifest - Manifest path relative to the repository root, used in reports.
 * @param json - The parsed manifest file.
 * @returns The pins in declaration order.
 * @throws Error naming the manifest when it is not an object or `dependencies` is not a map of strings.
 */
export function bundledPluginPins(manifest: string, json: unknown): BundledPluginPin[] {
  if (!isRecord(json)) throw new Error(`${manifest}: not a package.json object`)
  const dependencies = json.dependencies
  if (dependencies === undefined) return []
  if (!isRecord(dependencies)) throw new Error(`${manifest}: dependencies must map package names to version strings`)
  const pins: BundledPluginPin[] = []
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (typeof specifier !== 'string') throw new Error(`${manifest}: dependencies must map package names to version strings (${name})`)
    if (name.startsWith(BUNDLED_PLUGIN_SCOPE)) pins.push({ manifest, name, specifier })
  }
  return pins
}

/**
 * Order two semantic versions by Semantic Versioning 2.0.0 precedence: build metadata is ignored and a prerelease
 * precedes its release.
 * @param left - A semantic version.
 * @param right - A semantic version.
 * @returns A negative number, zero or a positive number as `left` precedes, equals or follows `right`.
 * @throws Error when either argument is not a semantic version.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index++) {
    const order = compareNumeric(a.core[index] as string, b.core[index] as string)
    if (order !== 0) return order
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index++) {
    const order = compareIdentifier(a.prerelease[index] as string, b.prerelease[index] as string)
    if (order !== 0) return order
  }
  return a.prerelease.length - b.prerelease.length
}

/**
 * Decide whether one package may ship.
 * @param name - Package name.
 * @param pins - Every pin of that package across the bundled manifests.
 * @param latest - npm's `latest` for the package, or the failure to read it.
 * @returns The verdict; it fails for a pin that is not exact, differing pins, a pin other than npm latest, or no npm answer.
 */
export function bundledPluginVerdict(name: string, pins: readonly BundledPluginPin[], latest: NpmLatest): BundledPluginVerdict {
  const problems: string[] = []
  const pinned: { readonly manifest: string; readonly version: string }[] = []
  const inexact: string[] = []
  for (const pin of pins) {
    const version = exactVersion(pin.specifier)
    if (version === undefined) {
      problems.push(`${pin.manifest}: ${notExact(pin.specifier)}`)
      inexact.push(pin.specifier)
    } else {
      pinned.push({ manifest: pin.manifest, version })
    }
  }
  const versions = [...new Set(pinned.map(entry => entry.version))].sort(compareVersions)
  if (versions.length > 1) {
    problems.push(`pinned to different versions: ${pinned.map(entry => `${entry.version} in ${entry.manifest}`).join(', ')}`)
  }
  let latestVersion = 'unavailable'
  if ('error' in latest) {
    problems.push(`cannot read npm latest: ${latest.error}`)
  } else if (!SEMVER.test(latest.version)) {
    latestVersion = latest.version
    problems.push(`npm latest "${latest.version}" is not a semantic version`)
  } else {
    latestVersion = latest.version
    for (const version of versions) {
      const order = compareVersions(version, latest.version)
      if (order < 0) problems.push(`${version} is older than npm latest ${latest.version}; bump the pin`)
      if (order > 0) problems.push(`${version} is newer than npm latest ${latest.version}; publish it to npm first`)
    }
  }
  return { name, pinned: [...versions, ...inexact].join(', '), latest: latestVersion, ok: problems.length === 0, problems }
}

/**
 * Render one verdict as one report line.
 * @param verdict - The verdict to print.
 * @returns `<name>  pinned <versions>  npm latest <version>  OK`, or `FAIL: <problems>` in place of `OK`.
 */
export function formatBundledPluginVerdict(verdict: BundledPluginVerdict): string {
  return `${verdict.name}  pinned ${verdict.pinned}  npm latest ${verdict.latest}  ${
    verdict.ok ? 'OK' : `FAIL: ${verdict.problems.join('; ')}`}`
}

/**
 * The registry document of a package's `latest` dist-tag.
 * @param name - Package name, scoped or not.
 * @returns The registry.npmjs.org URL with the name URL-encoded.
 */
export function npmLatestUrl(name: string): string {
  return `${NPM_REGISTRY}/${encodeURIComponent(name)}/latest`
}

/**
 * Check every bundled VibeDev plugin of a repository checkout against npm and print one line per package.
 * @param root - Repository checkout whose manifests are checked.
 * @param write - Receives each report line.
 * @returns Whether every package passed.
 * @throws Error when a manifest cannot be read or parsed, or no manifest pins a `@vibedev-si/*` package.
 */
export async function checkBundledPlugins(root: string, write: (line: string) => void): Promise<boolean> {
  const pins: BundledPluginPin[] = []
  for (const manifest of BUNDLED_PLUGIN_MANIFESTS) {
    pins.push(...bundledPluginPins(manifest, JSON.parse(await readFile(join(root, manifest), 'utf8'))))
  }
  if (pins.length === 0) throw new Error(`bundled plugins: no ${BUNDLED_PLUGIN_SCOPE}* dependency in ${BUNDLED_PLUGIN_MANIFESTS.join(', ')}`)
  const names = [...new Set(pins.map(pin => pin.name))]
  const latest = await Promise.all(names.map(npmLatest))
  const verdicts = names.map((name, index) => bundledPluginVerdict(name, pins.filter(pin => pin.name === name), latest[index] as NpmLatest))
  for (const verdict of verdicts) write(formatBundledPluginVerdict(verdict))
  const failed = verdicts.filter(verdict => !verdict.ok).length
  write(failed === 0
    ? `bundled plugins: all ${verdicts.length} pinned to npm latest`
    : `bundled plugins: ${failed} of ${verdicts.length} FAIL; a desktop release must bundle npm latest of each`)
  return failed === 0
}

async function npmLatest(name: string): Promise<NpmLatest> {
  const url = npmLatestUrl(name)
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(NPM_TIMEOUT_MS) })
    if (!response.ok) return { error: `${url} answered HTTP ${response.status}` }
    const body: unknown = await response.json()
    if (!isRecord(body) || typeof body.version !== 'string') return { error: `${url} answered no version` }
    return { version: body.version }
  } catch (error) {
    // Network, timeout and JSON failures become a failing verdict for this package, never a pass.
    return { error: `${url}: ${describeError(error)}` }
  }
}

function exactVersion(specifier: string): string | undefined {
  if (SEMVER.test(specifier)) return specifier
  if (!URL.canParse(specifier)) return undefined
  const url = new URL(specifier)
  if (url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com' || url.search !== '' || url.hash !== '') return undefined
  const version = ARCHIVE_VERSION.exec(url.pathname.slice(url.pathname.lastIndexOf('/') + 1))?.[1]
  return version !== undefined && SEMVER.test(version) ? version : undefined
}

function notExact(specifier: string): string {
  return `"${specifier}" is not an exact pin; pin exactly: a version such as 0.1.15, `
    + 'or a raw.githubusercontent.com archive whose file name ends in -<version>.tgz'
}

function parseVersion(version: string): { readonly core: readonly string[]; readonly prerelease: readonly string[] } {
  const match = SEMVER.exec(version)
  if (match === null) throw new Error(`"${version}" is not a semantic version`)
  return { core: match.slice(1, 4) as string[], prerelease: match[4] === undefined ? [] : match[4].split('.') }
}

/** Compare digit strings without leading zeros (semver forbids them) exactly, at any length. */
function compareNumeric(left: string, right: string): number {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return compareNumeric(left, right)
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message
}

async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...argv], options: { root: { type: 'string' } }, allowPositionals: false })
  const root = resolve(values.root ?? join(import.meta.dirname, '..', '..', '..'))
  if (!await checkBundledPlugins(root, line => process.stdout.write(`${line}\n`))) process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
