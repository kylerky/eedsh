/**
 * The authoring-object brand and normalization seam. Typed authoring objects
 * carry behavior while the persisted plan stays strict plain JSON: they
 * identify themselves with a globally registered symbol and resolve against the
 * invocation's resolution table. Only `defineConfig().build(table)` normalizes
 * them.
 * @module @eedsh/config/authoring
 */
import type { ResolutionTable } from './resolution'

/** The global brand symbol every typed authoring object carries. */
export const AUTHORING_KIND = Symbol.for('@eedsh/config.authoring')

/** The kinds of object that resolve to plan data. */
export type AuthoringKind =
  | 'bundle'
  | 'row'
  | 'preset'
  | 'rows'
  | 'presets'
  | 'preset-definition'
  | 'patch'

/** A typed authoring object that knows its plain-plan representation. */
export interface AuthoringObject {
  readonly [AUTHORING_KIND]: AuthoringKind
  /**
   * Resolve this object against the invocation resolution.
   * @param table - the resolved bundles the CLI produced for this invocation.
   * @returns the plain plan value.
   */
  resolve(table: ResolutionTable): unknown
}

/** The empty table used while collecting queries, before any bundle is resolved. */
const EMPTY_TABLE: ResolutionTable = { bundles: [] }

function isRecord(value: object): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * Whether a value is one of this package's typed authoring objects. The check
 * is structural and uses the global symbol, so a handle built by the config
 * project's copy of `@eedsh/config` is still recognized here.
 * @param value - the candidate value.
 * @returns whether it is a branded authoring object.
 */
export function isAuthoringObject(value: unknown): value is AuthoringObject {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<PropertyKey, unknown>
  return typeof record[AUTHORING_KIND] === 'string' && typeof record.resolve === 'function'
}

/**
 * The documented kind of an authoring object, when it is one.
 * @param value - the candidate value.
 * @returns the brand kind, or undefined.
 */
export function authoringKind(value: unknown): AuthoringKind | undefined {
  return isAuthoringObject(value) ? (value[AUTHORING_KIND] as AuthoringKind) : undefined
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Recursively replace typed authoring objects with their resolved plan values.
 * Arrays and plain objects are copied; any other object is left untouched so
 * the plan schema reports it at its own location. The walk is cycle-safe: a
 * repeated array or plain object reuses its earlier copy, leaving the plan
 * contract to report the cycle.
 * @param value - the candidate authored value.
 * @param table - the invocation resolution, empty when only iterating.
 * @param seen - the copy table for the current walk.
 * @returns the detached plain value.
 */
export function normalizeAuthoring(
  value: unknown,
  table: ResolutionTable = EMPTY_TABLE,
  seen: Map<object, unknown> = new Map(),
): unknown {
  if (value === null || typeof value !== 'object') return value
  if (isAuthoringObject(value)) {
    const plain = value.resolve(table)
    return plain === value ? value : normalizeAuthoring(plain, table, seen)
  }
  if (Array.isArray(value)) {
    const copied = seen.get(value)
    if (copied !== undefined) return copied
    const list: unknown[] = []
    seen.set(value, list)
    for (const item of value) list.push(normalizeAuthoring(item, table, seen))
    return list
  }
  if (!isRecord(value) || !isPlainObject(value)) return value
  const copied = seen.get(value)
  if (copied !== undefined) return copied
  const out: Record<string, unknown> = {}
  seen.set(value, out)
  for (const [key, item] of Object.entries(value)) out[key] = normalizeAuthoring(item, table, seen)
  return out
}
