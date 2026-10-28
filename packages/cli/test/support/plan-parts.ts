/**
 * Plain plan-data constructors for tests. Production authoring uses the typed
 * fluent objects in `@eedsh/config`; these helpers build the same plain JSON
 * directly so plan, materializer, and preflight tests stay independent of the
 * authoring object model.
 */
import type {
  ExpressionNode,
  GeneratedBundle,
  JsonObject,
  JsonValue,
  NamedBundle,
  PlanBundle,
  PlanLayer,
  PlanPatch,
} from '@eedsh/plan'

/** One inserted Loader entry. */
export type PlanEntry = JsonObject

/** Options for {@link bundle}. */
export interface BundleOptions {
  source?: string
}

/**
 * Select a bundle at this position.
 * @param name - the bundle package name.
 * @param options - optional source override.
 * @returns an ordered bundle selection.
 */
export function bundle(name: string, options: BundleOptions = {}): NamedBundle {
  return options.source === undefined
    ? { kind: 'bundle', name }
    : { kind: 'bundle', name, source: options.source }
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
 * Replace an existing row's whole config.
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

/** The plan bundle a test uses for the generated marker. */
export type { PlanBundle }
