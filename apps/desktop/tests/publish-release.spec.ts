import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { feedAssetFor, planReleasePublish, publishReleasePlan, releaseVersionFromTag } from '../scripts/publish-release.ts'
import type { GitHubAsset, ServerRemote } from '../scripts/upload-server.ts'

const PRODUCT = '0.2.1-alpha.2'
const VERSION = '0.2.1-alpha.2.20261013.4'
const TAG = `desktop-v${VERSION}`
/** electron-builder writes the payload digest as base64; the server's sha512sum answers hexadecimal. */
const PAYLOAD_HEX = 'a1'.repeat(64)
const PAYLOAD_BASE64 = Buffer.from(PAYLOAD_HEX, 'hex').toString('base64')

function asset(name: string, size = 1024, digest: string | null = `sha256:${'a'.repeat(64)}`): GitHubAsset {
  return { id: name.length, name, size, digest, state: 'uploaded' }
}

function feed(version: string, payload: string, path = true): string {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${payload}`,
    `    sha512: ${PAYLOAD_BASE64}`,
    '    size: 1024',
    ...path ? [`path: ${payload}`] : [],
    'releaseDate: \'2026-10-13T09:00:00.000Z\'',
    '',
  ].join('\n')
}

const WINDOWS_ASSETS = [
  asset(`vibedev-${VERSION}-win-x64.exe`, 283862214, `sha256:${'b'.repeat(64)}`),
  asset(`vibedev-${VERSION}-win-x64.exe.blockmap`, 295571, `sha256:${'c'.repeat(64)}`),
  asset('nightly.yml'),
]
const MAC_ASSETS = [
  asset(`vibedev-${VERSION}-mac-arm64.dmg`, 366582618, `sha256:${'d'.repeat(64)}`),
  asset(`vibedev-${VERSION}-mac-arm64.zip`, 356340863, `sha256:${'e'.repeat(64)}`),
  asset(`vibedev-${VERSION}-mac-arm64.zip.blockmap`, 300000, `sha256:${'f'.repeat(64)}`),
  asset('nightly-mac.yml'),
]

describe('releaseVersionFromTag', () => {
  it('reads the build version a release tag names', () => {
    expect(releaseVersionFromTag(TAG, PRODUCT)).toBe(VERSION)
  })

  it('refuses a tag that is not a desktop release tag', () => {
    expect(() => releaseVersionFromTag('v0.2.1', PRODUCT)).toThrow('not a desktop-v<version> tag')
    expect(() => releaseVersionFromTag('desktop-v9.9.9', PRODUCT)).toThrow('does not name a build of')
  })
})

describe('planReleasePublish', () => {
  it('publishes the Windows installer, its blockmap and the rewritten feed, feed last', () => {
    const plan = planReleasePublish({
      assets: WINDOWS_ASSETS, tag: TAG, productVersion: PRODUCT, target: 'win-x64',
      environment: 'production', latest: false, feedText: feed(VERSION, `vibedev-${VERSION}-win-x64.exe`),
    })
    expect(plan.steps.map(step => step.key)).toEqual([
      `dsh-desk/bin/win-x64/vibedev-${VERSION}-win-x64.exe`,
      `dsh-desk/bin/win-x64/vibedev-${VERSION}-win-x64.exe.blockmap`,
      'dsh-desk/feeds/win-x64/nightly.yml',
    ])
    expect(plan.steps.map(step => step.kind)).toEqual(['binary', 'binary', 'feed'])
    // electron-builder writes a relative payload name; below the feed directory it would 404.
    const rewritten = load(plan.steps[2]?.contents as string) as { files: { url: string; sha512: string }[]; path?: string }
    const payload = `https://download.vibedev.studio/dsh-desk/bin/win-x64/vibedev-${VERSION}-win-x64.exe`
    expect(rewritten.files[0]?.url).toBe(payload)
    expect(rewritten.path).toBe(payload)
    expect(rewritten.files[0]?.sha512).toBe(PAYLOAD_BASE64)
    // The feed's digest is the strongest check the server can make on the payload.
    expect(plan.steps[0]?.sha512).toBe(PAYLOAD_HEX)
    expect(plan.steps[0]?.sha256).toBe('b'.repeat(64))
  })

  it('publishes the DMG, the update ZIP, its blockmap and the mac feed', () => {
    const plan = planReleasePublish({
      assets: MAC_ASSETS, tag: TAG, productVersion: PRODUCT, target: 'mac-arm64',
      environment: 'production', latest: false, feedText: feed(VERSION, `vibedev-${VERSION}-mac-arm64.zip`),
    })
    expect(plan.steps.map(step => step.key)).toEqual([
      `dsh-desk/bin/mac-arm64/vibedev-${VERSION}-mac-arm64.dmg`,
      `dsh-desk/bin/mac-arm64/vibedev-${VERSION}-mac-arm64.zip`,
      `dsh-desk/bin/mac-arm64/vibedev-${VERSION}-mac-arm64.zip.blockmap`,
      'dsh-desk/feeds/mac-arm64/nightly-mac.yml',
    ])
    // macOS updates run through the ZIP, so that is the file the feed names.
    expect(plan.steps[1]?.sha512).toBe(PAYLOAD_HEX)
    expect(plan.steps[0]?.sha512).toBeUndefined()
  })

  it('names the fixed download after the platform when asked for it', () => {
    const windows = planReleasePublish({
      assets: WINDOWS_ASSETS, tag: TAG, productVersion: PRODUCT, target: 'win-x64',
      environment: 'production', latest: true, feedText: feed(VERSION, `vibedev-${VERSION}-win-x64.exe`),
    })
    expect(windows.latest).toEqual({
      key: 'desktop/dsh-latest-windows-x64.exe',
      source: `dsh-desk/bin/win-x64/vibedev-${VERSION}-win-x64.exe`,
    })
    const mac = planReleasePublish({
      assets: MAC_ASSETS, tag: TAG, productVersion: PRODUCT, target: 'mac-arm64',
      environment: 'production', latest: true, feedText: feed(VERSION, `vibedev-${VERSION}-mac-arm64.zip`),
    })
    expect(mac.latest).toEqual({
      key: 'desktop/dsh-latest-macos-arm64.dmg',
      source: `dsh-desk/bin/mac-arm64/vibedev-${VERSION}-mac-arm64.dmg`,
    })
  })

  it('also writes the stable feed name for a release that is not a prerelease', () => {
    const plan = planReleasePublish({
      assets: [asset('vibedev-0.3.0-win-x64.exe'), asset('vibedev-0.3.0-win-x64.exe.blockmap'), asset('nightly.yml')],
      tag: 'desktop-v0.3.0', productVersion: '0.3.0', target: 'win-x64',
      environment: 'production', latest: false, feedText: feed('0.3.0', 'vibedev-0.3.0-win-x64.exe'),
    })
    expect(plan.steps.map(step => step.key)).toContain('dsh-desk/feeds/win-x64/latest.yml')
  })

  it('refuses a release that is missing a file the target needs', () => {
    expect(() => planReleasePublish({
      assets: WINDOWS_ASSETS.filter(entry => !entry.name.endsWith('.blockmap')), tag: TAG, productVersion: PRODUCT,
      target: 'win-x64', environment: 'production', latest: false, feedText: feed(VERSION, `vibedev-${VERSION}-win-x64.exe`),
    })).toThrow(/has no .*\.blockmap; it holds/)
  })

  it('refuses a feed that describes a different payload', () => {
    expect(() => planReleasePublish({
      assets: WINDOWS_ASSETS, tag: TAG, productVersion: PRODUCT, target: 'win-x64',
      environment: 'production', latest: false, feedText: feed(VERSION, 'vibedev-other-win-x64.exe'),
    })).toThrow(/must reference vibedev-.*win-x64\.exe/)
  })

  it('refuses a feed whose version is not the release version', () => {
    expect(() => planReleasePublish({
      assets: WINDOWS_ASSETS, tag: TAG, productVersion: PRODUCT, target: 'win-x64',
      environment: 'production', latest: false, feedText: feed('0.2.1-alpha.2.20260101.1', `vibedev-${VERSION}-win-x64.exe`),
    })).toThrow(/holds version/)
  })
})

