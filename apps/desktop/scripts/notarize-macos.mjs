/** Preserve signature checks and Apple acceptance; recover bounded ticket-fetch interruptions. */
import { execFile } from 'node:child_process'
import { basename, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { notarize } from '@electron/notarize'
import { packagingStep } from './packaging-step.mjs'
import { isMacOSTicketConnectionLost, macOSTicketRetryDelays } from './macos-ticket-recovery.mjs'

const execute = promisify(execFile)

/** @param {unknown} error External command or library failure. @returns {string} Available diagnostics. */
function diagnostics(error) {
  let text = error instanceof Error ? error.message : String(error)
  if (error !== null && typeof error === 'object') {
    if ('stdout' in error && typeof error.stdout === 'string') text += `\n${error.stdout}`
    if ('stderr' in error && typeof error.stderr === 'string') text += `\n${error.stderr}`
  }
  return text
}

/**
 * Decode the foreign library's phase/exit-code envelope and Apple's NSURLErrorDomain code.
 * @param {unknown} error External failure.
 * @param {boolean} directCommand Whether this came directly from our stapler command.
 * @returns {'connection-lost' | undefined} Recognized safe-to-repeat ticket-fetch failure.
 */
function stapleFailure(error, directCommand) {
  const text = diagnostics(error)
  if (directCommand) {
    if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 68) return
  } else if (!/^Failed to staple your application with code: 68\b/u.test(text)) return
  if (isMacOSTicketConnectionLost(68, text)) return 'connection-lost'
}

/** @param {string} appPath Signed App or DMG. @returns {Promise<void>} Successful ticket stapling. */
async function staple(appPath) {
  await execute('/usr/bin/xcrun', ['stapler', 'staple', '-v', basename(appPath)], {
    cwd: dirname(appPath), timeout: 120_000, maxBuffer: 1024 * 1024,
  })
}

/**
 * Notarize one App or DMG; retry only an accepted artifact's interrupted staple request.
 * Signature, submission and unrecognized errors fail immediately. Exhausted recovery remains a failure.
 * Callers retain ownership of the artifact and must qualify its signature and ticket before promotion.
 * @param {import('@electron/notarize').NotarizeOptions} options Validated credentials and appPath.
 * @param {{ staple?: (appPath: string) => Promise<void>, wait?: (milliseconds: number) => Promise<void> }} [operations] Apple-tool and clock adapters.
 * @returns {Promise<void>} Resolves after Apple acceptance and successful stapling.
 */
export async function notarizeMacOS(options, operations = {}) {
  const secrets = Object.entries(options).filter(([name]) => /password|key|appleId/iu.test(name)).map(([, value]) => String(value))
  const stapleArtifact = operations.staple ?? staple
  const wait = operations.wait ?? delay
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'notarize-and-staple', async () => {
    try {
      await notarize({ ...options, notarytoolPath: fileURLToPath(new URL('./logged-notarytool.mjs', import.meta.url)) })
      return
    } catch (error) {
      if (stapleFailure(error, false) !== 'connection-lost') throw error
    }
    for (const [index, milliseconds] of macOSTicketRetryDelays.entries()) {
      console.warn(`desktop macOS notarization: ${basename(options.appPath)} ticket connection lost; staple retry ${index + 1}/${macOSTicketRetryDelays.length} in ${milliseconds}ms`)
      await wait(milliseconds)
      try {
        await stapleArtifact(options.appPath)
        return
      } catch (error) {
        if (stapleFailure(error, true) !== 'connection-lost') throw error
        if (index === macOSTicketRetryDelays.length - 1) {
          throw new Error(`desktop macOS notarization: ticket stapling recovery exhausted for ${basename(options.appPath)}\n${diagnostics(error)}`, { cause: error })
        }
      }
    }
  }, secrets)
}
