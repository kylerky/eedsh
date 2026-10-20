/**
 * The TypeBox schema for the profile plan. The schema is the structural
 * contract exported to other frontends; {@link validatePlan} adds the
 * semantic and JSON-compatibility checks that a schema alone cannot express.
 * @module @eedsh/config/plan/schema
 */
import { type Static, Type } from '@sinclair/typebox'
import { PLAN_FORMAT, PLAN_VERSION } from './types.js'

/** The reserved expression-node shape. */
export const ExpressionNodeSchema = Type.Object(
  { $eedsh: Type.Object({ expr: Type.String() }, { additionalProperties: false }) },
  { additionalProperties: false },
)

/** One bundle selection or the generated marker. */
export const PlanBundleSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('bundle'),
      name: Type.String({ minLength: 1 }),
      source: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('generated') }, { additionalProperties: false }),
])

/** One Loader patch entry; plugin config values stay opaque to the schema. */
export const PlanPatchSchema = Type.Record(Type.String(), Type.Unknown())

/** One ordered generated layer. */
export const PlanLayerSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    patches: Type.Array(PlanPatchSchema),
  },
  { additionalProperties: false },
)

/** The complete profile plan schema. */
export const ProfilePlanSchema = Type.Object(
  {
    format: Type.Literal(PLAN_FORMAT),
    version: Type.Literal(PLAN_VERSION),
    profile: Type.Object({ name: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    dsh: Type.String({ minLength: 1 }),
    bundles: Type.Array(PlanBundleSchema),
    layers: Type.Array(PlanLayerSchema),
    packages: Type.Record(Type.String(), Type.String()),
  },
  { additionalProperties: false },
)

/** The static plan type derived from {@link ProfilePlanSchema}. */
export type ProfilePlanSchemaType = Static<typeof ProfilePlanSchema>