/** A server that records what was asked of it and answers the hash queries the publish makes. */
function fakeServer() {
  const hashes = new Map<string, string>()
  const fetched: string[] = []
  const copied: string[] = []
  const renamed: string[] = []
  const remote: ServerRemote = {
    ssh: async (command) => {
      const listed = /^(sha256|sha512)sum -- '(.+)'/.exec(command)
      if (listed !== null) return `${hashes.get(`${listed[1]}:${listed[2]}`) ?? ''}\n`
      const target = /mv -f -- '[^']+' '(.+)'/.exec(command)
      if (target !== null) { renamed.push(target[1] as string); return '' }
      return ''
    },
    copy: async (_local, _remotePath) => { copied.push(_remotePath) },
    fetch: async (url, remotePath) => { fetched.push(`${url} -> ${remotePath}`) },
  }
  return { remote, hashes, fetched, copied, renamed }
}

describe('feedAssetFor', () => {
  const macFeed = asset('mac-x64-nightly-mac.yml')
  const armFeed = asset('mac-arm64-nightly-mac.yml')

  it('picks the feed of the architecture being published from a two-architecture release', () => {
    expect(feedAssetFor([armFeed, macFeed], 'mac-x64', 'nightly-mac.yml')).toBe(macFeed)
    expect(feedAssetFor([armFeed, macFeed], 'mac-arm64', 'nightly-mac.yml')).toBe(armFeed)
  })

  it('accepts the plain feed name of a release published before the split', () => {
    const plain = asset('nightly.yml')
    expect(feedAssetFor([plain], 'win-x64', 'nightly.yml')).toBe(plain)
  })

  it('reports nothing when the release holds neither name', () => {
    expect(feedAssetFor([asset('vibedev-1-win-x64.exe')], 'win-x64', 'nightly.yml')).toBeUndefined()
  })
})

