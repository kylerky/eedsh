/**
 * Best-effort patch provenance. The authoring builders record where each
 * emitted patch entry was written, so a command can attribute a composition
 * warning to the config line that produced it. Capture never fails evaluation:
 * a missing or unparseable stack frame simply records no site.
 *
 * The record crosses the module boundary through a process-global symbol
 * because a config project may resolve its own copy of `@eedsh/config`.
 * @module @eedsh/config/provenance
 */
import { fileURLToPath } from 'node:url'

/** One authoring site; the file is absolute in memory. */
export interface AuthoringSite {
  /** Absolute path of the file that called the builder. */
  readonly file: string
  /** One-based line of the call. */
  readonly line: number
  /** One-based column of the call. */
  readonly column: number
}

/** One generated patch group's authoring record. */
export interface PatchGroupProvenance {
  /** The optional display label supplied with `.layer(label, build)`. */
  readonly label: string | undefined
  /** One entry per emitted patch, aligned with the group's patch order. */
  readonly sites: readonly (AuthoringSite | undefined)[]
}

/** The most recent config evaluation's provenance, keyed by profile. */
export interface ConfigProvenance {
  /** Profiles in declaration order, each with its ordered patch groups. */
  readonly profiles: Readonly<Record<string, readonly PatchGroupProvenance[]>>
}

const PROVENANCE_KEY = Symbol.for('@eedsh/config.provenance')

interface ProvenanceStore {
  profiles: Record<string, PatchGroupProvenance[]>
}

function globalSlot(): typeof globalThis & { [key: symbol]: unknown } {
  return globalThis as typeof globalThis & { [key: symbol]: unknown }
}

function store(): ProvenanceStore {
  const global = globalSlot()
  const existing = global[PROVENANCE_KEY]
  if (existing !== null && typeof existing === 'object' && 'profiles' in existing) {
    return existing as ProvenanceStore
  }
  const created: ProvenanceStore = { profiles: {} }
  global[PROVENANCE_KEY] = created
  return created
}

/** Remove the recorded provenance; the next evaluation records from scratch. */
export function clearProvenance(): void {
  delete globalSlot()[PROVENANCE_KEY]
}

/**
 * Read the most recent evaluation's provenance.
 * @returns the record, or undefined when nothing has been recorded.
 */
export function configProvenance(): ConfigProvenance | undefined {
  const existing = globalSlot()[PROVENANCE_KEY]
  if (existing === null || typeof existing !== 'object' || !('profiles' in existing)) {
    return undefined
  }
  return existing as ConfigProvenance
}

/**
 * Replace one profile's recorded groups with the latest evaluation's record.
 * @param name - the profile key.
 * @param groups - the profile's groups in declaration order.
 */
export function recordProfileProvenance(
  name: string,
  groups: readonly PatchGroupProvenance[],
): void {
  store().profiles[name] = groups.map((group) => ({ label: group.label, sites: [...group.sites] }))
}

/** The authoring package module directory, in both the `lib/` and `src/` layouts. */
const MODULE_DIR = moduleDirectory(import.meta.url)

/** One V8 stack frame with an absolute file, line, and column. */
const STACK_FRAME = /^\s*at\s+(?:async\s+)?(?:.*?\s+\()?(.+?):(\d+):(\d+)\)?\s*$/

/** Convert a stack-frame module URL to a host path when it is a file URL. */
function framePath(file: string): string {
  if (!file.startsWith('file://')) return file
  try {
    return fileURLToPath(file)
  } catch {
    return decodeURIComponent(file.slice('file://'.length))
  }
}

function moduleDirectory(url: string): string {
  const path = framePath(url)
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? path : path.slice(0, slash)
}

function isAbsolutePath(file: string): boolean {
  return file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file)
}

function isInside(file: string, directory: string): boolean {
  return file === directory || file.startsWith(`${directory}/`) || file.startsWith(`${directory}\\`)
}

function frameSite(line: string): AuthoringSite | undefined {
  const match = STACK_FRAME.exec(line)
  if (match === null) return undefined
  // A cache-busting query on an evaluated module URL is not part of the path.
  const file = framePath((match[1] as string).replace(/\?eedsh=[^#]*$/, ''))
  if (!isAbsolutePath(file)) return undefined
  if (isInside(file, MODULE_DIR)) return undefined
  const lineNumber = Number(match[2])
  const column = Number(match[3])
  if (!Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(column)) return undefined
  return { file, line: lineNumber, column }
}

/**
 * Capture the first call site outside the authoring package, best effort.
 * Internal frames (builders, this module) are skipped, so the result is the
 * author's config file or a helper it delegates to.
 * @returns the site, or undefined when the stack has no usable frame.
 */
export function captureAuthoringSite(): AuthoringSite | undefined {
  const stack = new Error().stack
  if (typeof stack !== 'string') return undefined
  for (const line of stack.split('\n')) {
    const site = frameSite(line)
    if (site !== undefined) return site
  }
  return undefined
}
