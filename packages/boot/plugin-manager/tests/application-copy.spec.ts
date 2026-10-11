/** Updating an application-owned package in the profile, and returning to the shipped copy. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boot, initProfile, loadProfileDirectory, readProfileManifest, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import PluginManager from '../src/index.ts'
import * as operations from '../src/operations.ts'
import * as githubConnection from '../src/github-connection.ts'

const OWNED = '@vibedev-si/dsh-ecosystem'

function writePackage(dir: string, version: string, peers?: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: OWNED, version, dsh: { bundle: { patch: './cordis.patch.yml' } }, ...peers === undefined ? {} : { peerDependencies: peers },
  }))
  writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([{ insert: [] }]))
}

/** A profile whose installation ships the owned package at 0.1.12; `local` puts the profile's own copy beside it. */
async function fixture(local?: { version: string; selected?: boolean; peers?: Record<string, string> }) {
  const home = await realpath(mkdtempSync(join(tmpdir(), 'plugin-manager-owned-')))
  let owner: Context | undefined
  onTestFinished(async () => { await owner?.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  writeFileSync(anchor, JSON.stringify({ name: 'installation', dependencies: { [OWNED]: '0.1.12' } }))
  writePackage(join(home, 'node_modules', OWNED), '0.1.12')
  initProfile(dir, ['core'])
  const core = join(dir, 'node_modules', 'core')
  mkdirSync(core, { recursive: true })
  writeFileSync(join(core, 'package.json'), JSON.stringify({ name: 'core', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(core, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'manager', name: 'cordis:manager' }] }]))
  const manifest = readProfileManifest('test', dir)
  if (local !== undefined) {
    writePackage(join(dir, 'node_modules', OWNED), local.version, local.peers)
    manifest.dependencies = { [OWNED]: local.version }
    if (local.selected === true) manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: ['core', OWNED] } }
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: loadProfileDirectory('test', dir, anchor).layers.map(layer => layer.packageName),
    dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home,
    installationPlugins: [OWNED], overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    owner = ctx
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    ctx.provide('profileContext', profile)
    ctx.loader.builtins.manager = PluginManager
  })
  const registry = vi.spyOn(operations, 'readProfileRegistry').mockResolvedValue('https://registry.npmjs.org/')
  const connection = vi.spyOn(githubConnection, 'checkGithubConnection').mockResolvedValue(undefined)
  onTestFinished(() => { registry.mockRestore(); connection.mockRestore() })
  return { manager: ctx.pluginManager, dir }
}

it('reports the shipped copy as the floor and a newer compatible profile copy as the one selected', async () => {
  const shipped = await fixture()
  expect((await shipped.manager.listBundles()).find(row => row.name === OWNED)).toMatchObject({
    availability: 'installation', installed: false, removable: false, version: '0.1.12',
    application: { shipped: '0.1.12', selected: 'installation' },
  })
  const updated = await fixture({ version: '0.1.13' })
  expect((await updated.manager.listBundles()).find(row => row.name === OWNED)).toMatchObject({
    installed: true, removable: true, version: '0.1.13', application: { shipped: '0.1.12', local: '0.1.13', selected: 'profile' },
  })
  const leftover = await fixture({ version: '0.1.8' })
  expect((await leftover.manager.listBundles()).find(row => row.name === OWNED)).toMatchObject({
    installed: true, removable: true, version: '0.1.12',
    application: { shipped: '0.1.12', local: '0.1.8', selected: 'installation', reason: 'not-newer' },
  })
})

it('inspects only an exact version above the shipped one as an update of an application-owned package', async () => {
  const { manager, dir } = await fixture()
  const view = vi.spyOn(operations, 'viewProfilePackage').mockResolvedValue({
    exitCode: 0, stdout: JSON.stringify({ name: OWNED, version: '0.1.13', dsh: { bundle: { patch: './cordis.patch.yml' } } }), stderr: '', timedOut: false,
  })
  onTestFinished(() => { view.mockRestore() })
  for (const spec of [OWNED, `${OWNED}@0.1.12`, `${OWNED}@0.1.8`, `${OWNED}@^0.1.13`, `${OWNED}@latest`]) {
    expect(await manager.inspect(spec)).toMatchObject({ status: 'refused', problem: 'already-installed' })
  }
  expect(view).not.toHaveBeenCalled()
  expect(await manager.inspect(`${OWNED}@0.1.13`)).toMatchObject({ status: 'accepted', name: OWNED, version: '0.1.13', bundle: true })
  expect(view).toHaveBeenCalledWith(dir, `${OWNED}@0.1.13`, expect.anything())
})

it('installs the update into the profile without selecting it and asks for a restart', async () => {
  const { manager, dir } = await fixture()
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    writePackage(join(dir, 'node_modules', OWNED), '0.1.13')
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, [OWNED]: '0.1.13' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { pnpm.mockRestore() })
  expect(await manager.installBundle(`${OWNED}@0.1.13`, { saveExact: true })).toMatchObject({
    application: 'restart-required', bundle: OWNED, version: '0.1.13', changed: true,
  })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).not.toContain(OWNED)
  expect((await manager.listBundles()).find(row => row.name === OWNED)?.application).toMatchObject({ local: '0.1.13', selected: 'profile' })
})

it('refuses an update that the running dsh rejects and puts the profile back', async () => {
  const { manager, dir } = await fixture()
  const before = readProfileManifest('test', dir)
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    writePackage(join(dir, 'node_modules', OWNED), '0.1.13', { '@deepseek-ai/dsh': '>=999.0.0' })
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, [OWNED]: '0.1.13' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { pnpm.mockRestore() })
  expect(await manager.installBundle(`${OWNED}@0.1.13`)).toMatchObject({ application: 'failed', error: { code: 'incompatible-version' } })
  expect(readProfileManifest('test', dir).dependencies).toEqual(before.dependencies)
})

it('returns to the shipped copy by removing only the profile copy', async () => {
  const { manager, dir } = await fixture({ version: '0.1.13', selected: true })
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    rmSync(join(dir, 'node_modules', OWNED), { recursive: true, force: true })
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = {}
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'removed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { pnpm.mockRestore() })
  expect(await manager.removeBundle(OWNED)).toMatchObject({ application: 'restart-required', stage: 'remove', changed: true })
  expect(pnpm).toHaveBeenCalledWith(expect.anything(), ['remove', OWNED], expect.anything())
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core'])
  expect((await manager.listBundles()).find(row => row.name === OWNED)).toMatchObject({
    installed: false, removable: false, version: '0.1.12', application: { selected: 'installation' },
  })
  // With nothing of its own left, there is nothing to remove.
  expect(await manager.removeBundle(OWNED)).toMatchObject({ application: 'failed', error: { code: 'not-removable' } })
})
