/** Select and copy the local npm tarball closures that supply Desktop dsh and its private Host. */

import { createHash } from 'node:crypto'
import {
  constants,
  copyFileSync,
  globSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as yaml from 'js-yaml'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  parseDesktopCorePackageSet,
  type DesktopCorePackageRecord,
} from '../src/core-package-set.ts'
import { capture } from '../../../scripts/release/process.ts'
import { tarballFiles } from '../../../scripts/release/tarball.ts'
import { resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const ACCOUNT_PACKAGE = '@vibedev-si/dsh-vibedev'
const ROOT_PACKAGES = [DSH_PACKAGE, DESKTOP_HOST_PACKAGE] as const
const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')

const REQUIRED_DEPENDENCY_SECTIONS = ['dependencies', 'peerDependencies'] as const
const OPTIONAL_DEPENDENCY_SECTION = 'optionalDependencies'

/** Packed package information needed to form the local Desktop closure. */
export interface PackedDesktopPackage {
  readonly tarball: string
  readonly manifest: Readonly<Record<string, unknown>>
}

function dependencyNames(manifest: Readonly<Record<string, unknown>>, section: string): string[] {
  const value = manifest[section]
  if (value === undefined) return []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`desktop package set: ${String(manifest.name)} has invalid ${section}`)
  }
  return Object.keys(value).sort()
}

/**
 * Select workspace dependencies rooted at dsh and its private Host; npm resolves external packages.
 * Reads the repository workspace manifest and package manifests to distinguish required local packages from npm-resolved externals.
 * @param available - Packed packages indexed by package name.
 * @returns Selected packages sorted by name.
 */
export function selectDesktopPackageClosure(
  available: ReadonlyMap<string, PackedDesktopPackage>,
): PackedDesktopPackage[] {
  const workspace = yaml.load(readFileSync(join(REPOSITORY_ROOT, 'pnpm-workspace.yaml'), 'utf8')) as { packages: string[] }
  const workspaceNames = new Set(globSync(workspace.packages.map(pattern => `${pattern}/package.json`), { cwd: REPOSITORY_ROOT })
    .map(path => (JSON.parse(readFileSync(join(REPOSITORY_ROOT, path), 'utf8')) as { name: string }).name))
  // The built-in account is independently versioned, but must ship from a verified local archive too.
  workspaceNames.add(ACCOUNT_PACKAGE)
  const selected = new Map<string, PackedDesktopPackage>()
  const visit = (name: string): void => {
    if (selected.has(name)) return
    const packed = available.get(name)
    if (packed === undefined) throw new Error(`desktop package set: packed inputs omit required package ${name}`)
    selected.set(name, packed)
    for (const section of REQUIRED_DEPENDENCY_SECTIONS) {
      for (const dependency of dependencyNames(packed.manifest, section)) {
        if (available.has(dependency)) visit(dependency)
        else if (workspaceNames.has(dependency)) {
          throw new Error(`desktop package set: ${name} requires unpacked package ${dependency}`)
        }
      }
    }
    for (const dependency of dependencyNames(packed.manifest, OPTIONAL_DEPENDENCY_SECTION)) {
      if (available.has(dependency)) visit(dependency)
    }
  }
  for (const name of ROOT_PACKAGES) {
    if (!available.has(name)) throw new Error(`desktop package set: packed inputs omit ${name}`)
    visit(name)
  }
  return [...selected.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, packed]) => packed)
}

function packedManifest(tarball: string): Record<string, unknown> {
  const value: unknown = JSON.parse(capture('tar', ['-xOzf', tarball, 'package/package.json']))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`desktop package set: ${tarball} has no package manifest`)
  }
  return value as Record<string, unknown>
}