describe('publishReleasePlan', () => {
  const plan = () => planReleasePublish({
    assets: WINDOWS_ASSETS, tag: TAG, productVersion: PRODUCT, target: 'win-x64',
    environment: 'production', latest: true, feedText: feed(VERSION, `vibedev-${VERSION}-win-x64.exe`),
  })

  it('fetches every binary through GitHub and sends the feed last', async () => {
    const server = fakeServer()
    const order: string[] = []
    const result = await publishReleasePlan(plan(), {
      assets: WINDOWS_ASSETS, remote: server.remote, root: '/data/vibedev-download/public',
      downloadUrl: async (assetId) => { order.push(`url:${assetId}`); return `https://github.test/${assetId}` },
      say: () => {},
    })
    expect(order).toHaveLength(2)
    expect(result.uploaded).toEqual([
      `dsh-desk/bin/win-x64/vibedev-${VERSION}-win-x64.exe`,
      `dsh-desk/bin/win-x64/vibedev-${VERSION}-win-x64.exe.blockmap`,
      'dsh-desk/feeds/win-x64/nightly.yml',
      'desktop/dsh-latest-windows-x64.exe',
    ])
    expect(server.fetched).toHaveLength(2)
    expect(server.copied).toHaveLength(1)
    expect(server.copied[0]).toMatch(/nightly\.yml\.uploading-/)
  })

  it('leaves a file alone when the server already holds exactly those bytes', async () => {
    const server = fakeServer()
    const planValue = plan()
    server.hashes.set(`sha512:/data/vibedev-download/public/${planValue.steps[0]?.key}`, planValue.steps[0]?.sha512 as string)
    const result = await publishReleasePlan(planValue, {
      assets: WINDOWS_ASSETS, remote: server.remote, root: '/data/vibedev-download/public',
      downloadUrl: async () => 'https://github.test/x', say: () => {},
    })
    expect(result.unchanged).toEqual([planValue.steps[0]?.key])
    expect(result.uploaded).not.toContain(planValue.steps[0]?.key)
  })

  it('refuses to replace a versioned file that is already public with other bytes', async () => {
    const server = fakeServer()
    const planValue = plan()
    server.hashes.set(`sha512:/data/vibedev-download/public/${planValue.steps[0]?.key}`, '0'.repeat(128))
    await expect(publishReleasePlan(planValue, {
      assets: WINDOWS_ASSETS, remote: server.remote, root: '/data/vibedev-download/public',
      downloadUrl: async () => 'https://github.test/x', say: () => {},
    })).rejects.toThrow(/already public with different bytes/)
  })

  it('requires an absolute server root', async () => {
    await expect(publishReleasePlan(plan(), {
      assets: WINDOWS_ASSETS, remote: fakeServer().remote, root: 'data/download',
      downloadUrl: async () => 'https://github.test/x', say: () => {},
    })).rejects.toThrow(/root must be an absolute path/)
  })
})
