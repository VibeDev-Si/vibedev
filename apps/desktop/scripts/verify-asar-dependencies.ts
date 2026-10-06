/** Verify that the application ASAR ships the production dependency closure of the Electron main process. */
import { join } from 'node:path'
import { readAsar, type AsarFilesystem, type Node } from 'app-builder-lib/out/asar/asar.js'

interface Manifest {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/**
 * Fail when a package in the archive declares a dependency that Node cannot resolve inside the archive.
 * electron-builder takes the closure from the package manager's dependency tree, which can leave a package
 * without its own dependencies, and the Host smoke never loads the main process, so nothing else notices.
 * @param archivePath - Application ASAR file.
 * @returns Resolves when every dependency, and every optional dependency that ships, resolves in the archive.
 */
export async function verifyAsarDependencies(archivePath: string): Promise<void> {
  const missing = await missingAsarDependencies(await readAsar(archivePath))
  if (missing.length > 0) throw new Error(`desktop app: app.asar lacks main-process dependencies: ${missing.join(', ')}`)
}

/**
 * Walk the archive root's production dependencies the way Node resolves them and list what does not resolve.
 * @param archive - Opened application ASAR.
 * @returns Each unresolved `requirer -> dependency` edge in walk order; the archive root is `app`.
 */
export async function missingAsarDependencies(archive: AsarFilesystem): Promise<string[]> {
  const missing: string[] = []
  const visited = new Set<string>()
  const queue = ['']
  for (let directory = queue.shift(); directory !== undefined; directory = queue.shift()) {
    if (visited.has(directory)) continue
    visited.add(directory)
    const manifest = await archive.readJson(join(...directory.split('/'), 'package.json')) as Manifest
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}))
    for (const name of [...Object.keys(manifest.dependencies ?? {}), ...optional]) {
      const found = resolvePackage(archive, directory, name)
      if (found !== undefined) queue.push(found)
      else if (!optional.has(name)) missing.push(`${directory === '' ? 'app' : directory} -> ${name}`)
    }
  }
  return missing
}

/** Node's lookup from a package directory: its own node_modules, then each enclosing package's, then the root's. */
function resolvePackage(archive: AsarFilesystem, from: string, name: string): string | undefined {
  for (let directory = from; ; directory = directory.slice(0, Math.max(directory.lastIndexOf('/node_modules/'), 0))) {
    const candidate = directory === '' ? `node_modules/${name}` : `${directory}/node_modules/${name}`
    if (entry(archive, `${candidate}/package.json`) !== undefined) return candidate
    if (directory === '') return undefined
  }
}

/** Header entry at a `/`-separated archive path; JSON headers are plain objects, so only own names count. */
function entry(archive: AsarFilesystem, path: string): Node | undefined {
  let node: Node | undefined = archive.header
  for (const part of path.split('/')) {
    const files: Record<string, Node> | undefined = node?.files
    node = files !== undefined && Object.hasOwn(files, part) ? files[part] : undefined
  }
  return node
}
