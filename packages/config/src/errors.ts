/**
 * Structured author-time resolution failures. Every failure carries a stable
 * code so the CLI and REPL can report it without matching message text.
 * @module @eedsh/config/errors
 */
import type { QueryRoot } from './resolution'

/** Stable failure codes for resolution the CLI performs for an invocation. */
export type ResolutionErrorCode =
  | 'resolution.anchor_missing'
  | 'resolution.anchor_unreadable'
  | 'resolution.anchor_invalid'
  | 'resolution.bridge_missing'
  | 'resolution.bridge_capability_missing'
  | 'resolution.root_conflict'
  | 'resolution.profile_invalid'
  | 'resolution.profile_missing'
  | 'resolution.bundle_not_installed'
  | 'resolution.bundle_not_found'
  | 'resolution.package_dir_missing'
  | 'resolution.package_dir_invalid'
  | 'resolution.not_a_bundle'
  | 'resolution.patch_invalid'
  | 'resolution.row_not_found'
  | 'resolution.preset_not_found'
  | 'resolution.rooted_query'
  | 'resolution.invalid_target'
  | 'resolution.profile_override_invalid'

/**
 * The stable codes for authoring misuse that the type system cannot exclude.
 * These are defects, not expected resolution failures: the invocation reports
 * them as an impossible state rather than as a user-facing resolution code.
 */
export type AuthoringDefectCode =
  | 'authoring.invalid_target'
  | 'authoring.rooted_query'
  | 'authoring.profile_invalid'
  | 'authoring.missing_resolution'
  | 'authoring.missing_entry'

/**
 * Authoring misuse detected at run time. It carries a stable code and the
 * facts needed to name the call, and stays distinguishable from every expected
 * failure the CLI reports.
 */
export class AuthoringDefect extends Error {
  readonly _tag = 'AuthoringDefect'
  readonly code: AuthoringDefectCode
  readonly bundle: string
  readonly path?: string
  readonly rowId?: string
  readonly presetId?: string

  constructor(input: {
    readonly code: AuthoringDefectCode
    readonly message: string
    readonly bundle?: string
    readonly path?: string
    readonly rowId?: string
    readonly presetId?: string
  }) {
    super(input.message)
    this.name = 'AuthoringDefect'
    this.code = input.code
    this.bundle = input.bundle ?? ''
    if (input.path !== undefined) this.path = input.path
    if (input.rowId !== undefined) this.rowId = input.rowId
    if (input.presetId !== undefined) this.presetId = input.presetId
  }
}

/**
 * Whether a value is this package's authoring defect. The check is structural
 * because a config project may load a second copy of `@eedsh/config`.
 * @param value - the candidate value.
 * @returns whether it is an authoring defect.
 */
export function isAuthoringDefect(value: unknown): value is AuthoringDefect {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { _tag?: unknown })._tag === 'AuthoringDefect' &&
    typeof (value as { code?: unknown }).code === 'string'
  )
}

/** A structured resolution failure produced by the CLI for one invocation. */
export class ResolutionError extends Error {
  readonly _tag = 'ResolutionError'
  readonly code: ResolutionErrorCode
  readonly bundle: string
  /** The recorded root the query used. */
  readonly root?: QueryRoot
  readonly path?: string
  readonly profile?: string

  constructor(input: {
    readonly code: ResolutionErrorCode
    readonly bundle: string
    readonly message: string
    readonly root?: QueryRoot
    readonly path?: string
    readonly profile?: string
  }) {
    super(input.message)
    this.name = 'ResolutionError'
    this.code = input.code
    this.bundle = input.bundle
    if (input.root !== undefined) this.root = input.root
    if (input.path !== undefined) this.path = input.path
    if (input.profile !== undefined) this.profile = input.profile
  }
}
