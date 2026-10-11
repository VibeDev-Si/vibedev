/**
 * Which copy of an application-owned plugin a profile runs.
 *
 * An application may ship plugins it owns (`installationPlugins`). The shipped copy is the floor: a profile copy left
 * behind by an earlier installation never replaces it. A profile copy the user installed later replaces it only when it
 * is strictly newer and compatible with the running dsh, so the owner can publish a plugin update without shipping a new
 * application, and a newer application release takes over again from an older update.
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import semver from 'semver'
import { evaluatePluginCompatibility } from './plugin-compatibility.ts'
import { readProfileVersionExemptions } from './profile-compatibility.ts'

/** The two copies of one application-owned plugin, and the one a process starting now selects. */
export interface ApplicationCopy {
  /** Package name. */
  readonly name: string
  /** Version in the application installation; undefined when the installation does not carry the package. */
  readonly shipped: string | undefined
  /** Version of the copy the profile declares and holds in its own `node_modules`, if any. */
  readonly local?: string
  /** `profile` only for a strictly newer, compatible local copy; the shipped copy otherwise. */
  readonly selected: 'installation' | 'profile'
  /** Why a present local copy is not selected. */
  readonly reason?: 'not-newer' | 'incompatible' | 'unreadable'
}

/** Read a package manifest, or undefined when it is absent or not JSON. */
function manifestAt(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The installation's copy: Node's lookup from the installation manifest. */
function shippedManifest(name: string, installAnchor: string): Record<string, unknown> | undefined {
  /* v8 ignore next -- resolve.paths answers null only for builtins, which no plugin name is */
  for (const searchPath of createRequire(installAnchor).resolve.paths(name) ?? []) {
    const manifest = manifestAt(join(searchPath, name, 'package.json'))
    if (manifest !== undefined) return manifest
  }
  return undefined
}

/**
 * Decide which copy of an application-owned plugin runs in a profile. Only the profile's own direct dependency counts
 * as its copy: a package further up the directory tree is not something the user installed into this profile.
 * @param name - application-owned package name.
 * @param installAnchor - the running application's dsh package.json.
 * @param profileDir - the profile directory.
 * @param exemptions - exact plugin version exemptions; defaults to the profile's own.
 * @returns both versions and the selected copy; never throws for an unreadable local copy.
 */
export function applicationCopyOf(
  name: string, installAnchor: string, profileDir: string,
  exemptions?: Readonly<Record<string, readonly string[]>>,
): ApplicationCopy {
  const shippedVersion = shippedManifest(name, installAnchor)?.version
  const shipped = typeof shippedVersion === 'string' ? shippedVersion : undefined
  const declared = manifestAt(join(profileDir, 'package.json'))?.dependencies
  if (typeof declared !== 'object' || declared === null || !Object.hasOwn(declared, name)) return { name, shipped, selected: 'installation' }
  const localManifest = manifestAt(join(profileDir, 'node_modules', name, 'package.json'))
  if (localManifest === undefined) return { name, shipped, selected: 'installation' }
  const local = typeof localManifest.version === 'string' ? localManifest.version : undefined
  if (localManifest.name !== name || local === undefined || semver.valid(local) === null) {
    return { name, shipped, ...local === undefined ? {} : { local }, selected: 'installation', reason: 'unreadable' }
  }
  if (shipped !== undefined && semver.valid(shipped) !== null && !semver.gt(local, shipped)) {
    return { name, shipped, local, selected: 'installation', reason: 'not-newer' }
  }
  try {
    const compatibility = evaluatePluginCompatibility(localManifest, exemptions ?? readProfileVersionExemptions(profileDir))
    if (compatibility !== undefined && !compatibility.exempted) return { name, shipped, local, selected: 'installation', reason: 'incompatible' }
  } catch {
    return { name, shipped, local, selected: 'installation', reason: 'unreadable' }
  }
  return { name, shipped, local, selected: 'profile' }
}
