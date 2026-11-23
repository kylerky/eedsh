/**
 * CLI-side installation anchor helpers: locate the shared record, decode it
 * against the format contract with effect/Schema, validate the referenced
 * package, and write it atomically. Discovery,
 * `init --dsh`, and the sync bootstrap all go through this module so the path
 * and schema have one home. Every filesystem read and write runs through the
 * FileSystem service, so the store seam is effectful. Nothing here reads or
 * writes the config project.
 * @module @eedsh/cli/installation-anchor
 */
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  cleanupRetiredInstallationAnchorSync,
  encodeInstallationAnchor,
  INSTALLATION_ANCHOR_FORMAT,
  type InstallationAnchor,
  type InstallationAnchorManager,
  installationAnchorPath,
} from '@eedsh/runtime/installation-anchor'
import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import type * as SchemaIssue from 'effect/SchemaIssue'
import { SUPPORTED_DSH_RANGE, supportsDshVersion } from './dsh-policy'
import { resolveDshHome } from './internal/dsh-home'
import { DshFailure } from './internal/effect/errors'
import { messageOf } from './internal/error-message'
import { readNonEmptyString, readOptionalString, readRecord } from './internal/schema-readers'

/** The DSH package name the anchor must name. */
export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'

/** The package-relative launcher entry every supported DSH provides. */
const DSH_LAUNCHER = join('lib', 'bin.js')

/** A validated installation selected from a path or a recorded anchor. */
export interface ValidatedInstallation {
  /** The exact package version. */
  readonly version: string
  /** Absolute path of the package.json. */
  readonly installAnchor: string
  /** Absolute package directory. */
  readonly packageDir: string
  /** Absolute launcher entry resolved from the package manifest. */
  readonly binPath: string
}

/** The anchor snapshot a command sees for one environment. */
export interface InstallationAnchorSnapshot {
  /** Absolute path of the record, whether or not it exists. */
  readonly path: string
  /** The valid record, when one was read. */
  readonly record?: InstallationAnchor | undefined
  /** Why no record is available, when applicable. */
  readonly problem?: string | undefined
}

/** What one anchor write reported. */
export type InstallationAnchorWrite =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/**
 * The installation anchor storage seam. Commands inject a store in tests; the
 * default reads and writes the machine-local record below the DSH home.
 */
export interface InstallationAnchorStore {
  /** Read the valid record for an environment, or undefined. */
  read(
    env: Record<string, string | undefined>,
  ): Effect.Effect<InstallationAnchor | undefined, never, FileSystem.FileSystem>
  /** Atomically write the record for an environment. */
  write(
    env: Record<string, string | undefined>,
    anchor: InstallationAnchor,
  ): Effect.Effect<InstallationAnchorWrite, never, FileSystem.FileSystem>
}

/** Build one tagged discovery failure. */
export function dshFailure(input: {
  code: ConstructorParameters<typeof DshFailure>[0]['code']
  message: string
  path?: string
  version?: string
  range?: string
  capability?: string
  cause?: unknown
}): DshFailure {
  return new DshFailure({
    code: input.code,
    message: input.message,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.range === undefined ? {} : { range: input.range }),
    ...(input.capability === undefined ? {} : { capability: input.capability }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  })
}

/**
 * Build the failure for a PATH launcher whose package cannot be located. The
 * message names every remedy: the pnpm/npm-only boundary, `--dsh`,
 * `EEDSH_DSH_ANCHOR`, and one eedsh-managed profile boot.
 * @param launcher - the PATH launcher path.
 * @param detail - optional reason, such as the candidates that could not be chosen.
 * @returns the tagged failure.
 */
