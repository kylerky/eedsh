/**
 * Source-declaration authoring. A source names a package eedsh provisions from
 * a git repository or a local checkout. The acquisition kind is derived from
 * `from` alone, and the builder resolves preparation defaults from that kind so
 * the plan records exactly the steps that will run.
 * @module @eedsh/config/source
 */
import type { PlanSource } from '@eedsh/plan'

/** Stable failure codes for source authoring. */
export type SourceDeclarationErrorCode = 'source.duplicate_package' | 'source.ref_on_local_checkout'

/** A structured source-authoring failure. */
export class SourceDeclarationError extends Error {
  readonly _tag = 'SourceDeclarationError'
  readonly code: SourceDeclarationErrorCode
  readonly packageName: string

  constructor(input: {
    readonly code: SourceDeclarationErrorCode
    readonly packageName: string
    readonly message: string
  }) {
    super(input.message)
    this.name = 'SourceDeclarationError'
    this.code = input.code
    this.packageName = input.packageName
  }
}

/** One authored source declaration. */
export interface SourceDeclaration {
  /** The acquisition location: a git URL or a local checkout path. */
  readonly from: string
  /** The git ref to provision; it applies to git sources only. */
  readonly ref?: string
  /**
   * Ordered argv preparation steps. A git source defaults to installing
   * dependencies and running the package build script; a local checkout
   * defaults to no steps.
   */
  readonly prepare?: readonly (readonly string[])[]
}

/** The acquisition kind one declaration names. */
export type SourceAcquisitionKind = 'git' | 'local'

const GIT_SCHEMES = new Set(['git', 'http', 'https', 'ssh', 'file'])
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/
const SCP_LIKE = /^[^@\s/]+@[^:@\s/]+:\S+$/

/** The preparation steps a git source runs when it omits `prepare`. */
export const GIT_PREPARE_DEFAULTS: readonly (readonly string[])[] = [
  ['pnpm', 'install'],
  ['pnpm', 'run', 'build'],
]

/** The preparation steps a local checkout runs when it omits `prepare`: none. */
export const LOCAL_PREPARE_DEFAULTS: readonly (readonly string[])[] = []

/**
 * Classify an acquisition location from the value alone. A `git`, `http`,
 * `https`, `ssh`, or `file` scheme, or an scp-like `user@host:path` form, is a
 * git source; any other value is a local checkout path.
 * @param from - the authored location.
 * @returns the acquisition kind.
 */
export function sourceAcquisitionKind(from: string): SourceAcquisitionKind {
  const scheme = SCHEME.exec(from)
  if (scheme !== null) {
    const name = scheme[1] ?? ''
    return GIT_SCHEMES.has(name.toLowerCase()) ? 'git' : 'local'
  }
  return SCP_LIKE.test(from) ? 'git' : 'local'
}

/** The conflict failure for one package declared twice, naming the package. */
export function duplicatePackageDeclaration(name: string): SourceDeclarationError {
  return new SourceDeclarationError({
    code: 'source.duplicate_package',
    packageName: name,
    message:
      `package ${JSON.stringify(name)} is declared through both .package() and .source(); ` +
      'declare exactly one dependency specification for it',
  })
}

/**
 * Normalize one authored declaration into its plan record, resolving the
 * preparation defaults and rejecting a ref on a local checkout.
 * @param name - the declared package name.
 * @param declaration - the authored declaration.
 * @returns the plain plan source record.
 * @throws {SourceDeclarationError} with `source.ref_on_local_checkout`.
 */
export function normalizeSourceDeclaration(
  name: string,
  declaration: SourceDeclaration,
): PlanSource {
  const kind = sourceAcquisitionKind(declaration.from)
  if (kind === 'local' && declaration.ref !== undefined) {
    throw new SourceDeclarationError({
      code: 'source.ref_on_local_checkout',
      packageName: name,
      message:
        `source ${JSON.stringify(name)} declares ref ${JSON.stringify(declaration.ref)} on the ` +
        `local checkout ${JSON.stringify(declaration.from)}; ref applies only to a git source`,
    })
  }
  const prepare =
    declaration.prepare ?? (kind === 'git' ? GIT_PREPARE_DEFAULTS : LOCAL_PREPARE_DEFAULTS)
  return {
    from: declaration.from,
    ...(declaration.ref === undefined ? {} : { ref: declaration.ref }),
    prepare: prepare.map((step) => [...step]),
  }
}
