/**
 * VibeDev fork: regenerate the brand assets from the VibeDev app icon.
 *
 * The mark is VibeDev Studio's `apps/web/public/logo.svg`: four nested cyan
 * chevrons on a #0a0c14 tile. The wordmark is "VibeDev" in Montserrat Medium,
 * the client's brand font (SIL Open Font License), outlined here at cap height
 * 100 so no font file is read. Run `node scripts/vibedev/brand-assets.mjs`,
 * then `pnpm run render:tray-icon` in `apps/desktop` to rebuild the tray icon
 * from the new Windows icon.
 */

import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const sharp = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('sharp')

/** The chevrons in Studio's 200-unit tile space, outermost first, with the icon's opacities. */
const CHEVRONS = [
  { d: 'M35 40L100 155L165 40L100 120Z', opacity: 0.12 },
  { d: 'M50 48L100 140L150 48L100 115Z', opacity: 0.3 },
  { d: 'M65 56L100 125L135 56L100 110Z', opacity: 0.6 },
  { d: 'M80 64L100 110L120 64L100 105Z', opacity: 1 },
]
const CYAN = '#00d4ff'
const TILE = '#0a0c14'
/** Studio draws the 200-unit mark at scale 2.22 on a 444 tile with rx 115. */
const TILE_RX = 115 / 2.22
/** "VibeDev" outlined from Montserrat Medium with its baseline at y 0 and cap height 100. */
const WORDMARK = 'M43.86 0L-0.14 -100L15.29 -100L55.71 -7.71L46.86 -7.71L87.57 -100L101.86 -100L58 0ZM112.71 0L112.71 -75.71L126.43 -75.71L126.43 0ZM119.57 -90.29Q115.57 -90.29 112.93 -92.86Q110.29 -95.43 110.29 -99.14Q110.29 -103 112.93 -105.57Q115.57 -108.14 119.57 -108.14Q123.57 -108.14 126.21 -105.64Q128.86 -103.14 128.86 -99.43Q128.86 -95.57 126.29 -92.93Q123.71 -90.29 119.57 -90.29ZM192.71 0.86Q183 0.86 175.21 -3.5Q167.43 -7.86 162.93 -16.43Q158.43 -25 158.43 -37.86Q158.43 -50.71 163.07 -59.29Q167.71 -67.86 175.5 -72.14Q183.29 -76.43 192.71 -76.43Q203.86 -76.43 212.43 -71.57Q221 -66.71 226 -58.07Q231 -49.43 231 -37.86Q231 -26.29 226 -17.57Q221 -8.86 212.43 -4Q203.86 0.86 192.71 0.86ZM152.57 0L152.57 -106L166.29 -106L166.29 -55.57L164.86 -38L165.71 -20.43L165.71 0ZM191.57 -11.14Q198.86 -11.14 204.64 -14.43Q210.43 -17.71 213.79 -23.79Q217.14 -29.86 217.14 -37.86Q217.14 -46 213.79 -51.93Q210.43 -57.86 204.64 -61.14Q198.86 -64.43 191.57 -64.43Q184.43 -64.43 178.64 -61.14Q172.86 -57.86 169.5 -51.93Q166.14 -46 166.14 -37.86Q166.14 -29.86 169.5 -23.79Q172.86 -17.71 178.64 -14.43Q184.43 -11.14 191.57 -11.14ZM283.71 0.86Q271.57 0.86 262.36 -4.14Q253.14 -9.14 248.07 -17.86Q243 -26.57 243 -37.86Q243 -49.14 247.93 -57.86Q252.86 -66.57 261.5 -71.5Q270.14 -76.43 281 -76.43Q292 -76.43 300.43 -71.57Q308.86 -66.71 313.64 -57.93Q318.43 -49.14 318.43 -37.43Q318.43 -36.57 318.36 -35.43Q318.29 -34.29 318.14 -33.29L253.71 -33.29L253.71 -43.14L311 -43.14L305.43 -39.71Q305.57 -47 302.43 -52.71Q299.29 -58.43 293.79 -61.64Q288.29 -64.86 281 -64.86Q273.86 -64.86 268.29 -61.64Q262.71 -58.43 259.57 -52.64Q256.43 -46.86 256.43 -39.43L256.43 -37.14Q256.43 -29.57 259.93 -23.64Q263.43 -17.71 269.71 -14.43Q276 -11.14 284.14 -11.14Q290.86 -11.14 296.36 -13.43Q301.86 -15.71 306 -20.29L313.57 -11.43Q308.43 -5.43 300.79 -2.29Q293.14 0.86 283.71 0.86ZM339.43 0L339.43 -100L381.57 -100Q397.57 -100 409.79 -93.71Q422 -87.43 428.79 -76.14Q435.57 -64.86 435.57 -50Q435.57 -35.14 428.79 -23.86Q422 -12.57 409.79 -6.29Q397.57 0 381.57 0ZM353.71 -12.43L380.71 -12.43Q393.14 -12.43 402.21 -17.14Q411.29 -21.86 416.29 -30.36Q421.29 -38.86 421.29 -50Q421.29 -61.29 416.29 -69.71Q411.29 -78.14 402.21 -82.86Q393.14 -87.57 380.71 -87.57L353.71 -87.57ZM489.14 0.86Q477 0.86 467.79 -4.14Q458.57 -9.14 453.5 -17.86Q448.43 -26.57 448.43 -37.86Q448.43 -49.14 453.36 -57.86Q458.29 -66.57 466.93 -71.5Q475.57 -76.43 486.43 -76.43Q497.43 -76.43 505.86 -71.57Q514.29 -66.71 519.07 -57.93Q523.86 -49.14 523.86 -37.43Q523.86 -36.57 523.79 -35.43Q523.71 -34.29 523.57 -33.29L459.14 -33.29L459.14 -43.14L516.43 -43.14L510.86 -39.71Q511 -47 507.86 -52.71Q504.71 -58.43 499.21 -61.64Q493.71 -64.86 486.43 -64.86Q479.29 -64.86 473.71 -61.64Q468.14 -58.43 465 -52.64Q461.86 -46.86 461.86 -39.43L461.86 -37.14Q461.86 -29.57 465.36 -23.64Q468.86 -17.71 475.14 -14.43Q481.43 -11.14 489.57 -11.14Q496.29 -11.14 501.79 -13.43Q507.29 -15.71 511.43 -20.29L519 -11.43Q513.86 -5.43 506.21 -2.29Q498.57 0.86 489.14 0.86ZM561.29 0L528.14 -75.71L542.43 -75.71L571.86 -7.14L565 -7.14L595 -75.71L608.43 -75.71L575.29 0Z'
const WORDMARK_WIDTH = 608.29

