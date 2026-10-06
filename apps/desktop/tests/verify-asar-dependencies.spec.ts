import type { WriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { finished } from 'node:stream/promises'
import { readAsar } from 'app-builder-lib/out/asar/asar.js'
import { afterEach, describe, expect, it } from 'vitest'
import { missingAsarDependencies, verifyAsarDependencies } from '../scripts/verify-asar-dependencies.ts'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const { createPackageWithOptions, uncache } = builderRequire('@electron/asar') as {
  createPackageWithOptions: (source: string, destination: string, options: { unpack?: string }) => Promise<WriteStream>
  uncache: (archive: string) => boolean
}

type Manifests = Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Pack one package.json per directory (`''` is the archive root) into a fresh app.asar. */
async function pack(manifests: Manifests, unpack?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-asar-dependencies-'))
  roots.push(root)
  const source = join(root, 'app')
  for (const [directory, manifest] of Object.entries(manifests)) {
    const file = join(source, ...directory.split('/').filter(Boolean), 'package.json')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ name: directory.split('node_modules/').at(-1) || 'app', version: '1.0.0', ...manifest }))
  }
  const archive = join(root, 'app.asar')
  // ASAR 3 returns the output stream after end(), before its writes finish.
  await finished(await createPackageWithOptions(source, archive, unpack === undefined ? {} : { unpack }), { cleanup: true })
  uncache(archive)
  return archive
}

describe('app.asar dependency closure', () => {
  it('resolves through a package\'s own node_modules and every enclosing one, and skips optional packages that do not ship', async () => {
    const archive = await pack({
      '': { dependencies: { a: '1', '@scope/b': '1' }, optionalDependencies: { 'platform-only': '1' } },
      'node_modules/a': { dependencies: { nested: '1', shared: '1' } },
      'node_modules/a/node_modules/nested': { dependencies: { shared: '1' } },
      'node_modules/@scope/b': { dependencies: { shared: '1' }, optionalDependencies: { a: '1' } },
      'node_modules/shared': {},
    })
    expect(await missingAsarDependencies(await readAsar(archive))).toEqual([])
    await expect(verifyAsarDependencies(archive)).resolves.toBeUndefined()
  })

  it('reports each declared dependency Node could not load, including one only a sibling ships', async () => {
    const archive = await pack({
      '': { dependencies: { cordis: '1', gone: '1', constructor: '1' } },
      'node_modules/cordis': { dependencies: { cosmokit: '1', '@standard-schema/spec': '1' } },
      'node_modules/other': {},
      'node_modules/other/node_modules/cosmokit': {},
    })
    expect(await missingAsarDependencies(await readAsar(archive))).toEqual([
      'app -> gone',
      'app -> constructor',
      'node_modules/cordis -> cosmokit',
      'node_modules/cordis -> @standard-schema/spec',
    ])
    await expect(verifyAsarDependencies(archive)).rejects.toThrow(
      'desktop app: app.asar lacks main-process dependencies: app -> gone, app -> constructor, node_modules/cordis -> cosmokit')
  })

  it('reads manifests of unpacked packages', async () => {
    const archive = await pack({
      '': { dependencies: { native: '1' } },
      'node_modules/native': { dependencies: { helper: '1' } },
      'node_modules/helper': {},
    }, '**/node_modules/native/**')
    expect((await readAsar(archive)).getFile(join('node_modules', 'native', 'package.json')).unpacked).toBe(true)
    expect(await missingAsarDependencies(await readAsar(archive))).toEqual([])
  })
})
