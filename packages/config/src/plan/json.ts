/**
 * JSON compatibility and expression-node checks for the profile plan. The walk
 * is cycle-safe, reports native issue paths, and runs as a root refinement on
 * the public plan schema.
 * @module @eedsh/config/plan/json
 */

/** One located JSON or expression problem, relative to the walked root. */
export interface JsonIssue {
  readonly path: ReadonlyArray<PropertyKey>
  readonly message: string
}

/** The reserved expression-node shape, as a human-readable expectation. */
const EXPRESSION_EXPECTATION = 'expected exactly { "$eedsh": { "expr": "<source>" } }'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isExpressionNode(value: Record<string, unknown>): boolean {
  const node = value.$eedsh
  return (
    Object.keys(value).length === 1 &&
    isPlainObject(node) &&
    Object.keys(node).length === 1 &&
    typeof node.expr === 'string'
  )
}

function objectType(value: object): string {
  return (value as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'
}

function walk(
  value: unknown,
  path: ReadonlyArray<PropertyKey>,
  ancestors: Set<object>,
  issues: JsonIssue[],
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
    if (!isExpressionNode(value)) {
      issues.push({ path, message: EXPRESSION_EXPECTATION })
    }
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

/**
 * Walk a plan and report every non-JSON value, circular reference, and
 * malformed expression node with its location relative to the plan.
 * @param plan - the candidate plan.
 * @returns the located problems, in walk order.
 */
export function planJsonIssues(plan: unknown): JsonIssue[] {
  const issues: JsonIssue[] = []
  walk(plan, [], new Set(), issues)
  return issues
}
