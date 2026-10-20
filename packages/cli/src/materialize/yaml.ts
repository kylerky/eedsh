/**
 * Structured YAML emission for generated patch layers. Emits with DSH's own
 * entry-list schema, so `!!js` expression nodes round-trip through the
 * Loader's patch parser instead of being string-concatenated.
 * @module @eedsh/cli/materialize/yaml
 */
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { PlanPatch } from '@eedsh/config'
import * as yaml from 'js-yaml'

/**
 * Convert plan expression nodes into the `!!js` data shape DSH's schema
 * represents, leaving every other value untouched.
 * @param value - JSON plan data.
 * @returns the same data with `{ "$eedsh": { "expr": ... } }` nodes replaced.
 */
export function toExpressionData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => toExpressionData(item))
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
        return { __jsExpr: (node as { expr: string }).expr }
      }
      throw new Error('cannot emit a malformed expression node')
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) out[key] = toExpressionData(item)
    return out
  }
  return value
}

/**
 * Emit one layer's patches as a YAML patch list.
 * @param patches - the layer's validated patches.
 * @returns YAML text ending with a newline.
 */
export function emitPatchesYaml(patches: readonly PlanPatch[]): string {
  return yaml.dump(toExpressionData(patches), { schema: entryListSchema, noRefs: true })
}
