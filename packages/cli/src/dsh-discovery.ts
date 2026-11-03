/**
 * Discovery of the user's DSH installation. One installation is selected per
 * invocation by explicit precedence: `--dsh`, `EEDSH_DSH_ANCHOR`, the `dsh`
 * launcher on `PATH`, the recorded installation anchor, then a project-local
 * package. A PATH launcher that cannot be resolved fails instead of silently
 * selecting a different installation. Discovery is synchronous so commands can
 * select the installation before config evaluation. It never queries pnpm or npm
 * and never parses launcher shims; the recorded anchor is validated on every
 * read and guarded by one bounded `dsh --version` probe.
 * @module @eedsh/cli/dsh-discovery
 */
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { InstallationAnchor } from '@eedsh/runtime/installation-anchor'
import * as Result from 'effect/Result'
import { defaultCommandRunner, probeLauncherVersion } from './command-runner'
import type { DshInstallationInfo } from './dsh'
import { SUPPORTED_DSH_RANGE, supportsDshVersion } from './dsh-policy'
import {
  DSH_PACKAGE_NAME,
  dshFailure,
  installationFromManifestAnchor,
  installationFromSelection,
  launcherUnresolvedFailure,
  readInstallationAnchorSnapshot,
  readPackageManifest,
  type ValidatedInstallation,
  validateRecordedInstallation,
} from './installation-anchor'
import type { DshFailure } from './internal/effect/errors'

/** How the selected installation was discovered. */
export type DshSource = 'explicit' | 'anchor' | 'path' | 'recorded' | 'bootstrapped' | 'project'

/** A selected DSH installation and where discovery found it. */
export interface DiscoveredDshInstallation extends DshInstallationInfo {
  /** Absolute package directory. */
  readonly packageDir: string
  /** Where the installation came from. */
  readonly source: DshSource
  /** Absolute launcher path; the PATH launcher's real path for a PATH source. */
  readonly launcher: string
}

/** Inputs for {@link discoverDshInstallation}. */
export interface DiscoverDshOptions {
  /** The `--dsh` value: a package directory or its package.json. */
  readonly explicit?: string | undefined
  /** Environment mapping; defaults to the process environment. */
  readonly env?: Record<string, string | undefined> | undefined
  /** Directory for project-local resolution; defaults to the working directory. */
  readonly cwd?: string | undefined
  /** Replace the recorded-anchor read; defaults to the DSH home record. */
  readonly readAnchor?: (() => InstallationAnchor | undefined) | undefined
  /** Replace the bounded `dsh --version` guard; defaults to the real probe. */
  readonly probeVersion?: ((launcher: string) => string | undefined) | undefined
}

const DEFAULT_PATH_EXTENSIONS = ['.COM', '.EXE', '.BAT', '.CMD']

function selectedInstallation(
  installation: ValidatedInstallation,
  source: DshSource,
): DiscoveredDshInstallation {
  return {
    ...installation,
    source,
    launcher: installation.binPath,
  }
}

/** Candidate launcher names for one base name, honoring PATHEXT. */
function launcherNames(base: string, env: Record<string, string | undefined>): string[] {
  const declared = env.PATHEXT
  const extensions =
    declared === undefined || declared.trim() === ''
      ? process.platform === 'win32'
        ? DEFAULT_PATH_EXTENSIONS
        : []
      : declared.split(';').filter((extension) => extension.length > 0)
  const names = [base]
  for (const extension of extensions) {
    const lower = extension.toLowerCase()
    const upper = extension.toUpperCase()
    for (const candidate of [`${base}${lower}`, `${base}${upper}`]) {
      if (!names.includes(candidate)) names.push(candidate)
    }
  }
  return names
}

