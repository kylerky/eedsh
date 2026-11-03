/**
 * CLI-side installation anchor helpers: locate the shared record, parse it,
 * validate the referenced package, and write it atomically. Discovery,
 * `init --dsh`, and the sync bootstrap all go through this module so the path
 * and schema have one home. Nothing here reads or writes the config project.
 * @module @eedsh/cli/installation-anchor
 */
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  cleanupRetiredInstallationAnchorSync,
  decodeInstallationAnchor,
  encodeInstallationAnchor,
  type InstallationAnchor,
  type InstallationAnchorManager,
  installationAnchorPath,
} from '@eedsh/runtime/installation-anchor'
import * as Result from 'effect/Result'
import { SUPPORTED_DSH_RANGE, supportsDshVersion } from './dsh-policy'
import { resolveDshHome } from './internal/dsh-home'
import { DshFailure } from './internal/effect/errors'
import { messageOf } from './internal/error-message'

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
  read(env: Record<string, string | undefined>): InstallationAnchor | undefined
  /** Atomically write the record for an environment. */
  write(
    env: Record<string, string | undefined>,
    anchor: InstallationAnchor,
  ): InstallationAnchorWrite
}

interface Manifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly bin?: unknown
  readonly main?: unknown
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
 * Read and decode the anchor snapshot for an environment.
 * @param env - environment mapping.
 * @param readText - text reader seam; defaults to the Node file system.
 * @returns the snapshot, reporting missing or malformed records as a problem.
 */
export function readInstallationAnchorSnapshot(
  env: Record<string, string | undefined>,
  readText: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): InstallationAnchorSnapshot {
  const path = installationAnchorPathForEnv(env)
  let text: string
  try {
    text = readText(path)
  } catch {
    return { path, problem: 'no installation anchor is recorded' }
  }
  const decoded = decodeInstallationAnchor(text)
  return decoded.ok ? { path, record: decoded.anchor } : { path, problem: decoded.reason }
}

/** Read one package manifest, or undefined when it cannot be parsed. */
export function readPackageManifest(anchor: string): Manifest | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(anchor, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Manifest
  } catch {
    return undefined
  }
}

function resolveLauncherEntry(manifest: Manifest, packageDir: string): string | undefined {
  const bin = manifest.bin
  let relative: string | undefined
  if (typeof bin === 'string') relative = bin
  else if (bin !== null && typeof bin === 'object' && !Array.isArray(bin)) {
    const dsh = (bin as Record<string, unknown>).dsh
    if (typeof dsh === 'string') relative = dsh
  }
  if (relative === undefined && typeof manifest.main === 'string') relative = manifest.main
  const candidate =
    relative === undefined ? join(packageDir, DSH_LAUNCHER) : resolve(packageDir, relative)
  return existsSync(candidate) ? candidate : undefined
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
): Result.Result<ValidatedInstallation, DshFailure> {
  let physical = anchor
  try {
    physical = realpathSync(anchor)
  } catch {
    physical = anchor
  }
  const manifest = readPackageManifest(physical)
  if (manifest === undefined) {
    return Result.fail(
      dshFailure({
        code: 'dsh.anchor_invalid',
        path: pathShown,
        message: `cannot read a DSH manifest at ${pathShown}: expected a package.json`,
      }),
    )
  }
  if (manifest.name !== DSH_PACKAGE_NAME) {
    return Result.fail(
      dshFailure({
        code: 'dsh.anchor_invalid',
        path: pathShown,
        message: `${pathShown} is not a ${DSH_PACKAGE_NAME} package (found ${JSON.stringify(manifest.name)})`,
      }),
    )
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    return Result.fail(
      dshFailure({
        code: 'dsh.anchor_invalid',
        path: pathShown,
        message: `${pathShown} declares no DSH version`,
      }),
    )
  }
  if (options.requireSupported === true && !supportsDshVersion(manifest.version)) {
    return Result.fail(
      dshFailure({
        code: 'dsh.unsupported_version',
        path: pathShown,
        version: manifest.version,
        range: SUPPORTED_DSH_RANGE,
        message: `DSH ${manifest.version} is outside eedsh's supported range ${SUPPORTED_DSH_RANGE}`,
      }),
    )
  }
  const packageDir = dirname(physical)
  const binPath = resolveLauncherEntry(manifest, packageDir)
  if (binPath === undefined) {
    return Result.fail(
      dshFailure({
        code: 'dsh.anchor_invalid',
        path: pathShown,
        message: `${pathShown} declares no resolvable launcher entry`,
      }),
    )
  }
  return Result.succeed({ version: manifest.version, installAnchor: physical, packageDir, binPath })
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
): Result.Result<ValidatedInstallation, DshFailure> {
  const absolute = isAbsolute(input) ? input : resolve(cwd, input)
  let anchor: string
  try {
    const stats = statSync(absolute)
    if (stats.isDirectory()) anchor = join(absolute, 'package.json')
    else if (basename(absolute) === 'package.json') anchor = absolute
    else {
      return Result.fail(
        dshFailure({
          code: 'dsh.anchor_invalid',
          path: input,
          message: `${input} is not a DSH package directory or package.json`,
        }),
      )
    }
  } catch (cause) {
    return Result.fail(
      dshFailure({
        code: 'dsh.anchor_invalid',
        path: input,
        message: `cannot read the DSH installation at ${input}`,
        cause,
      }),
    )
  }
  return installationFromManifestAnchor(anchor, input, options)
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
): Result.Result<ValidatedInstallation, DshFailure> {
  const validated = installationFromManifestAnchor(record.installAnchor, record.installAnchor, {
    requireSupported: true,
  })
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
 * Atomically write the anchor below the environment's DSH home. The write is
 * synchronous because discovery runs before the command's Effect services are
 * built; failures are returned rather than thrown.
 * A successful write also removes the retired `.eedsh/installation.json`
 * location.
 * @param env - environment mapping.
 * @param anchor - the record to write.
 * @returns whether the record was written.
 */
export function writeInstallationAnchorSync(
  env: Record<string, string | undefined>,
  anchor: InstallationAnchor,
): InstallationAnchorWrite {
  const home = resolveDshHome(undefined, env)
  const path = installationAnchorPath(home)
  const directory = dirname(path)
  let temp: string | undefined
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    temp = join(directory, `.installation.json.${process.pid}.${randomUUID()}.tmp`)
    writeFileSync(temp, encodeInstallationAnchor(anchor), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
  } catch (cause) {
    if (temp !== undefined) {
      try {
        rmSync(temp, { force: true })
      } catch {
        // The target record is untouched; cleanup is best effort.
      }
    }
    return { ok: false, error: messageOf(cause) }
  }
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows has no POSIX mode bits; the owner-only intent is best effort there.
  }
  cleanupRetiredInstallationAnchorSync(home)
  return { ok: true }
}

/** The default anchor store: the machine-local record below the DSH home. */
export const defaultInstallationAnchorStore: InstallationAnchorStore = {
  read: (env) => readInstallationAnchorSnapshot(env).record,
  write: (env, anchor) => writeInstallationAnchorSync(env, anchor),
}
