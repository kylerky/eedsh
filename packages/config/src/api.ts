/**
 * The typed authoring surface: `defineProfile` plus small helpers that map
 * one-to-one onto Loader patch concepts. Every helper returns plain plan data;
 * nothing here executes configuration or hides patch semantics.
 * @module @eedsh/config/api
 */
import {
  type ExpressionNode,
  type GeneratedBundle,
  type JsonObject,
  type JsonValue,
  type NamedBundle,
  PLAN_FORMAT,
  PLAN_VERSION,
  type PlanBundle,
  type PlanLayer,
  type PlanPatch,
  type ProfilePlan,
} from './plan/types.js'
import { assertPlan } from './plan/validate.js'

/** One inserted Loader entry. */
export type PlanEntry = JsonObject

/** Input accepted by {@link defineProfile}. */
export interface DefineProfileInput {
  /** Profile name; also the profile directory under `$DSH_HOME/profiles`. */
  name: string
  /** Exact DSH runtime pin the profile is authored against. */
  dsh: string
  /** Ordered bundle selections, optionally containing the generated marker. */
  bundles?: readonly PlanBundle[]
  /** Ordered generated patch layers. */
  layers?: readonly PlanLayer[]
  /** Profile-local package dependencies. */
  packages?: Readonly<Record<string, string>>
}

/** Options for {@link bundle}. */
export interface BundleOptions {
  /** Optional profile-local package specifier for the bundle. */
  source?: string
}

/**
 * Select a bundle at this position.
 * @param name - the bundle package name.
 * @param options - optional source override.
 * @returns an ordered bundle selection.
 */
export function bundle(name: string, options: BundleOptions = {}): NamedBundle {
  const value: NamedBundle = { kind: 'bundle', name }
  if (options.source !== undefined) value.source = options.source
  return value
}

/**
 * Mark where the generated bundle layer belongs among the managed bundles.
 * @returns the positional generated marker.
 */
export function generated(): GeneratedBundle {
  return { kind: 'generated' }
}

/**
 * Declare an ordered patch layer.
 * @param id - safe kebab-case layer id, also the patch file name.
 * @param patches - patches applied in order.
 * @returns the layer.
 */
export function layer(id: string, patches: readonly PlanPatch[] = []): PlanLayer {
  return { id, patches: [...patches] }
}

/**
 * Insert one or more Loader entries.
 * @param entries - entry or entries to insert.
 * @returns an insert patch.
 */
export function insert(entries: PlanEntry | readonly PlanEntry[]): PlanPatch {
  const list: readonly PlanEntry[] = Array.isArray(entries) ? entries : [entries]
  return { insert: list.map((entry) => ({ ...entry })) as JsonValue[] }
}

/**
 * Replace an existing row's whole config, matching DSH's patch semantics.
 * @param id - the target row id.
 * @param config - the complete replacement config.
 * @returns an id-targeted patch.
 */
export function override(id: string, config: JsonValue): PlanPatch {
  return { id, config }
}

/**
 * Disable an existing row.
 * @param id - the target row id.
 * @returns a disable patch.
 */
export function disable(id: string): PlanPatch {
  return { id, disabled: true }
}

/**
 * Enable an existing row.
 * @param id - the target row id.
 * @returns an enable patch.
 */
export function enable(id: string): PlanPatch {
  return { id, disabled: false }
}

/**
 * Declare a group entry carrying an optional isolate map and ordered children.
 * Pass it to {@link insert} to add the group as a new row.
 * @param id - the group row id.
 * @param fields - extra entry fields such as `name`, `disabled`, or `isolate`.
 * @param children - ordered child entries.
 * @returns a group entry.
 */
export function group(id: string, fields: JsonObject, children: readonly PlanEntry[]): PlanEntry {
  return {
    ...fields,
    id,
    group: true,
    config: children.map((child) => ({ ...child })) as JsonValue[],
  }
}

/**
 * Build a runtime expression node with verbatim source text.
 * @param source - the JavaScript expression DSH evaluates at activation.
 * @returns the reserved expression node.
 */
export function js(source: string): ExpressionNode {
  return { $eedsh: { expr: source } }
}

/**
 * Preserve a raw Loader patch entry, including fields this API does not name.
 * @param entry - the patch entry.
 * @returns the same entry as plan data.
 */
export function raw(entry: PlanPatch): PlanPatch {
  return { ...entry }
}

/**
 * Build and validate a profile plan. Validation rejects non-JSON values,
 * malformed expression nodes, duplicate markers or layer ids, reserved names,
 * and invalid identity before anything is written.
 * @param input - profile identity, bundles, layers, and packages.
 * @returns the validated, detached plan.
 * @throws {PlanValidationError} with stable codes and plan locations.
 */
export function defineProfile(input: DefineProfileInput): ProfilePlan {
  const candidate = {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    profile: { name: input.name },
    dsh: input.dsh,
    bundles: input.bundles === undefined ? [] : [...input.bundles],
    layers: (input.layers ?? []).map((item) => ({ id: item.id, patches: [...item.patches] })),
    packages: { ...(input.packages ?? {}) },
  }
  return assertPlan(candidate)
}