export function launcherUnresolvedFailure(launcher: string, detail?: string): DshFailure {
  const reason = detail === undefined ? '' : `: ${detail}`
  return dshFailure({
    code: 'dsh.launcher_unresolved',
    path: launcher,
    message:
      `cannot resolve the dsh launcher ${launcher} to an @deepseek-ai/dsh package${reason}. ` +
      'Automatic bootstrap supports pnpm and npm only; pass --dsh <package dir|package.json>, ' +
      'set EEDSH_DSH_ANCHOR, or boot an eedsh-managed profile once ("eedsh run") so the runtime ' +
      'records the installation anchor, then run "eedsh sync"',
  })
}

/**
 * Resolve the anchor record path for an environment through the existing DSH
 * home resolution.
 * @param env - environment mapping.
 * @returns the absolute record path below the DSH home.
 */
export function installationAnchorPathForEnv(env: Record<string, string | undefined>): string {
  return installationAnchorPath(resolveDshHome(undefined, env))
}

/**
 * Refine a schema with a filter while keeping the precise derived type.
 * Explicitly passing the base schema keeps the inferred filter schema typed;
 * an untyped curried filter would widen the type to `any`.
 */
function refine<S extends Schema.Top>(
  self: S,
  predicate: (value: S['Type']) => Schema.FilterOutput,
): S['Rebuild'] {
  return Schema.check<S>(Schema.makeFilter<S['Type']>(predicate))(self)
}

/** An absolute package.json path. */
const anchorPathSchema = refine(
  refine(Schema.NonEmptyString, (anchor) => isAbsolute(anchor)),
  (anchor) => basename(anchor) === 'package.json',
)

/** An absolute launcher path. */
const launcherPathSchema = refine(Schema.NonEmptyString, (launcher) => isAbsolute(launcher))

/** The package managers the automatic bootstrap supports. */
const managerSchema = Schema.Union([Schema.Literal('pnpm'), Schema.Literal('npm')])

/**
 * The strict format-1 anchor record. The field order is the validation order,
 * so the first decode issue is the same first defect a hand-written validator
 * reports. Extra fields are ignored and dropped.
 */
export const InstallationAnchorSchema = Schema.Struct({
  format: Schema.Literal(INSTALLATION_ANCHOR_FORMAT),
  installAnchor: anchorPathSchema,
  version: Schema.optionalKey(Schema.NonEmptyString),
  launcher: Schema.optionalKey(launcherPathSchema),
  manager: Schema.optionalKey(managerSchema),
  recordedBy: Schema.optionalKey(Schema.NonEmptyString),
  recordedAt: Schema.optionalKey(Schema.NonEmptyString),
})

/** A decoded record or the reason it was rejected. */
export type InstallationAnchorDecode =
  | { readonly ok: true; readonly anchor: InstallationAnchor }
  | { readonly ok: false; readonly reason: string }

/** Follow the first issue path through pointer and composite nodes. */
function firstIssuePath(issue: SchemaIssue.Issue): PropertyKey[] {
  if (issue._tag === 'Pointer') return [...issue.path, ...firstIssuePath(issue.issue)]
  if (issue._tag === 'Composite' && issue.issues[0] !== undefined) {
    return firstIssuePath(issue.issues[0])
  }
  return []
}

/**
 * Keep the recorded rejection reason for one failed decode. The field named by
 * the issue path decides the wording; the raw value supplies the quoted detail
 * the message includes.
 */
function rejectionReason(path: readonly PropertyKey[], record: Record<string, unknown>): string {
  const [field] = path
  switch (field) {
    case 'format':
      return `unsupported installation anchor format ${JSON.stringify(record.format)}; expected ${INSTALLATION_ANCHOR_FORMAT}`
    case 'installAnchor': {
      const installAnchor = record.installAnchor
      if (typeof installAnchor !== 'string' || installAnchor.length === 0) {
        return 'the installation anchor has no installAnchor path'
      }
      if (!isAbsolute(installAnchor)) {
        return `installAnchor must be an absolute package.json path: ${JSON.stringify(installAnchor)}`
      }
      return `installAnchor must name a package.json: ${JSON.stringify(installAnchor)}`
    }
    case 'version':
      return 'version must be a non-empty string when present'
    case 'launcher': {
      const launcher = record.launcher
      if (typeof launcher !== 'string' || launcher.length === 0) {
        return 'launcher must be a non-empty string when present'
      }
      return `launcher must be absolute when present: ${JSON.stringify(launcher)}`
    }
    case 'manager':
      return `manager must be "pnpm" or "npm" when present: ${JSON.stringify(record.manager)}`
    case 'recordedBy':
      return 'recordedBy must be a non-empty string when present'
    case 'recordedAt':
      return 'recordedAt must be a non-empty string when present'
    default:
      return 'the installation anchor must be a JSON object'
  }
}

