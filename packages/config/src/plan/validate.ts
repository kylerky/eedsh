/**
 * Semantic validation for the profile plan: JSON compatibility, expression
 * nodes, identity, layer ids, bundle order, and reserved names. Structural
 * shape lives in {@link ProfilePlanSchema}; this module turns every rejection
 * into a stable code with the failing plan location.
 * @module @eedsh/config/plan/validate
 */
import {
  type JsonObject,
  type NamedBundle,
  PLAN_FORMAT,
  PLAN_VERSION,
  type PlanBundle,
  type PlanIssue,
  type PlanLayer,
  type PlanPatch,
  type PlanValidation,
  PlanValidationError,
  type ProfilePlan,
} from './types.js'

/** Package names the materializer owns; authors may not select them. */
export const RESERVED_NAMES: readonly string[] = ['@eedsh/runtime', '@eedsh/generated']

const RESERVED = new Set(RESERVED_NAMES)

/** Layer ids double as patch file names, so they stay safe kebab-case. */
const SAFE_LAYER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** An exact DSH runtime pin such as `0.2.1-rc.2`. */
const DSH_PIN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const PLAN_KEYS = new Set(['format', 'version', 'profile', 'dsh', 'bundles', 'layers', 'packages'])
const BUNDLE_KEYS = new Set(['kind', 'name', 'source'])
const LAYER_KEYS = new Set(['id', 'patches'])

interface Context {
  issues: PlanIssue[]
}

function report(context: Context, code: string, path: string, message: string): void {
  context.issues.push({ code, path, message })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function joinPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

/**
 * Walk a JSON position, rejecting values that cannot survive canonical JSON and
 * validating reserved expression nodes wherever they appear.
 */
function walkJson(context: Context, value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null) return
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return
    case 'number':
      if (!Number.isFinite(value)) {
        report(context, 'plan.unsupported_value', path, `unsupported number ${String(value)}`)
      }
      return
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      report(context, 'plan.unsupported_value', path, `unsupported ${typeof value} value`)
      return
    case 'object':
      break
    default:
      report(context, 'plan.unsupported_value', path, 'unsupported value')
      return
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      report(context, 'plan.unsupported_value', path, 'circular reference')
      return
    }
    ancestors.add(value)
    value.forEach((item, index) => {
      walkJson(context, item, `${path}[${index}]`, ancestors)
    })
    ancestors.delete(value)
    return
  }

  if (!isPlainObject(value)) {
    report(
      context,
      'plan.unsupported_value',
      path,
      `unsupported object of type ${value.constructor?.name ?? 'unknown'}`,
    )
    return
  }

  if ('$eedsh' in value) {
    walkExpression(context, value, path)
    return
  }

  if (ancestors.has(value)) {
    report(context, 'plan.unsupported_value', path, 'circular reference')
    return
  }
  ancestors.add(value)
  for (const key of Object.keys(value))
    walkJson(context, value[key], joinPath(path, key), ancestors)
  ancestors.delete(value)
}

/** Validate the reserved `{ "$eedsh": { "expr": string } }` node shape. */
function walkExpression(context: Context, value: Record<string, unknown>, path: string): void {
  const node = value.$eedsh
  const valid =
    Object.keys(value).length === 1 &&
    isPlainObject(node) &&
    Object.keys(node).length === 1 &&
    typeof node.expr === 'string'
  if (!valid) {
    report(
      context,
      'plan.invalid_expression',
      path,
      'expected exactly { "$eedsh": { "expr": "<source>" } }',
    )
  }
}

