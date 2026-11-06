/**
 * Structural validation for a bundle patch. It mirrors the DSH Loader patch
 * shape and JSON compatibility; composition and target resolution remain
 * DSH's job.
 * @module @eedsh/bundle/validate
 */

import type { BundlePatch, PatchEntry } from './patch'

/** One located validation problem. */
export interface BundlePatchIssue {
  /** Path relative to the bundle patch root. */
  readonly path: ReadonlyArray<PropertyKey>
  /** A human-readable problem description. */
  readonly message: string
}

/** The expectation for a reserved expression node. */
const EXPRESSION_EXPECTATION = 'expected exactly { "$eedsh": { "expr": "<source>" } }'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function objectType(value: object): string {
  return (value as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'
}

function isExpressionNode(value: Record<string, unknown>): boolean {
  const node = value.$eedsh
  return (
    Object.keys(value).length === 1 &&
    node !== null &&
    typeof node === 'object' &&
    !Array.isArray(node) &&
    isPlainObject(node) &&
    Object.keys(node).length === 1 &&
    typeof (node as { expr?: unknown }).expr === 'string'
  )
}

function walk(
  value: unknown,
  path: ReadonlyArray<PropertyKey>,
  ancestors: Set<object>,
  issues: BundlePatchIssue[],
): void {
  if (value === null) return
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return
    case 'number':
      if (!Number.isFinite(value)) {
        issues.push({ path, message: `unsupported number ${String(value)}` })
      }
      return
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      issues.push({ path, message: `unsupported ${typeof value} value` })
      return
    case 'object':
      break
    default:
      issues.push({ path, message: 'unsupported value' })
      return
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      issues.push({ path, message: 'circular reference' })
      return
    }
    ancestors.add(value)
    value.forEach((item, index) => {
      walk(item, [...path, index], ancestors, issues)
    })
    ancestors.delete(value)
    return
  }

  if (!isPlainObject(value)) {
    issues.push({ path, message: `unsupported object of type ${objectType(value)}` })
    return
  }

  if ('$eedsh' in value) {
    if (!isExpressionNode(value)) issues.push({ path, message: EXPRESSION_EXPECTATION })
    return
  }

  if (ancestors.has(value)) {
    issues.push({ path, message: 'circular reference' })
    return
  }
  ancestors.add(value)
  for (const key of Object.keys(value)) {
    walk(value[key], [...path, key], ancestors, issues)
  }
  ancestors.delete(value)
}

function isExpressionValue(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && '$eedsh' in value
}

function invalidBooleanOrNull(
  entry: Record<string, unknown>,
  key: 'group' | 'disabled',
  path: ReadonlyArray<PropertyKey>,
  issues: BundlePatchIssue[],
): void {
  if (!(key in entry)) return
  const value = entry[key]
  if (value !== null && typeof value !== 'boolean' && !isExpressionValue(value)) {
    issues.push({
      path: [...path, key],
      message: `${key} must be a boolean, null, or an expression node`,
    })
  }
}

function insertedEntryIssues(
  entry: unknown,
  path: ReadonlyArray<PropertyKey>,
  issues: BundlePatchIssue[],
): void {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    issues.push({ path, message: 'inserted entry must be a JSON object' })
    return
  }
  const record = entry as Record<string, unknown>
  if (!('name' in record) && record.group !== true) {
    issues.push({ path, message: 'inserted entry needs a name or group: true' })
  }
  if ('name' in record && typeof record.name !== 'string') {
    issues.push({ path: [...path, 'name'], message: 'name must be a string' })
  }
  invalidBooleanOrNull(record, 'group', path, issues)
  invalidBooleanOrNull(record, 'disabled', path, issues)
}

function patchIssues(
  patch: unknown,
  path: ReadonlyArray<PropertyKey>,
  issues: BundlePatchIssue[],
): void {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    issues.push({ path, message: 'patch entry must be a JSON object' })
    return
  }
  const record = patch as Record<string, unknown>

  if ('insert' in record) {
    if (!Array.isArray(record.insert)) {
      issues.push({ path: [...path, 'insert'], message: 'insert must be an array of entries' })
    } else {
      record.insert.forEach((entry, index) => {
        insertedEntryIssues(entry, [...path, 'insert', index], issues)
      })
    }
  } else if (typeof record.id !== 'string' || record.id.trim() === '') {
    issues.push({ path, message: 'patch needs a non-empty id or an insert list' })
  }

  if ('name' in record && typeof record.name !== 'string') {
    issues.push({ path: [...path, 'name'], message: 'name must be a string' })
  }
  invalidBooleanOrNull(record, 'group', path, issues)
  invalidBooleanOrNull(record, 'disabled', path, issues)
}

/** Render one located issue as `bundle[0].insert[1]: message`. */
function formatIssue(issue: BundlePatchIssue): string {
  let rendered = 'bundle'
  for (const key of issue.path) {
    rendered += typeof key === 'number' ? `[${key}]` : `.${String(key)}`
  }
  return `${rendered}: ${issue.message}`
}

/** A bundle patch that is not structurally valid. */
export class BundlePatchError extends Error {
  /** Every located problem. */
  readonly issues: readonly BundlePatchIssue[]

  /**
   * @param issues - the located problems.
   */
  constructor(issues: readonly BundlePatchIssue[]) {
    super(`bundle patch is invalid: ${issues.map(formatIssue).join('; ')}`)
    this.name = 'BundlePatchError'
    this.issues = issues
  }
}

/**
 * Validate a bundle patch's structure and JSON compatibility.
 * @param value - the candidate patch.
 * @throws {BundlePatchError} when the patch is invalid.
 */
export function validateBundlePatch(value: unknown): asserts value is BundlePatch {
  const issues: BundlePatchIssue[] = []
  if (!Array.isArray(value)) {
    throw new BundlePatchError([{ path: [], message: 'bundle patch must be a top-level array' }])
  }
  value.forEach((patch, index) => {
    patchIssues(patch, [index], issues)
  })
  walk(value, [], new Set(), issues)
  if (issues.length > 0) throw new BundlePatchError(issues)
}

/** The validated patch shape used by emitter internals. */
export type ValidatedBundlePatch = readonly PatchEntry[]
