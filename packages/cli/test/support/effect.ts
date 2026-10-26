import { Effect } from 'effect'
import * as Result from 'effect/Result'

/**
 * Run an effect and return its typed failure. The test fails when the effect
 * succeeds.
 * @param effect - the effect expected to fail.
 * @returns the effect's failure value.
 */
export async function failureOf(effect: Effect.Effect<unknown, unknown>): Promise<any> {
  const result = await Effect.runPromise(Effect.result(effect))
  if (Result.isSuccess(result)) throw new Error('expected the effect to fail')
  return result.failure
}
