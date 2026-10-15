/** Finite recovery policy for Apple's ticket-delivery connection loss. */

/** Additional delays per ticket operation; exhausted operations remain failures. */
export const macOSTicketRetryDelays = Object.freeze([10_000, 30_000, 60_000, 120_000])

/**
 * Recognize Apple's machine-readable transport code in native ticket-tool output.
 * @param {number | null} status Native command exit status.
 * @param {string} output Combined diagnostic streams.
 * @returns {boolean} Whether this ticket operation can be repeated after connection loss.
 */
export function isMacOSTicketConnectionLost(status, output) {
  return status === 68 && /\bNSURLErrorDomain Code=-1005\b/u.test(output)
}
