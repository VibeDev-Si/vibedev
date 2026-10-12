/** Mount the local React renderer before Electron reveals the welcome window. */
import '@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/gradient-shadow-text.css'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Welcome } from './WelcomePage.tsx'
import type { WelcomeApi } from '../welcome-api.ts'

declare global {
  interface Window {
    dshWelcome: WelcomeApi
  }
}

// VibeDev fork: without a native material (Windows before 11 22H2) the surface is opaque; see welcome.css.
document.documentElement.toggleAttribute('data-opaque-backdrop', window.dshWelcome.opaqueBackdrop === true)

const palette = window.matchMedia('(prefers-color-scheme: dark)')
const syncPalette = (): void => { document.body.toggleAttribute('data-ds-dark-theme', palette.matches) }
syncPalette()
palette.addEventListener('change', syncPalette)
window.addEventListener('pagehide', () => { palette.removeEventListener('change', syncPalette) }, { once: true })

const container = document.getElementById('root')
if (container === null) throw new Error('desktop welcome: missing React root')
const root = createRoot(container)
flushSync(() => { root.render(<Welcome api={window.dshWelcome} />) })
window.addEventListener('pagehide', () => { root.unmount() }, { once: true })
