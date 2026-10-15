/** Additional bounded delays for each Apple ticket operation. */
export const macOSTicketRetryDelays: readonly number[]

/**
 * Recognize Apple's ticket-delivery connection loss from native diagnostics.
 * @param status Native command exit status.
 * @param output Combined diagnostic streams.
 * @returns Whether a ticket operation can be repeated after connection loss.
 */
export function isMacOSTicketConnectionLost(status: number | null, output: string): boolean
