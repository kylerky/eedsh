/**
 * Format an unknown caught value for a diagnostic. This is the simple
 * Error-message/String form; callers with richer error shapes keep their own
 * formatter.
 * @module @eedsh/cli/internal/error-message
 */

/**
 * The message of an Error, or the string form of any other value.
 * @param error - the caught value.
 * @returns the diagnostic text.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
