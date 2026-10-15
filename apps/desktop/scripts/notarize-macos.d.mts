/** Notarize signed artifacts and recover bounded Apple ticket-fetch interruptions. */
import type { MacOSNotarizationEnvironment } from './desktop-release-environment.mjs'
/**
 * Notarize and staple an App or DMG through the measured notarytool adapter.
 * Only an accepted artifact's interrupted ticket download is retried; other failures remain fatal.
 * @param options Validated Apple credentials and artifact path.
 * @param operations Apple-tool and clock adapters for the owning packaging operation.
 * @returns Resolves after acceptance and stapling; exhausted recovery remains a journaled failure.
 */
export function notarizeMacOS(
  options: MacOSNotarizationEnvironment & { appPath: string },
  operations?: {
    staple?: (appPath: string) => Promise<void>
    wait?: (milliseconds: number) => Promise<void>
  },
): Promise<void>