const fmt = value => Number(value.toFixed(3)).toString()
const out = path => fileURLToPath(new URL(`../../${path}`, import.meta.url))

function chevrons({ x = 0, y = 0, scale = 1, fill = CYAN, opacities = CHEVRONS.map(chevron => chevron.opacity), id } = {}) {
  const paths = CHEVRONS.map((chevron, index) => `<path d="${chevron.d}" fill="${fill}" fill-opacity="${fmt(opacities[index])}"/>`).join('')
  const placed = `<g transform="translate(${fmt(x)} ${fmt(y)}) scale(${fmt(scale)})">${paths}</g>`
  // The tray renderer adds its own transform to the tray-glyph group, so that group wraps the placement.
  return id === undefined ? placed : `<g id="${id}">${placed}</g>`
}

function tile({ x = 0, y = 0, edge, glyphId }) {
  const scale = edge / 200
  return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(edge)}" height="${fmt(edge)}" rx="${fmt(TILE_RX * scale)}" fill="${TILE}"/>`
    + chevrons({ x, y, scale, id: glyphId })
}

function wordmark({ x, baseline, capHeight, fill }) {
  const scale = capHeight / 100
  return { svg: `<path transform="translate(${fmt(x)} ${fmt(baseline)}) scale(${fmt(scale)})" d="${WORDMARK}" fill="${fill}"/>`, width: WORDMARK_WIDTH * scale }
}

const svg = (width, height, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}" fill="none">${body}</svg>\n`

