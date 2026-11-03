/**
 * Source provisioning locations. The acquisition kind is the authoring rule,
 * shared with `@eedsh/config` so a declaration is classified the same way when
 * it is authored and when it is provisioned. A local checkout resolves to an
 * absolute directory here; a git location stays as authored because git
 * resolves it.
 * @module @eedsh/cli/provision/source
 */
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { type SourceAcquisitionKind, sourceAcquisitionKind } from '@eedsh/config'
import type { PlanSource } from '@eedsh/plan'
import { sha256 } from '../internal/sha256'

export { type SourceAcquisitionKind, sourceAcquisitionKind }

/** One source location resolved for provisioning. */
export interface ResolvedSourceLocation {
  /** How the source is acquired. */
  readonly kind: SourceAcquisitionKind
  /** The absolute directory for a local checkout, or the authored git location. */
  readonly location: string
}

/** Expand `~`, `~/`, and `~\\` prefixes against one home directory. */
function expandHome(from: string, home: string): string {
  if (from === '~') return home
  if (from.startsWith('~/') || from.startsWith('~\\')) return join(home, from.slice(2))
  return from
}

/**
 * Resolve one declared location for provisioning. A relative path resolves
 * against the config directory and a leading `~/` expands to the user home; a
 * git location is left as authored.
 * @param from - the authored acquisition location.
 * @param configDir - the absolute directory holding the config file.
 * @param home - the user home for `~/` expansion; defaults to the OS home.
 * @returns the acquisition kind and the resolved location.
 */
export function resolveSourceLocation(
  from: string,
  configDir: string,
  home: string = homedir(),
): ResolvedSourceLocation {
  const kind = sourceAcquisitionKind(from)
  if (kind === 'git') return { kind, location: from }
  const expanded = expandHome(from, home)
  return {
    kind,
    location: isAbsolute(expanded) ? expanded : resolve(configDir, expanded),
  }
}

/** Directory parts below the DSH home that hold provisioned working trees. */
const SOURCES_PARTS = ['.local', 'sources'] as const

/** Directory parts below the DSH home that hold provisioning records. */
const SOURCE_STATE_PARTS = ['.local', 'state', 'sources'] as const

/** Directory parts below the DSH home that hold provisioning locks. */
const SOURCE_LOCK_PARTS = ['.local', 'locks'] as const

/** The readable part of a source key: the location's directory without `.git`. */
function sourceSlug(from: string): string {
  const directory = basename(from)
  const withoutGit = directory.endsWith('.git') ? directory.slice(0, -4) : directory
  const sanitized = withoutGit
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
  return sanitized === '' ? 'source' : sanitized
}

/**
 * Derive the stable identity of one source declaration. The key depends on the
 * authored location and ref only, so one repository and ref pair maps to one
 * checkout, distinct refs never share a working tree, and every invocation
 * derives the same name.
 * @param source - the declaration's location and optional ref.
 * @returns one safe directory name.
 */
export function sourceKey(source: Pick<PlanSource, 'from' | 'ref'>): string {
  const identity = `${source.from}\u0000${source.ref ?? ''}`
  return `${sourceSlug(source.from)}-${sha256(identity).slice(0, 16)}`
}

/**
 * The provisioned working tree for one source key.
 * @param home - the absolute DSH home.
 * @param key - the source key.
 * @returns the absolute checkout directory.
 */
export function sourceCheckoutDir(home: string, key: string): string {
  return join(home, ...SOURCES_PARTS, key)
}

/**
 * The provisioning record for one source key.
 * @param home - the absolute DSH home.
 * @param key - the source key.
 * @returns the absolute record path.
 */
export function sourceStatePath(home: string, key: string): string {
  return join(home, ...SOURCE_STATE_PARTS, `${key}.json`)
}

/**
 * The profile dependency specification for one provisioned source: a link to
 * the provisioned directory, written with forward slashes for portability.
 * @param checkoutDir - the provisioned directory.
 * @returns the link specification.
 */
export function sourceLinkSpec(checkoutDir: string): string {
  return `link:${checkoutDir.replaceAll('\\', '/')}`
}

/**
 * The provision lock for one source key.
 * @param home - the absolute DSH home.
 * @param key - the source key.
 * @returns the absolute lock path.
 */
export function sourceLockPath(home: string, key: string): string {
  return join(home, ...SOURCE_LOCK_PARTS, `${key}.lock`)
}
