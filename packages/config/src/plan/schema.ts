/**
 * The public profile plan schema. It is the single source of truth for the
 * plan shape, the validation rules, and the derived plan types.
 * @module @eedsh/config/plan/schema
 */
import * as Schema from 'effect/Schema'
import { PLAN_FORMAT, PLAN_VERSION } from './constants.js'

/** The reserved expression-node shape: source text DSH evaluates. */
export const ExpressionNodeSchema = Schema.Struct({
  $eedsh: Schema.Struct({ expr: Schema.String }),
})

/** One bundle selection, in authored order. */
export const NamedBundleSchema = Schema.Struct({
  kind: Schema.Literal('bundle'),
  name: Schema.NonEmptyString,
  source: Schema.optional(Schema.NonEmptyString),
})

/** The positional marker for the generated bundle layer. */
export const GeneratedBundleSchema = Schema.Struct({
  kind: Schema.Literal('generated'),
})

/** An ordered bundle selection or the single generated-layer marker. */
export const PlanBundleSchema = Schema.Union(NamedBundleSchema, GeneratedBundleSchema)

/** One Loader patch entry; plugin config values stay opaque to the schema. */
export const PlanPatchSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown })

/** One ordered generated layer. */
export const PlanLayerSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  patches: Schema.Array(PlanPatchSchema),
})

/** The complete profile plan schema. */
export const ProfilePlanSchema = Schema.Struct({
  format: Schema.Literal(PLAN_FORMAT),
  version: Schema.Literal(PLAN_VERSION),
  profile: Schema.Struct({ name: Schema.NonEmptyString }),
  dsh: Schema.NonEmptyString,
  bundles: Schema.Array(PlanBundleSchema),
  layers: Schema.Array(PlanLayerSchema),
  packages: Schema.Record({ key: Schema.String, value: Schema.String }),
})

/** The reserved expression node derived from the schema. */
export type ExpressionNode = Schema.Schema.Type<typeof ExpressionNodeSchema>

/** A selected bundle, derived from the schema. */
export type NamedBundle = Schema.Schema.Type<typeof NamedBundleSchema>

/** The generated-layer marker, derived from the schema. */
export type GeneratedBundle = Schema.Schema.Type<typeof GeneratedBundleSchema>

/** An ordered bundle selection or the generated marker, derived from the schema. */
export type PlanBundle = Schema.Schema.Type<typeof PlanBundleSchema>

/** One opacity-preserving Loader patch entry, derived from the schema. */
export type PlanPatch = Schema.Schema.Type<typeof PlanPatchSchema>

/** One ordered generated layer, derived from the schema. */
export type PlanLayer = Schema.Schema.Type<typeof PlanLayerSchema>

/** The validated profile plan, derived from the schema. */
export type ProfilePlan = Schema.Schema.Type<typeof ProfilePlanSchema>
