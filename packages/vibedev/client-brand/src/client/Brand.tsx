import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * The four nested chevrons of the VibeDev app icon (VibeDev Studio's
 * `logo.svg`), outermost first, with the icon's own opacities.
 */
const CHEVRONS = [
  { d: 'M35 40L100 155L165 40L100 120Z', opacity: 0.12 },
  { d: 'M50 48L100 140L150 48L100 115Z', opacity: 0.3 },
  { d: 'M65 56L100 125L135 56L100 110Z', opacity: 0.6 },
  { d: 'M80 64L100 110L120 64L100 105Z', opacity: 1 },
] as const

/**
 * The VibeDev mark without its tile. It paints with `currentColor`, so it
 * reads as ink in light themes and as the theme's text color in dark ones.
 */
function VibeDevGlyph({ size, className }: { size: number; className?: string | undefined }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="30 27.5 140 140"
      fill="none"
      role="img"
      aria-label="VibeDev"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      {CHEVRONS.map(chevron => <path key={chevron.d} d={chevron.d} fill="currentColor" fillOpacity={chevron.opacity} />)}
    </svg>
  )
}

/**
 * Sidebar mark at the size the sidebar asks for.
 * @param props - Host-supplied mark presentation.
 * @returns the VibeDev glyph.
 */
export function VibeDevBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <VibeDevGlyph size={size} />
}

/**
 * Sidebar name beside the mark, in the client's brand font (Montserrat), as on the welcome page and installer.
 * @returns the VibeDev wordmark as text.
 */
export function VibeDevBrandName() {
  return (
    <span style={{ fontFamily: 'var(--dsw-font-family-brand)', fontWeight: 500, fontSize: 16, letterSpacing: '0.01em' }}>
      VibeDev
    </span>
  )
}

/**
 * Mark before the blank-session headline, replacing the animated fish.
 * @param props - Host-supplied size and geometry class.
 * @returns the VibeDev glyph.
 */
export function VibeDevHeroMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <VibeDevGlyph size={size} className={className} />
}
