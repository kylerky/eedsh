/**
 * The public profile plan schema. It is the single source of truth for the
 * plan shape, the validation rules, and the derived plan types.
 * @module @eedsh/config/plan/schema
 */
import * as Schema from 'effect/Schema'
import { PLAN_FORMAT, PLAN_VERSION } from './constants'
import { planJsonIssues } from './json'
import { isPlainObject } from './plain-object'

/** Package names the materializer owns; authors may not select them. */
export const RESERVED_NAMES: readonly string[] = ['@eedsh/runtime', '@eedsh/generated']

const RESERVED = new Set(RESERVED_NAMES)

/** Layer ids double as patch file names, so they stay safe kebab-case. */
const SAFE_LAYER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** An exact DSH runtime pin such as `0.2.1-rc.2`. */
const DSH_PIN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * Require a plain object at a schema boundary before decoding its fields.
 * Struct decoding rebuilds objects, so without this guard a class instance
 * with the right fields would silently decode; the plan contract rejects it.
 */
function plain<S extends Schema.Constraint>(schema: S, message: string) {
  const input = refine(Schema.Unknown, (value: unknown) => isPlainObject(value) || message)
  return Schema.decodeTo(schema)(input)
}

/**
 * Whether a profile name is one safe path segment and not a reserved name.
 * @param name - candidate profile name.
 * @returns whether it can name a profile directory.
 */
export function isSafeProfileName(name: string): boolean {
  return (
    name.trim() === name &&
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    name !== 'node_modules' &&
    !name.includes('/') &&
    !name.includes('\\')
  )
}

/**
 * Refine a schema with a filter while keeping the precise derived type.
 * Explicitly passing the base schema keeps the inferred filter schema typed;
 * an untyped curried filter would widen the type to `any`.
 */
function refine<S extends Schema.Top>(
  self: S,
  predicate: (value: S['Type']) => Schema.FilterOutput,
): S['Rebuild'] {
  return Schema.check<S>(Schema.makeFilter<S['Type']>(predicate))(self)
}

/** A profile name that is safe to use as a profile directory. */
export const ProfileNameSchema = refine(
  Schema.NonEmptyString,
  (name) =>
    isSafeProfileName(name) || `profile name "${name}" is not usable as a profile directory`,
)

/** An exact DSH runtime pin. */
export const DshPinSchema = refine(
  Schema.NonEmptyString,
  (dsh) => DSH_PIN.test(dsh) || `"${dsh}" is not an exact version`,
)

/** A layer id that is safe to use as a patch file name. */
const LayerIdSchema = refine(Schema.NonEmptyString, (id) =>
  id.trim() === ''
    ? 'layer id must be a non-empty string'
    : SAFE_LAYER_ID.test(id) || `layer id "${id}" must be kebab-case (a-z, 0-9, single dashes)`,
)

/** A bundle name the materializer does not already own. */
const BundleNameSchema = refine(
  Schema.NonEmptyString,
  (name) => !RESERVED.has(name) || `"${name}" is owned by the materializer`,
)

/** The reserved expression-node shape: source text DSH evaluates. */
export const ExpressionNodeSchema = Schema.Struct({
  $eedsh: Schema.Struct({ expr: Schema.String }),
})

/** One bundle selection, in authored order. */
export const NamedBundleSchema = Schema.Struct({
  kind: Schema.Literal('bundle'),
  name: BundleNameSchema,
  source: Schema.optional(Schema.NonEmptyString),
})

/** The positional marker for the generated bundle layer. */
export const GeneratedBundleSchema = Schema.Struct({
  kind: Schema.Literal('generated'),
})

/** An ordered bundle selection or the single generated-layer marker. */
export const PlanBundleSchema = plain(
  Schema.Union([NamedBundleSchema, GeneratedBundleSchema]),
  'bundle must be a JSON object',
)

function bundleIssues(bundles: ReadonlyArray<PlanBundle>): Schema.FilterIssue[] {
  const issues: Schema.FilterIssue[] = []
  const seen = new Map<string, number>()
  let markers = 0
  bundles.forEach((bundle, index) => {
    if (bundle.kind === 'generated') {
      markers += 1
      if (markers > 1) {
        issues.push({ path: [index], issue: 'a plan accepts at most one generated marker' })
      }
      return
    }
    const previous = seen.get(bundle.name)
    if (previous === undefined) seen.set(bundle.name, index)
    else
      issues.push({
        path: [index, 'name'],
        issue: `duplicate bundle "${bundle.name}" (also declared at bundles[${previous}].name)`,
      })
  })
  return issues
}

const PlanBundleListBaseSchema = Schema.Array(PlanBundleSchema)