async function png(source, path, width, height = width, flatten) {
  const edge = Number(/width="([\d.]+)"/.exec(source)[1])
  let image = sharp(Buffer.from(source), { density: 72 * width / edge }).resize(width, height)
  if (flatten !== undefined) image = image.flatten({ background: flatten })
  await image.png({ compressionLevel: 9 }).toFile(out(path))
}

// Application icons: Studio's full-bleed tile for Windows and the designer original; Apple's 824 grid with a shadow for macOS.
const fullBleed = svg(1024, 1024, tile({ edge: 1024, glyphId: 'tray-glyph' }))
for (const name of ['icon', 'icon-windows']) {
  writeFileSync(out(`apps/desktop/resources/${name}.svg`), fullBleed)
  await png(fullBleed, `apps/desktop/resources/${name}.png`, 1024)
}
const macIcon = svg(1024, 1024, '<defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="125%"><feGaussianBlur stdDeviation="14"/></filter></defs>'
  + `<rect x="100" y="112" width="824" height="824" rx="${fmt(TILE_RX * 824 / 200)}" fill="#000" fill-opacity="0.28" filter="url(#shadow)"/>`
  + tile({ x: 100, y: 100, edge: 824 }))
writeFileSync(out('apps/desktop/resources/icon-macos.svg'), macIcon)
await png(macIcon, 'apps/desktop/resources/icon-macos.png', 1024)

// Installer pages: the tile over the wordmark; preparation flattens onto white or rgb(21, 21, 23).
for (const [suffix, ink] of [['', '#0f1115'], ['-dark', '#f9fafb']]) {
  const width = wordmark({ x: 0, baseline: 0, capHeight: 21, fill: ink }).width
  const page = svg(600, 196, tile({ x: 244, y: 6, edge: 112 }) + wordmark({ x: (600 - width) / 2, baseline: 184, capHeight: 21, fill: ink }).svg)
  await png(page, `apps/desktop/installer/assets/brand${suffix}.png`, 600, 196)
  await png(page, `apps/desktop/installer/assets/brand${suffix}-2x.png`, 1200, 392)
}
await png(svg(164, 314, '<rect width="164" height="314" fill="#f4f5f7"/><rect x="22" y="97" width="120" height="120" rx="14" fill="#ffffff"/>'
  + tile({ x: 42, y: 117, edge: 80 })), 'apps/desktop/installer/assets/uninstaller-sidebar.png', 164, 314, '#f4f5f7')

// Welcome lockup, 40 units tall, its text following the page's light and dark ink.
{
  const text = wordmark({ x: 54, baseline: 31, capHeight: 22, fill: 'var(--dsw-alias-label-primary)' })
  const style = '<style>:root{--dsw-alias-label-primary:#0f1115}@media (prefers-color-scheme: dark){:root{--dsw-alias-label-primary:#f9fafb}}</style>'
  writeFileSync(out('apps/desktop/renderer/assets/welcome-brand.svg'), svg(Math.ceil(55 + text.width), 40, style + tile({ edge: 40 }) + text.svg))
}