/**
 * Parse and decode one anchor record. The schema is the record contract; a
 * rejected record keeps the reason wording the contract has always used.
 * @param text - the record file's text.
 * @returns the normalized record, or the rejection reason.
 */
export function decodeInstallationAnchor(text: string): InstallationAnchorDecode {
  const parsed = Result.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => cause,
  })
  if (Result.isFailure(parsed)) {
    return {
      ok: false,
      reason: `the installation anchor is not valid JSON: ${messageOf(parsed.failure)}`,
    }
  }
  const decoded = Schema.decodeUnknownResult(InstallationAnchorSchema, { errors: 'first' })(
    parsed.success,
  )
  if (Result.isFailure(decoded)) {
    return {
      ok: false,
      reason: rejectionReason(firstIssuePath(decoded.failure.issue), readRecord(parsed.success)),
    }
  }
  // The schema output is the runtime record type; this annotation keeps the
  // codec and the shared record in step at compile time.
  const anchor: InstallationAnchor = decoded.success
  return { ok: true, anchor }
}

/**
 * Read and decode the anchor snapshot for an environment.
 * @param env - environment mapping.
 * @returns the snapshot, reporting missing or malformed records as a problem.
 */
export function readInstallationAnchorSnapshot(
  env: Record<string, string | undefined>,
): Effect.Effect<InstallationAnchorSnapshot, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = installationAnchorPathForEnv(env)
    const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => undefined))
    if (text === undefined) return { path, problem: 'no installation anchor is recorded' }
    const decoded = decodeInstallationAnchor(text)
    return decoded.ok ? { path, record: decoded.anchor } : { path, problem: decoded.reason }
  })
}

/** A DSH package manifest is a foreign JSON object; its fields are read as leaves. */
const manifestSchema = Schema.Record(Schema.String, Schema.Unknown)

/** The two `bin` shapes a DSH package may declare. */
const launcherBinSchema = Schema.Union([Schema.String, Schema.Struct({ dsh: Schema.String })])

/**
 * Read one package manifest as a foreign JSON object, or undefined when it
 * cannot be read, parsed, or is not a JSON object.
 * @param anchor - absolute package.json path.
 * @returns the manifest record, or undefined.
 */
export function readPackageManifest(
  anchor: string,
): Effect.Effect<Record<string, unknown> | undefined, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(anchor).pipe(Effect.orElseSucceed(() => undefined))
    if (text === undefined) return undefined
    const parsed = Result.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => undefined,
    })
    if (Result.isFailure(parsed)) return undefined
    const decoded = Schema.decodeUnknownOption(manifestSchema)(parsed.success)
    return Option.isSome(decoded) ? decoded.value : undefined
  })
}

function resolveLauncherEntry(
  manifest: Record<string, unknown>,
  packageDir: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const bin = Schema.decodeUnknownOption(launcherBinSchema)(manifest.bin)
    let relative: string | undefined
    if (Option.isSome(bin)) {
      relative = typeof bin.value === 'string' ? bin.value : bin.value.dsh
    }
    if (relative === undefined) {
      const main = readOptionalString(manifest.main)
      if (Option.isSome(main)) relative = main.value
    }
    const candidate =
      relative === undefined ? join(packageDir, DSH_LAUNCHER) : resolve(packageDir, relative)
    const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))
    return exists ? candidate : undefined
  })
}

