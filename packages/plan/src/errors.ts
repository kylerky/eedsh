/**
 * The closed set of failures the plan package reports. A plan-level failure is
 * the native schema error or a config envelope whose exported Result carried a
 * failure that is not one; callers match this union instead of inspecting a
 * caught value.
 * @module @eedsh/plan/errors
 */
import type * as Schema from 'effect/Schema'
import type { InvalidConfigValue } from './envelope'

/** Every failure the plan package reports. */
export type PlanFailure = Schema.SchemaError | InvalidConfigValue
