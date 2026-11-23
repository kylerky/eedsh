/**
 * The pure resolution vocabulary shared by authoring, the CLI resolver, and the
 * REPL. Authoring records descriptors over these types; the CLI performs the IO
 * that produces {@link ResolvedBundle} values and the table the terminal build
 * consumes. Nothing here reads the filesystem or depends on ambient state.
 * @module @eedsh/config/resolution
 */
import type { PlanEntry } from './builders'

/** The environment variable that selects a DSH installation explicitly. */
export const DSH_ANCHOR_ENV = 'EEDSH_DSH_ANCHOR'

/** The session-local profile-root override, a JSON object of name to directory. */
export const PROFILE_ROOT_OVERRIDE_ENV = 'EEDSH_PROFILE_ROOT_OVERRIDE'

/** One query root. Supply at most one of `profile` and `packageDir`. */
export interface QueryRoot {
  /** A profile name under the shared DSH home. */
  readonly profile?: string
  /** A package directory, absolute or relative to the containing config file. */
  readonly packageDir?: string
}

/** Where a resolved bundle came from. */
export type ResolutionOrigin = 'active' | 'profile' | 'packageDir' | 'preview'

/** The facts behind one successful bundle resolution. */
export interface ResolvedBundle {
  /** The queried bundle package name. */
  readonly bundle: string
  /** The root the bundle was resolved from. */
  readonly root: QueryRoot
  /** Absolute directory of the bundle package. */
  readonly packageDir: string
  /** Absolute path of the bundle's package.json. */
  readonly manifestPath: string
  /** The bundle package version, or `unknown` when it declares none. */
  readonly version: string
  /** The selected root. */
  readonly origin: ResolutionOrigin
  /** The profile name for a profile or preview root. */
  readonly profile?: string
  /** The composed rows the bundle declares, as frozen JSON. */
  readonly rows: readonly PlanEntry[]
}

/** One resolution event, used by the REPL to print provenance. */
export interface ResolutionTrace {
  readonly bundle: string
  readonly packageDir: string
  readonly manifestPath: string
  readonly version: string
  readonly origin: ResolutionOrigin
  readonly profile?: string
}

/**
 * The invocation's resolved bundles, keyed by bundle name and serialized root.
 * It is total over the descriptors a builder reports; the CLI resolves every
 * one before `build()`.
 */
export interface ResolutionTable {
  /** Every resolved bundle, in resolution order. */
  readonly bundles: readonly ResolvedBundle[]
}

/** The values a config factory receives from the invocation that evaluates it. */
export interface ConfigInput {
  /** The exact version of the DSH installation selected for the invocation. */
  readonly dshVersion: string
  /** The absolute directory containing the config module. */
  readonly configDir: string
}

/** The serialized form of one query root. */
export function queryRootKey(root: QueryRoot): string {
  if (root.profile !== undefined && root.packageDir !== undefined) {
    return `conflict:\u0000${root.profile}\u0000${root.packageDir}`
  }
  if (root.profile !== undefined) return `profile:\u0000${root.profile}`
  if (root.packageDir !== undefined) return `packageDir:\u0000${root.packageDir}`
  return 'active'
}

/**
 * The stable key that pairs a bundle with one root.
 * @param bundle - the bundle package name.
 * @param root - the recorded root.
 * @returns the resolution table key.
 */
export function queryKey(bundle: string, root: QueryRoot): string {
  return `${bundle}\u0000${queryRootKey(root)}`
}

/**
 * Find one resolved bundle in a table.
 * @param table - the invocation resolution.
 * @param bundle - the bundle package name.
 * @param root - the recorded root.
 * @returns the resolved bundle, or undefined when the table has no entry.
 */
export function findResolved(
  table: ResolutionTable,
  bundle: string,
  root: QueryRoot,
): ResolvedBundle | undefined {
  return table.bundles.find(
    (item) => item.bundle === bundle && queryKey(item.bundle, item.root) === queryKey(bundle, root),
  )
}
