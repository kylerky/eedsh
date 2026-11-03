/**
 * The DSH compatibility policy: one supported range applied to the discovered
 * installation. The range is CLI policy, not config or artifact data.
 * @module @eedsh/cli/dsh-policy
 */
import { createRequire } from 'node:module'

/** The one DSH release range eedsh supports. */
export const SUPPORTED_DSH_RANGE = '^0.2.1-rc.2'

interface Semver {
  satisfies(version: string, range: string, options?: { includePrerelease?: boolean }): boolean
}

const require = createRequire(import.meta.url)
const semver = require('semver') as Semver

/**
 * Whether a discovered DSH version satisfies eedsh's supported range.
 * Prereleases inside the range are accepted, including later alphas of the
 * next patch release.
 * @param version - the exact discovered version.
 * @returns whether the version is supported.
 */
export function supportsDshVersion(version: string): boolean {
  return semver.satisfies(version, SUPPORTED_DSH_RANGE, { includePrerelease: true })
}
