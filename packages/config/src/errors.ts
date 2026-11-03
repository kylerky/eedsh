/**
 * Structured author-time resolution failures. Every failure carries a stable
 * code so the CLI and REPL can report it without matching message text.
 * @module @eedsh/config/errors
 */

/** Stable failure codes for author-time resolution. */
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

/** A structured author-time resolution failure. */
export class ResolutionError extends Error {
  readonly _tag = 'ResolutionError'
  readonly code: ResolutionErrorCode
  readonly bundle: string
  readonly path?: string
  readonly profile?: string

  constructor(input: {
    readonly code: ResolutionErrorCode
    readonly bundle: string
    readonly message: string
    readonly path?: string
    readonly profile?: string
  }) {
    super(input.message)
    this.name = 'ResolutionError'
    this.code = input.code
    this.bundle = input.bundle
    if (input.path !== undefined) this.path = input.path
    if (input.profile !== undefined) this.profile = input.profile
  }
}
