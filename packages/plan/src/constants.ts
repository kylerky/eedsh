/**
 * Stable plan identifiers. Kept apart from the plan types so the schema can
 * import them without importing the type module.
 * @module @eedsh/plan/constants
 */

/** Stable plan format identifier written into every plan. */
export const PLAN_FORMAT = 'eedsh/profile-plan'

/** Plan schema version; bumped only when the plan shape changes incompatibly. */
export const PLAN_VERSION = 1 as const
