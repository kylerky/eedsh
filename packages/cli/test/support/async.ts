/**
 * Wait for a predicate by polling, without depending on a particular test
 * framework's timer utilities.
 * @module @eedsh/cli/test/support/async
 */

/**
 * Resolve after the given delay.
 * @param ms - delay in milliseconds.
 */
export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll a predicate until it is true or the timeout elapses.
 * @param predicate - the condition to poll.
 * @param timeoutMs - maximum wait in milliseconds.
 * @param intervalMs - delay between polls in milliseconds.
 * @returns whether the predicate was true before the timeout.
 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(intervalMs)
  }
  return predicate()
}
