/**
 * Structured YAML emission for generated patch layers. Emits with DSH's own
 * entry-list schema, so `!!js` expression nodes round-trip through the
 * Loader's patch parser instead of being string-concatenated.
 * @module @eedsh/cli/materialize/yaml
 */

import type { PlanPatch } from '@eedsh/plan'
import * as Result from 'effect/Result'
import * as yaml from 'js-yaml'
import { entryListSchema } from './yaml-schema'

/** A reserved expression node whose shape the plan cannot have produced. */
export interface MalformedExpression {
  readonly _tag: 'MalformedExpression'
  /** The diagnostic message for the malformed node. */
  readonly message: string
}

function malformedExpression(): MalformedExpression {
  return {
    _tag: 'MalformedExpression',
    message: 'cannot emit a malformed expression node',
  }
}

/**
 * Convert plan expression nodes into the `!!js` data shape DSH's schema
 * represents, leaving every other value untouched. Plan validation rejects
 * every other `$eedsh` shape, so a failure here means caller data bypassed it.
 * @param value - JSON plan data.
 * @returns the same data with `{ "$eedsh": { "expr": ... } }` nodes replaced.
 */
export function toExpressionData(value: unknown): Result.Result<unknown, MalformedExpression> {
  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const item of value) {
      const converted = toExpressionData(item)
      if (Result.isFailure(converted)) return Result.fail(converted.failure)
      items.push(converted.success)
    }
    return Result.succeed(items)
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('$eedsh' in record) {
      const node = record.$eedsh
      if (
        Object.keys(record).length === 1 &&
        node !== null &&
        typeof node === 'object' &&
        typeof (node as { expr?: unknown }).expr === 'string'
      ) {
        return Result.succeed({ __jsExpr: (node as { expr: string }).expr })
      }
      return Result.fail(malformedExpression())
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) {
      const converted = toExpressionData(item)
      if (Result.isFailure(converted)) return Result.fail(converted.failure)
      out[key] = converted.success
    }
    return Result.succeed(out)
  }
  return Result.succeed(value)
}

/**
 * Emit one layer's patches as a YAML patch list.
 * @param patches - the layer's validated patches.
 * @returns YAML text ending with a newline, or a malformed-expression failure.
 */
export function emitPatchesYaml(
  patches: readonly PlanPatch[],
): Result.Result<string, MalformedExpression> {
  const converted = toExpressionData(patches)
  if (Result.isFailure(converted)) return Result.fail(converted.failure)
  return Result.succeed(yaml.dump(converted.success, { schema: entryListSchema, noRefs: true }))
}
