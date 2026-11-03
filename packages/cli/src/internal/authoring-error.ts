/**
 * Structural recognition of the tagged authoring failures the config boundary
 * throws. The config project can hold a different copy of `@eedsh/config`, so
 * detection must never use `instanceof`; the stable `_tag`, `code`, and
 * message are the contract that survives module duplication.
 * @module @eedsh/cli/internal/authoring-error
 */
import type { PresetDefinitionError, ResolutionError, SourceDeclarationError } from '@eedsh/config'

/** A tagged authoring failure thrown during config evaluation. */
export type AuthoringError = ResolutionError | PresetDefinitionError | SourceDeclarationError

const AUTHORING_ERROR_TAGS: ReadonlySet<string> = new Set([
  'ResolutionError',
  'PresetDefinitionError',
  'SourceDeclarationError',
])

/**
 * Format a preserved preset-definition failure by code and message, with a
 * facts line naming the preset, row, and child ids.
 * @param tagged - the caught tagged value.
 * @returns the printable diagnostic lines.
 */
export function presetDefinitionErrorLines(tagged: Record<string, unknown>): string[] {
  const lines = [`${String(tagged.code)}: ${String(tagged.message)}`]
  const facts: string[] = []
  if (typeof tagged.presetId === 'string' && tagged.presetId !== '') {
    facts.push(`preset ${JSON.stringify(tagged.presetId)}`)
  }
  if (typeof tagged.rowId === 'string' && tagged.rowId !== '') {
    facts.push(`row ${JSON.stringify(tagged.rowId)}`)
  }
  if (typeof tagged.childId === 'string' && tagged.childId !== '') {
    facts.push(`child ${JSON.stringify(tagged.childId)}`)
  }
  if (facts.length > 0) lines.push(facts.join(' '))
  return lines
}

/**
 * Whether a caught value is a tagged authoring failure.
 * @param value - the caught value.
 * @returns whether config loading must preserve it instead of wrapping it.
 */
export function isAuthoringError(value: unknown): value is AuthoringError {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record._tag === 'string' &&
    AUTHORING_ERROR_TAGS.has(record._tag) &&
    typeof record.code === 'string' &&
    typeof record.message === 'string'
  )
}