/** Ordered bundles: unique names and at most one generated marker. */
const PlanBundleListSchema = refine(PlanBundleListBaseSchema, bundleIssues)

/** One Loader patch entry; plugin config values stay opaque to the schema. */
const PlanPatchBaseSchema = plain(
  Schema.Record(Schema.String, Schema.Unknown),
  'patch must be a JSON object',
)

type PatchInput = { readonly [key: string]: unknown }

function patchIssues(patch: PatchInput): Schema.FilterIssue[] {
  const issues: Schema.FilterIssue[] = []
  if ('insert' in patch) {
    const insert = patch.insert
    if (!Array.isArray(insert)) {
      issues.push({ path: ['insert'], issue: 'insert must be an array of entries' })
    } else {
      insert.forEach((entry, index) => {
        const path: ReadonlyArray<PropertyKey> = ['insert', index]
        if (!isPlainObject(entry)) {
          issues.push({ path, issue: 'inserted entry must be a JSON object' })
          return
        }
        if (!('name' in entry) && entry.group !== true) {
          issues.push({ path, issue: 'inserted entry needs a name or group: true' })
        }
      })
    }
  } else if (typeof patch.id !== 'string' || patch.id.trim() === '') {
    issues.push({ path: [], issue: 'patch needs a non-empty id or an insert list' })
  }

  if ('name' in patch && typeof patch.name !== 'string') {
    issues.push({ path: ['name'], issue: 'name must be a string' })
  }
  for (const key of ['group', 'disabled'] as const) {
    if (!(key in patch)) continue
    const field = patch[key]
    if (field !== null && typeof field !== 'boolean') {
      issues.push({ path: [key], issue: `${key} must be a boolean or null` })
    }
  }
  return issues
}

/** One Loader patch entry with the patch rules applied. */
export const PlanPatchSchema = refine(PlanPatchBaseSchema, patchIssues)

/** One ordered generated layer. */
export const PlanLayerSchema = plain(
  Schema.Struct({
    id: LayerIdSchema,
    patches: Schema.Array(PlanPatchSchema),
  }),
  'layer must be a JSON object',
)

function layerIssues(layers: ReadonlyArray<PlanLayer>): Schema.FilterIssue[] {
  const issues: Schema.FilterIssue[] = []
  const seen = new Map<string, number>()
  layers.forEach((layer, index) => {
    const previous = seen.get(layer.id)
    if (previous === undefined) seen.set(layer.id, index)
    else
      issues.push({
        path: [index, 'id'],
        issue: `duplicate layer id "${layer.id}" (also declared at layers[${previous}].id)`,
      })
  })
  return issues
}

const PlanLayerListBaseSchema = Schema.Array(PlanLayerSchema)

/** Ordered layers with unique ids. */
const PlanLayerListSchema = refine(PlanLayerListBaseSchema, layerIssues)

const PackagesBaseSchema = Schema.Record(Schema.String, Schema.String)

function packageIssues(packages: Readonly<Record<string, string>>): Schema.FilterIssue[] {
  const issues: Schema.FilterIssue[] = []
  for (const [name, spec] of Object.entries(packages)) {
    if (name.trim() === '') {
      issues.push({ path: [name], issue: 'package name must be non-empty' })
    }
    if (RESERVED.has(name)) {
      issues.push({ path: [name], issue: `"${name}" is owned by the materializer` })
    }
    if (spec.trim() === '') {
      issues.push({ path: [name], issue: 'package spec must be a non-empty string' })
    }
  }
  return issues
}

/** Profile-local packages with non-empty specs and no reserved names. */
const PackagesSchema = refine(PackagesBaseSchema, packageIssues)

const ProfilePlanBaseSchema = plain(
  Schema.Struct({
    format: Schema.Literal(PLAN_FORMAT),
    version: Schema.Literal(PLAN_VERSION),
    profile: plain(
      Schema.Struct({ name: ProfileNameSchema }),
      'profile must be a JSON object with a name',
    ),
    dsh: DshPinSchema,
    bundles: PlanBundleListSchema,
    layers: PlanLayerListSchema,
    packages: PackagesSchema,
  }),
  'plan must be a JSON object',
)

/** Adapt the JSON walker's located problems to native filter issues. */
function planFilterIssues(plan: unknown): Schema.FilterIssue[] {
  return planJsonIssues(plan).map(({ path, message }) => ({ path, issue: message }))
}

/**
 * The complete profile plan schema: the structural contract, the policy
 * refinements, and the JSON and expression checks.
 */
export const ProfilePlanSchema = refine(ProfilePlanBaseSchema, planFilterIssues)

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