// First-run onboarding artwork: the tile in a soft cyan glow until the account flow gets its own screens.
// The welcome canvas bleeds off the window's right edge, so the tile sits left of center; the credit tile wears a "+" badge.
{
  const art = ({ width, height, cx, cy, edge, glow, shadow, badge }) => {
    const x = cx - edge / 2
    const y = cy - edge / 2
    const badgeX = x + edge * 0.92
    const badgeY = y + edge * 0.92
    const radius = edge * 0.17
    const bar = radius * 0.94
    const thickness = radius * 0.22
    return svg(width, height, '<defs>'
      + `<radialGradient id="glow"><stop offset="0" stop-color="${CYAN}" stop-opacity="${glow}"/><stop offset="1" stop-color="${CYAN}" stop-opacity="0"/></radialGradient>`
      + `<filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur stdDeviation="${fmt(edge * 0.045)}"/></filter></defs>`
      + `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(edge * 0.95)}" fill="url(#glow)"/>`
      + `<rect x="${fmt(x)}" y="${fmt(y + edge * 0.03)}" width="${fmt(edge)}" height="${fmt(edge)}" rx="${fmt(TILE_RX * edge / 200)}" fill="#000" fill-opacity="${shadow}" filter="url(#shadow)"/>`
      + tile({ x, y, edge })
      + (badge
        ? `<circle cx="${fmt(badgeX)}" cy="${fmt(badgeY)}" r="${fmt(radius)}" fill="${CYAN}"/>`
          + `<rect x="${fmt(badgeX - bar / 2)}" y="${fmt(badgeY - thickness / 2)}" width="${fmt(bar)}" height="${fmt(thickness)}" rx="${fmt(thickness / 2)}" fill="${TILE}"/>`
          + `<rect x="${fmt(badgeX - thickness / 2)}" y="${fmt(badgeY - bar / 2)}" width="${fmt(thickness)}" height="${fmt(bar)}" rx="${fmt(thickness / 2)}" fill="${TILE}"/>`
        : ''))
  }
  const assets = 'packages/client/ui-settings-account/src/client/assets'
  for (const [suffix, glow, shadow] of [['', 0.2, 0.22], ['-dark', 0.28, 0.5]]) {
    const welcome = art({ width: 3993, height: 2481, cx: 1500, cy: 1240, edge: 1300, glow, shadow, badge: false })
    const credit = art({ width: 1785, height: 1530, cx: 860, cy: 735, edge: 960, glow, shadow, badge: true })
    for (const locale of ['', '-zh']) {
      await png(welcome, `${assets}/onboarding-welcome${locale}${suffix}.png`, 3993, 2481)
      await png(credit, `${assets}/onboarding-recharge${locale}${suffix}.png`, 1785, 1530)
    }
  }
}

// Web favicons and the manifest icon.
for (const name of ['favicon', 'favicon-dark']) writeFileSync(out(`apps/web/public/${name}.svg`), svg(64, 64, tile({ edge: 64 })))

// Running status mask: a 28 px gray+alpha APNG of sixty 50 ms frames, a light wave running out from the innermost chevron.
{
  const edge = 28
  const count = 60
  const scale = 26 / 130
  const x = 1 - 35 * scale
  const y = (edge - 115 * scale) / 2 - 40 * scale
  const bump = distance => Math.abs(distance) < 0.5 ? Math.cos(Math.PI * distance) ** 2 : 0
  const chunk = (type, body) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed) >>> 0)
    return Buffer.concat([length, typed, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(edge, 0)
  header.writeUInt32BE(edge, 4)
  header[8] = 8
  header[9] = 4
  const control = Buffer.alloc(8)
  control.writeUInt32BE(count, 0)
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('acTL', control)]
  let sequence = 0
  for (let frame = 0; frame < count; frame++) {
    const phase = frame / count
    const opacities = CHEVRONS.map((chevron, index) => {
      const distance = Math.abs(phase - (3 - index) * 0.17)
      return chevron.opacity + (1 - chevron.opacity) * bump(Math.min(distance, 1 - distance) / 0.42)
    })
    const { data } = await sharp(Buffer.from(svg(edge, edge, chevrons({ x, y, scale, fill: '#000000', opacities }))), { density: 72 })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const rows = Buffer.alloc((edge * 2 + 1) * edge)
    for (let pixel = 0; pixel < edge * edge; pixel++) rows[Math.floor(pixel / edge) * (edge * 2 + 1) + 1 + (pixel % edge) * 2 + 1] = data[pixel * 4 + 3]
    const frameControl = Buffer.alloc(26)
    frameControl.writeUInt32BE(sequence++, 0)
    frameControl.writeUInt32BE(edge, 4)
    frameControl.writeUInt32BE(edge, 8)
    frameControl.writeUInt16BE(1, 20)
    frameControl.writeUInt16BE(20, 22)
    parts.push(chunk('fcTL', frameControl))
    const compressed = deflateSync(rows, { level: 9 })
    if (frame === 0) parts.push(chunk('IDAT', compressed))
    else {
      const number = Buffer.alloc(4)
      number.writeUInt32BE(sequence++)
      parts.push(chunk('fdAT', Buffer.concat([number, compressed])))
    }
  }
  parts.push(chunk('IEND', Buffer.alloc(0)))
  writeFileSync(out('packages/client/ui-chat/src/client/chat/running-whale@2x.png'), Buffer.concat(parts))
}

console.info('brand assets: written; run `pnpm run render:tray-icon` in apps/desktop next')