function isSafeProfileName(name: string): boolean {
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

function validatePatch(context: Context, patch: unknown, path: string): PlanPatch | undefined {
  const issueCount = context.issues.length
  if (!isPlainObject(patch)) {
    report(context, 'plan.invalid_patch', path, 'patch must be a JSON object')
    return undefined
  }

  const hasInsert = 'insert' in patch
  if (hasInsert) {
    const insert = patch.insert
    if (!Array.isArray(insert)) {
      report(context, 'plan.invalid_patch', `${path}.insert`, 'insert must be an array of entries')
    } else {
      insert.forEach((entry, index) => {
        const entryPath = `${path}.insert[${index}]`
        if (!isPlainObject(entry)) {
          report(context, 'plan.invalid_patch', entryPath, 'inserted entry must be a JSON object')
          return
        }
        if (!('name' in entry) && entry.group !== true) {
          report(
            context,
            'plan.invalid_patch',
            entryPath,
            'inserted entry needs a name or group: true',
          )
        }
        walkJson(context, entry, entryPath, new Set())
      })
    }
  } else if (typeof patch.id !== 'string' || patch.id.trim() === '') {
    report(context, 'plan.invalid_patch', path, 'patch needs a non-empty id or an insert list')
  }

  if ('name' in patch && typeof patch.name !== 'string') {
    report(context, 'plan.invalid_patch', `${path}.name`, 'name must be a string')
  }
  for (const key of ['group', 'disabled'] as const) {
    if (key in patch) {
      const field = patch[key]
      if (field !== null && typeof field !== 'boolean') {
        report(context, 'plan.invalid_patch', `${path}.${key}`, `${key} must be a boolean or null`)
      }
    }
  }

  for (const key of Object.keys(patch)) {
    if (
      key === 'insert' ||
      key === 'id' ||
      key === 'name' ||
      key === 'group' ||
      key === 'disabled'
    ) {
      continue
    }
    walkJson(context, patch[key], `${path}.${key}`, new Set())
  }

  if (context.issues.length > issueCount) return undefined
  return structuredClone(patch) as PlanPatch
}

function validateLayer(context: Context, value: unknown, index: number): PlanLayer | undefined {
  const path = `layers[${index}]`
  if (!isPlainObject(value)) {
    report(context, 'plan.invalid_layer', path, 'layer must be a JSON object')
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (!LAYER_KEYS.has(key))
      report(context, 'plan.unknown_field', `${path}.${key}`, 'unknown layer field')
  }

  const id = value.id
  if (typeof id !== 'string' || id.trim() === '') {
    report(context, 'plan.empty_layer_id', `${path}.id`, 'layer id must be a non-empty string')
  } else if (!SAFE_LAYER_ID.test(id)) {
    report(
      context,
      'plan.unsafe_layer_id',
      `${path}.id`,
      `layer id "${id}" must be kebab-case (a-z, 0-9, single dashes)`,
    )
  }

  const patchesValue = value.patches
  const patches: PlanPatch[] = []
  if (!Array.isArray(patchesValue)) {
    report(context, 'plan.invalid_patch', `${path}.patches`, 'patches must be an array')
  } else {
    patchesValue.forEach((patch, patchIndex) => {
      const parsed = validatePatch(context, patch, `${path}.patches[${patchIndex}]`)
      if (parsed) patches.push(parsed)
    })
  }

  if (typeof id !== 'string' || id.trim() === '') return undefined
  return { id, patches }
}

function validateBundle(
  context: Context,
  value: unknown,
  index: number,
  seenBundles: Map<string, number>,
  markerCount: { value: number },
): PlanBundle | undefined {
  const path = `bundles[${index}]`
  if (!isPlainObject(value)) {
    report(context, 'plan.invalid_bundle', path, 'bundle must be a JSON object')
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (!BUNDLE_KEYS.has(key))
      report(context, 'plan.unknown_field', `${path}.${key}`, 'unknown bundle field')
  }

  if (value.kind === 'generated') {
    markerCount.value += 1
    if (markerCount.value > 1) {
      report(
        context,
        'plan.duplicate_generated_marker',
        path,
        'a plan accepts at most one generated marker',
      )
    }
    if (Object.keys(value).length !== 1) {
      report(context, 'plan.invalid_bundle', path, 'generated marker takes no fields')
    }
    return { kind: 'generated' }
  }

  if (value.kind !== 'bundle') {
    report(
      context,
      'plan.invalid_bundle',
      `${path}.kind`,
      'bundle kind must be "bundle" or "generated"',
    )
    return undefined
  }

  const name = value.name
  if (typeof name !== 'string' || name.trim() === '') {
    report(context, 'plan.invalid_bundle', `${path}.name`, 'bundle name must be a non-empty string')
    return undefined
  }
  if (RESERVED.has(name)) {
    report(context, 'plan.reserved_name', `${path}.name`, `"${name}" is owned by the materializer`)
  }
  const previous = seenBundles.get(name)
  if (previous !== undefined) {
    report(
      context,
      'plan.duplicate_bundle',
      `${path}.name`,
      `duplicate bundle "${name}" (also declared at bundles[${previous}].name)`,
    )
  } else {
    seenBundles.set(name, index)
  }
  if ('source' in value && (typeof value.source !== 'string' || value.source.trim() === '')) {
    report(context, 'plan.invalid_bundle', `${path}.source`, 'source must be a non-empty string')
  }

  const parsed: NamedBundle = { kind: 'bundle', name }
  if (typeof value.source === 'string') parsed.source = value.source
  return parsed
}

function validatePackages(context: Context, value: unknown): Record<string, string> {
  if (!isPlainObject(value)) {
    report(context, 'plan.invalid_package', 'packages', 'packages must be a JSON object')
    return {}
  }
  const packages: Record<string, string> = {}
  for (const [name, spec] of Object.entries(value)) {
    if (name.trim() === '') {
      report(context, 'plan.invalid_package', 'packages', 'package name must be non-empty')
      continue
    }
    if (RESERVED.has(name)) {
      report(
        context,
        'plan.reserved_name',
        `packages.${name}`,
        `"${name}" is owned by the materializer`,
      )
    }
    if (typeof spec !== 'string' || spec.trim() === '') {
      report(
        context,
        'plan.invalid_package',
        `packages.${name}`,
        'package spec must be a non-empty string',
      )
      continue
    }
    packages[name] = spec
  }
  return packages
}

/**
 * Validate an unknown value as a profile plan.
 * @param value - the candidate plan.
 * @returns either the detached, validated plan or every issue found.
 */
export function validatePlan(value: unknown): PlanValidation {
  const context: Context = { issues: [] }
  if (!isPlainObject(value)) {
    report(context, 'plan.invalid_plan', '', 'plan must be a JSON object')
    return { ok: false, issues: context.issues }
  }

  for (const key of Object.keys(value)) {
    if (!PLAN_KEYS.has(key)) report(context, 'plan.unknown_field', key, 'unknown plan field')
  }

  if (value.format !== PLAN_FORMAT) {
    report(context, 'plan.invalid_format', 'format', `format must be "${PLAN_FORMAT}"`)
  }
  if (value.version !== PLAN_VERSION) {
    report(context, 'plan.unsupported_version', 'version', `version must be ${PLAN_VERSION}`)
  }

  let profileName: string | undefined
  if (!isPlainObject(value.profile)) {
    report(context, 'plan.missing_profile_name', 'profile', 'profile must be an object with a name')
  } else {
    for (const key of Object.keys(value.profile)) {
      if (key !== 'name')
        report(context, 'plan.unknown_field', `profile.${key}`, 'unknown profile field')
    }
    const name = value.profile.name
    if (typeof name !== 'string' || name.trim() === '') {
      report(context, 'plan.missing_profile_name', 'profile.name', 'profile name is required')
    } else if (!isSafeProfileName(name)) {
      report(
        context,
        'plan.invalid_profile_name',
        'profile.name',
        `profile name "${name}" is not usable as a profile directory`,
      )
    } else {
      profileName = name
    }
  }

  let dsh: string | undefined
  if (typeof value.dsh !== 'string' || value.dsh.trim() === '') {
    report(context, 'plan.missing_dsh_pin', 'dsh', 'an exact DSH runtime pin is required')
  } else if (!DSH_PIN.test(value.dsh)) {
    report(context, 'plan.invalid_dsh_pin', 'dsh', `"${value.dsh}" is not an exact version`)
  } else {
    dsh = value.dsh
  }

  const bundles: PlanBundle[] = []
  const seenBundles = new Map<string, number>()
  const markerCount = { value: 0 }
  if (!Array.isArray(value.bundles)) {
    report(context, 'plan.invalid_bundle', 'bundles', 'bundles must be an array')
  } else {
    value.bundles.forEach((item, index) => {
      const parsed = validateBundle(context, item, index, seenBundles, markerCount)
      if (parsed) bundles.push(parsed)
    })
  }

  const layers: PlanLayer[] = []
  const layerIds = new Map<string, number>()
  if (!Array.isArray(value.layers)) {
    report(context, 'plan.invalid_layer', 'layers', 'layers must be an array')
  } else {
    value.layers.forEach((item, index) => {
      const parsed = validateLayer(context, item, index)
      if (!parsed) return
      const previous = layerIds.get(parsed.id)
      if (previous !== undefined) {
        report(
          context,
          'plan.duplicate_layer_id',
          `layers[${index}].id`,
          `duplicate layer id "${parsed.id}" (also declared at layers[${previous}].id)`,
        )
      } else {
        layerIds.set(parsed.id, index)
      }
      layers.push(parsed)
    })
  }

  const packages = validatePackages(context, value.packages)

  if (context.issues.length > 0) return { ok: false, issues: context.issues }
  if (profileName === undefined || dsh === undefined) {
    return { ok: false, issues: context.issues }
  }

  const plan: ProfilePlan = {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    profile: { name: profileName },
    dsh,
    bundles,
    layers,
    packages: { ...packages } as Record<string, string>,
  }
  return { ok: true, plan }
}

/**
 * Validate and return a detached plan, or throw every issue.
 * @param value - the candidate plan.
 * @returns the validated plan.
 * @throws {PlanValidationError} when the plan is invalid.
 */
export function assertPlan(value: unknown): ProfilePlan {
  const result = validatePlan(value)
  if (!result.ok) throw new PlanValidationError(result.issues)
  return result.plan
}

/** Narrowing helper for callers that already have a JSON object. */
export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainObject(value)
}