/**
 * Validate one package.json anchor as a supported DSH installation.
 * @param anchor - absolute package.json path.
 * @param pathShown - the path to name in diagnostics.
 * @param options - whether to require the supported version range.
 * @returns the validated installation, or a tagged failure.
 */
export function installationFromManifestAnchor(
  anchor: string,
  pathShown: string,
  options: { requireSupported?: boolean } = {},
): Effect.Effect<Result.Result<ValidatedInstallation, DshFailure>, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const physical = yield* fs.realPath(anchor).pipe(Effect.orElseSucceed(() => anchor))
    const manifest = yield* readPackageManifest(physical)
    if (manifest === undefined) {
      return Result.fail(
        dshFailure({
          code: 'dsh.anchor_invalid',
          path: pathShown,
          message: `cannot read a DSH manifest at ${pathShown}: expected a package.json`,
        }),
      )
    }
    const name = readOptionalString(manifest.name)
    if (Option.isNone(name) || name.value !== DSH_PACKAGE_NAME) {
      return Result.fail(
        dshFailure({
          code: 'dsh.anchor_invalid',
          path: pathShown,
          message: `${pathShown} is not a ${DSH_PACKAGE_NAME} package (found ${JSON.stringify(manifest.name)})`,
        }),
      )
    }
    const version = readNonEmptyString(manifest.version)
    if (Option.isNone(version)) {
      return Result.fail(
        dshFailure({
          code: 'dsh.anchor_invalid',
          path: pathShown,
          message: `${pathShown} declares no DSH version`,
        }),
      )
    }
    if (options.requireSupported === true && !supportsDshVersion(version.value)) {
      return Result.fail(
        dshFailure({
          code: 'dsh.unsupported_version',
          path: pathShown,
          version: version.value,
          range: SUPPORTED_DSH_RANGE,
          message: `DSH ${version.value} is outside eedsh's supported range ${SUPPORTED_DSH_RANGE}`,
        }),
      )
    }
    const packageDir = dirname(physical)
    const binPath = yield* resolveLauncherEntry(manifest, packageDir)
    if (binPath === undefined) {
      return Result.fail(
        dshFailure({
          code: 'dsh.anchor_invalid',
          path: pathShown,
          message: `${pathShown} declares no resolvable launcher entry`,
        }),
      )
    }
    return Result.succeed({ version: version.value, installAnchor: physical, packageDir, binPath })
  })
}

/**
 * Validate an explicit package directory or package.json path.
 * @param input - the user-supplied path.
 * @param cwd - directory for relative paths.
 * @param options - whether to require the supported version range.
 * @returns the validated installation, or a tagged failure.
 */
export function installationFromSelection(
  input: string,
  cwd: string,
  options: { requireSupported?: boolean } = {},
): Effect.Effect<Result.Result<ValidatedInstallation, DshFailure>, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const absolute = isAbsolute(input) ? input : resolve(cwd, input)
    const stats = yield* Effect.result(fs.stat(absolute))
    if (Result.isFailure(stats)) {
      return Result.fail(
        dshFailure({
          code: 'dsh.anchor_invalid',
          path: input,
          message: `cannot read the DSH installation at ${input}`,
          cause: stats.failure,
        }),
      )
    }
    let anchor: string
    if (stats.success.type === 'Directory') {
      anchor = join(absolute, 'package.json')
    } else if (basename(absolute) === 'package.json') {
      anchor = absolute
    } else {
      return Result.fail(
        dshFailure({
          code: 'dsh.anchor_invalid',
          path: input,
          message: `${input} is not a DSH package directory or package.json`,
        }),
      )
    }
    return yield* installationFromManifestAnchor(anchor, input, options)
  })
}

/**
 * Validate a recorded anchor and the package it names. The manifest and the
 * supported range stay authoritative; a record version that disagrees with the
 * manifest makes the record stale.
 * @param record - the decoded anchor.
 * @returns the validated installation, or a tagged failure.
 */