/** Walk from a launcher file to its owning `@deepseek-ai/dsh` package. */
function packageAnchorForLauncher(launcher: string): string | undefined {
  let current = dirname(launcher)
  while (true) {
    const anchor = join(current, 'package.json')
    if (existsSync(anchor)) {
      const manifest = readPackageManifest(anchor)
      if (manifest?.name === DSH_PACKAGE_NAME) return anchor
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function installationFromPathLauncher(launcher: string): DiscoveredDshInstallation | undefined {
  let real: string
  try {
    real = realpathSync(launcher)
  } catch {
    return undefined
  }
  const anchor = packageAnchorForLauncher(real)
  if (anchor === undefined) return undefined
  const resolved = installationFromManifestAnchor(anchor, launcher)
  if (Result.isFailure(resolved)) return undefined
  return {
    ...resolved.success,
    source: 'path',
    binPath: real,
    launcher: real,
  }
}

interface PathScan {
  readonly launcher: string
  readonly installation?: DiscoveredDshInstallation | undefined
}

function discoverFromPath(env: Record<string, string | undefined>): PathScan | undefined {
  const directories = (env.PATH ?? '').split(delimiter).filter((entry) => entry.length > 0)
  let firstLauncher: string | undefined
  for (const directory of directories) {
    for (const name of launcherNames('dsh', env)) {
      const candidate = join(directory, name)
      if (!existsSync(candidate)) continue
      firstLauncher ??= candidate
      const resolved = installationFromPathLauncher(candidate)
      if (resolved !== undefined) return { launcher: candidate, installation: resolved }
    }
  }
  if (firstLauncher === undefined) return undefined
  return { launcher: firstLauncher }
}

function realpathOr(value: string): string {
  try {
    return realpathSync(value)
  } catch {
    return value
  }
}

function samePath(left: string, right: string): boolean {
  const a = realpathOr(left)
  const b = realpathOr(right)
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

interface RecordedResolution {
  readonly installation?: DiscoveredDshInstallation | undefined
  readonly reason?: string | undefined
}

/**
 * Validate a recorded anchor and, when a PATH launcher exists, require the
 * record to describe that launcher and its `dsh --version`.
 */
function resolveRecordedAnchor(input: {
  record: InstallationAnchor
  pathLauncher: string | undefined
  probeVersion: (launcher: string) => string | undefined
}): RecordedResolution {
  const validated = validateRecordedInstallation(input.record)
  if (Result.isFailure(validated)) return { reason: validated.failure.message }
  const installation = validated.success
  const pathLauncher = input.pathLauncher
  if (pathLauncher !== undefined) {
    if (input.record.launcher !== undefined && !samePath(input.record.launcher, pathLauncher)) {
      return {
        reason:
          `the recorded anchor names launcher ${input.record.launcher} but PATH resolves ` +
          `${pathLauncher}; the record no longer matches this installation`,
      }
    }
    const probed = input.probeVersion(pathLauncher)
    if (probed === undefined) {
      return { reason: `cannot determine the version of ${pathLauncher} with "dsh --version"` }
    }
    if (probed !== installation.version) {
      return {
        reason:
          `"dsh --version" reported ${probed} but the recorded installation is ` +
          `${installation.version} at ${installation.installAnchor}`,
      }
    }
  }
  const launcher = pathLauncher ?? input.record.launcher ?? installation.binPath
  return {
    installation: {
      ...installation,
      source: 'recorded',
      launcher: realpathOr(launcher),
    },
  }
}

function discoverFromProject(cwd: string): DiscoveredDshInstallation | undefined {
  let current = cwd
  while (true) {
    const anchor = join(current, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(anchor)) {
      const resolved = installationFromManifestAnchor(anchor, anchor)
      if (Result.isSuccess(resolved)) {
        return selectedInstallation(resolved.success, 'project')
      }
      return undefined
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Discover one DSH installation with explicit precedence. An invalid explicit
 * selection or `EEDSH_DSH_ANCHOR` fails instead of falling through, so a typo
 * never silently selects a different installation. A PATH launcher that neither
 * direct resolution nor a valid recorded anchor resolves produces
 * `dsh.launcher_unresolved` and does not fall through to a project-local copy.
 * @param options - explicit path, environment, working directory, and seams.
 * @returns the selected installation, or a tagged discovery failure.
 */
export function discoverDshInstallation(
  options: DiscoverDshOptions = {},
): Result.Result<DiscoveredDshInstallation, DshFailure> {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  if (options.explicit !== undefined && options.explicit.trim() !== '') {
    const selection = installationFromSelection(options.explicit, cwd)
    return Result.isFailure(selection)
      ? Result.fail(selection.failure)
      : Result.succeed(selectedInstallation(selection.success, 'explicit'))
  }
  const anchor = env.EEDSH_DSH_ANCHOR
  if (anchor !== undefined && anchor.trim() !== '') {
    const selection = installationFromSelection(anchor, cwd)
    return Result.isFailure(selection)
      ? Result.fail(selection.failure)
      : Result.succeed(selectedInstallation(selection.success, 'anchor'))
  }

  const pathScan = discoverFromPath(env)
  if (pathScan?.installation !== undefined) return Result.succeed(pathScan.installation)

  const readAnchor = options.readAnchor ?? (() => readInstallationAnchorSnapshot(env).record)
  let record: InstallationAnchor | undefined
  try {
    record = readAnchor()
  } catch {
    record = undefined
  }
  const probeVersion =
    options.probeVersion ??
    ((launcher: string) => probeLauncherVersion(defaultCommandRunner, launcher))
  const recorded =
    record === undefined
      ? {}
      : resolveRecordedAnchor({
          record,
          pathLauncher: pathScan?.launcher,
          probeVersion,
        })
  if (recorded.installation !== undefined) return Result.succeed(recorded.installation)

  if (pathScan !== undefined) {
    return Result.fail(launcherUnresolvedFailure(pathScan.launcher, recorded.reason))
  }

  const fromProject = discoverFromProject(cwd)
  if (fromProject !== undefined) return Result.succeed(fromProject)

  return Result.fail(
    dshFailure({
      code: 'dsh.not_found',
      message:
        `cannot find a ${DSH_PACKAGE_NAME} installation; install dsh with "npm install -g ${DSH_PACKAGE_NAME}", ` +
        'pass --dsh <path>, set EEDSH_DSH_ANCHOR, or run "eedsh sync" so a pnpm/npm global installation is ' +
        'bootstrapped (booting an eedsh-managed profile once also records the installation anchor)',
    }),
  )
}

/**
 * Reject a discovered installation outside eedsh's supported range.
 * @param installation - the discovered installation.
 * @returns the installation, or an unsupported-version failure.
 */
export function validateDshVersion(
  installation: DiscoveredDshInstallation,
): Result.Result<DiscoveredDshInstallation, DshFailure> {
  if (supportsDshVersion(installation.version)) return Result.succeed(installation)
  return Result.fail(
    dshFailure({
      code: 'dsh.unsupported_version',
      version: installation.version,
      range: SUPPORTED_DSH_RANGE,
      path: installation.installAnchor,
      message: `DSH ${installation.version} is outside eedsh's supported range ${SUPPORTED_DSH_RANGE}`,
    }),
  )
}