function packedPackages(inputs: readonly string[]): Map<string, PackedDesktopPackage> {
  const available = new Map<string, PackedDesktopPackage>()
  for (const input of inputs) {
    const tarballs = readdirSync(input).filter(file => file.endsWith('.tgz')).sort()
    if (tarballs.length === 0) throw new Error(`desktop package set: ${input} contains no tarballs`)
    for (const file of tarballs) {
      const tarball = join(input, file)
      const manifest = packedManifest(tarball)
      const name = manifest.name
      if (typeof name !== 'string' || name === '') throw new Error(`desktop package set: ${tarball} has no package name`)
      if (available.has(name)) throw new Error(`desktop package set: duplicate packed package ${name}`)
      available.set(name, { tarball, manifest })
    }
  }
  return available
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Verify the checked-in account archive against the immutable source pin and lockfile before adding it to the local runtime.
 * @param available - Prepared archives indexed by package name.
 * @param specifier - The exact account dependency declared by the CLI anchor.
 * @param lockfile - Repository lockfile text containing its SHA-512 integrity.
 */
export function assertPinnedDesktopAccountPackage(
  available: ReadonlyMap<string, PackedDesktopPackage>,
  specifier: string,
  lockfile: string,
): void {
  const fixedArchive = new RegExp([
    '^https://raw\\.githubusercontent\\.com/VibeDev-Si/dsh-vibedev/[0-9a-f]{40}/bundled/',
    'vibedev-si-dsh-vibedev-[0-9A-Za-z.-]+\\.tgz$',
  ].join(''))
  if (!fixedArchive.test(specifier)) throw new Error('desktop package set: account source pin must be immutable')
  const packed = available.get(ACCOUNT_PACKAGE)
  if (packed === undefined) throw new Error('desktop package set: missing built-in account archive')
  const entry = record(record(record(yaml.load(lockfile))?.packages)?.[`${ACCOUNT_PACKAGE}@${specifier}`])
  const resolution = record(entry?.resolution)
  if (entry === undefined || resolution?.tarball !== specifier || typeof entry.version !== 'string') {
    throw new Error('desktop package set: account lockfile pin is missing or mismatched')
  }
  if (packed.manifest.name !== ACCOUNT_PACKAGE || packed.manifest.version !== entry.version
    || !specifier.endsWith(`/vibedev-si-dsh-vibedev-${entry.version}.tgz`)) {
    throw new Error('desktop package set: account archive identity does not match its pin')
  }
  const integrity = `sha512-${createHash('sha512').update(readFileSync(packed.tarball)).digest('base64')}`
  if (resolution.integrity !== integrity) throw new Error('desktop package set: account archive integrity mismatch')
}

/**
 * Require every private Host file used before the Desktop profile can pass its health check.
 * @param files - Tarball paths rooted at `package/`.
 * @returns Nothing.
 */
export function assertDesktopHostPackageFiles(files: readonly string[]): void {
  const available = new Set(files)
  const missing = DESKTOP_HOST_RUNTIME_FILES
    .map(file => `package/${file}`)
    .filter(file => !available.has(file))
  if (missing.length > 0) {
    throw new Error(`desktop package set: ${DESKTOP_HOST_PACKAGE} tarball omits required file(s): ${missing.join(', ')}`)
  }
}

/**
 * Prepare a package set from release tarball directories.
 * @param inputs - Build-owned directories of prepared package archives.
 * @param output - Build-owned package-set destination.
 * @param accountPin - Optional immutable account source and lockfile used by production Desktop packaging.
 */
export function prepareDesktopPackageSet(
  inputs: readonly string[],
  output: string,
  accountPin?: { readonly specifier: string; readonly lockfile: string },
): void {
  const available = packedPackages(inputs)
  if (accountPin !== undefined) assertPinnedDesktopAccountPackage(available, accountPin.specifier, accountPin.lockfile)
  const selected = selectDesktopPackageClosure(available)
  const host = selected.find(packed => packed.manifest.name === DESKTOP_HOST_PACKAGE)
  if (host === undefined) throw new Error(`desktop package set: selected closure omits ${DESKTOP_HOST_PACKAGE}`)
  assertDesktopHostPackageFiles(tarballFiles(host.tarball))
  rmSync(output, { recursive: true, force: true })
  const packageDir = join(output, DESKTOP_PACKAGES_DIR)
  mkdirSync(packageDir, { recursive: true })
  const records: DesktopCorePackageRecord[] = selected.map((packed) => {
    const name = packed.manifest.name
    const version = packed.manifest.version
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new Error(`desktop package set: ${packed.tarball} has no package identity`)
    }
    const file = basename(packed.tarball)
    const destination = join(packageDir, file)
    copyFileSync(packed.tarball, destination, constants.COPYFILE_EXCL)
    const body = readFileSync(destination)
    return {
      name,
      version,
      file,
      bytes: statSync(destination).size,
      integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
    }
  })
  const packageSet = parseDesktopCorePackageSet({ schemaVersion: 1, packages: records })
  writeFileSync(join(output, DESKTOP_PACKAGE_SET_FILE), `${JSON.stringify(packageSet, undefined, 2)}\n`, { mode: 0o600 })
}

function main(): void {
  const buildPaths = resolveDesktopTargetBuildPaths()
  const defaultInputs = [
    buildPaths.packedDsh,
    buildPaths.packedVendor,
    buildPaths.packedLandlock,
    join(APP_ROOT, 'resources', 'bundled-account'),
  ]
  const { values } = parseArgs({
    options: { from: { type: 'string', multiple: true }, out: { type: 'string' } },
    allowPositionals: false,
  })
  const inputs = (values.from ?? defaultInputs).map(path => resolve(REPOSITORY_ROOT, path))
  const output = values.out === undefined ? buildPaths.packageSet : resolve(REPOSITORY_ROOT, values.out)
  const cli = record(JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'apps/cli/package.json'), 'utf8')))
  const specifier = record(cli?.dependencies)?.[ACCOUNT_PACKAGE]
  if (typeof specifier !== 'string') throw new Error('desktop package set: CLI omits the built-in account pin')
  prepareDesktopPackageSet(inputs, output, {
    specifier, lockfile: readFileSync(join(REPOSITORY_ROOT, 'pnpm-lock.yaml'), 'utf8'),
  })
  console.log(`desktop package set: prepared ${output}`)
}

if (import.meta.main) main()
