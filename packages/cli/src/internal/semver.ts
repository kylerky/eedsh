/**
 * The semver seam for doctor's lockfile and installed-version checks. Effect's
 * `SemVer` is marked unstable, so every call goes through this module; a future
 * replacement stays local to one file.
 * @module @eedsh/cli/internal/semver
 */
import { SemVer, SemVerRange } from 'effect'
import * as Result from 'effect/Result'

/**
 * Whether a dependency specification is an npm-style semantic-version range.
 * @param spec - the recorded specification.
 * @returns whether the specification parses as a range.
 */
export function isSemverRange(spec: string): boolean {
  return Result.isSuccess(SemVerRange.parse(spec))
}

/**
 * Check a concrete version against a semantic-version specification.
 * @param spec - the recorded specification.
 * @param version - the concrete version to check.
 * @returns whether it matches, or undefined when either side cannot be parsed.
 */
export function versionSatisfies(spec: string, version: string): boolean | undefined {
  const range = SemVerRange.parse(spec)
  if (Result.isFailure(range)) return undefined
  const parsed = SemVer.parse(version)
  if (Result.isFailure(parsed)) return undefined
  return SemVerRange.matches(range.success, parsed.success)
}