export function validateRecordedInstallation(
  record: InstallationAnchor,
): Effect.Effect<Result.Result<ValidatedInstallation, DshFailure>, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const validated = yield* installationFromManifestAnchor(
      record.installAnchor,
      record.installAnchor,
      { requireSupported: true },
    )
    if (Result.isFailure(validated)) return validated
    if (record.version !== undefined && record.version !== validated.success.version) {
      return Result.fail(
        dshFailure({
          code: 'dsh.anchor_invalid',
          path: record.installAnchor,
          version: validated.success.version,
          message:
            `the recorded anchor version ${record.version} does not match the installed DSH ` +
            `${validated.success.version} at ${record.installAnchor}`,
        }),
      )
    }
    return validated
  })
}

/** Provenance supplied when a command records an installation. */
export interface AnchorProvenance {
  /** The command or component that recorded the anchor. */
  readonly recordedBy: string
  /** The PATH launcher, when one selected the installation. */
  readonly launcher?: string | undefined
  /** The package manager that supplied the candidate, when applicable. */
  readonly manager?: InstallationAnchorManager | undefined
  /** Override the recording time, for tests. */
  readonly recordedAt?: string | undefined
}

/**
 * Build a format-1 record for one validated installation.
 * @param installation - the validated installation.
 * @param provenance - who recorded it and from where.
 * @returns the record to write.
 */
export function anchorForInstallation(
  installation: Pick<ValidatedInstallation, 'version' | 'installAnchor'>,
  provenance: AnchorProvenance,
): InstallationAnchor {
  return {
    format: 1,
    installAnchor: installation.installAnchor,
    version: installation.version,
    ...(provenance.launcher === undefined ? {} : { launcher: provenance.launcher }),
    ...(provenance.manager === undefined ? {} : { manager: provenance.manager }),
    recordedBy: provenance.recordedBy,
    recordedAt: provenance.recordedAt ?? new Date().toISOString(),
  }
}

/**
 * Atomically write the anchor below the environment's DSH home. Failures are
 * returned rather than raised. A successful write also removes the retired
 * `.eedsh/installation.json` location.
 * @param env - environment mapping.
 * @param anchor - the record to write.
 * @returns whether the record was written.
 */
export function writeInstallationAnchor(
  env: Record<string, string | undefined>,
  anchor: InstallationAnchor,
): Effect.Effect<InstallationAnchorWrite, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const home = resolveDshHome(undefined, env)
    const path = installationAnchorPath(home)
    const directory = dirname(path)
    let temp: string | undefined
    const written = yield* Effect.result(
      Effect.gen(function* () {
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
        temp = join(directory, `.installation.json.${process.pid}.${randomUUID()}.tmp`)
        yield* fs.writeFileString(temp, encodeInstallationAnchor(anchor), { mode: 0o600 })
        yield* fs.rename(temp, path)
      }),
    )
    if (Result.isFailure(written)) {
      const failedTemp = temp
      if (failedTemp !== undefined) {
        // The target record is untouched; cleanup is best effort.
        yield* fs.remove(failedTemp, { force: true }).pipe(Effect.orElseSucceed(() => undefined))
      }
      return { ok: false, error: messageOf(written.failure) }
    }
    // Windows has no POSIX mode bits; the owner-only intent is best effort there.
    yield* fs.chmod(path, 0o600).pipe(Effect.orElseSucceed(() => undefined))
    cleanupRetiredInstallationAnchorSync(home)
    return { ok: true }
  })
}

/** The default anchor store: the machine-local record below the DSH home. */
export const defaultInstallationAnchorStore: InstallationAnchorStore = {
  read: (env) =>
    readInstallationAnchorSnapshot(env).pipe(Effect.map((snapshot) => snapshot.record)),
  write: (env, anchor) => writeInstallationAnchor(env, anchor),
}
