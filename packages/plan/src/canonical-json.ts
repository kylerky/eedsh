/**
 * Canonical JSON for plan comparison. The generation identifier and the record
 * written into the generated bundle use it, so a formatting-only difference
 * never produces a new generation.
 * @module @eedsh/plan/canonical-json
 */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key])
    return sorted
  }
  return value
}

/**
 * Serialize a JSON value with sorted object keys at every depth.
 * @param value - a JSON-compatible value.
 * @returns the canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}
