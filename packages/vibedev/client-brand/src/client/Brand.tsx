import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * The VibeDev glyph: the serif "V" the current VibeDev app ships as
 * brand-icon.svg. It paints with `currentColor`, so it reads as ink in light
 * themes and as the theme's text color in dark ones.
 */
function VibeDevGlyph({ size, className }: { size: number; className?: string | undefined }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 444 444"
      fill="none"
      role="img"
      aria-label="VibeDev"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <text
        x="222"
        y="320"
        textAnchor="middle"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontSize="300"
        fontWeight="800"
        fill="currentColor"
      >
        V
      </text>
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
 * Sidebar name beside the mark.
 * @returns the VibeDev wordmark as text.
 */
export function VibeDevBrandName() {
  return (
    <span style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 700, fontSize: 16, letterSpacing: '0.01em' }}>
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
