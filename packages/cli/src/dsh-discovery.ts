/**
 * Discovery of the user's DSH installation. One installation is selected per
 * invocation by explicit precedence: `--dsh`, `EEDSH_DSH_ANCHOR`, the `dsh`
 * launcher on `PATH`, then a project-local package. Discovery is synchronous
 * so commands can select the installation before config evaluation.
 * @module @eedsh/cli/dsh-discovery
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import * as Result from 'effect/Result'
import type { DshInstallationInfo } from './dsh'
import { SUPPORTED_DSH_RANGE, supportsDshVersion } from './dsh-policy'
import { DshFailure } from './internal/effect/errors'

/** How the selected installation was discovered. */
export type DshSource = 'explicit' | 'anchor' | 'path' | 'project'

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
}

const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'
const DSH_LAUNCHER = join('lib', 'bin.js')
const DEFAULT_PATH_EXTENSIONS = ['.COM', '.EXE', '.BAT', '.CMD']

function failure(input: {
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

interface Manifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly bin?: unknown
}

function readManifest(anchor: string): Manifest | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(anchor, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Manifest
  } catch {
    return undefined
  }
}

function installationFromAnchor(
  anchor: string,
  source: DshSource,
  pathShown: string,
): Result.Result<DiscoveredDshInstallation, DshFailure> {
  let physical = anchor
  try {
    physical = realpathSync(anchor)
  } catch {
    physical = anchor
  }
  const manifest = readManifest(physical)
  if (manifest === undefined) {
    return Result.fail(
      failure({
        code: 'dsh.anchor_invalid',
        path: pathShown,
        message: `cannot read a DSH manifest at ${pathShown}: expected a package.json`,
      }),
    )
  }
  if (manifest.name !== DSH_PACKAGE_NAME) {
    return Result.fail(
      failure({
        code: 'dsh.anchor_invalid',
        path: pathShown,
        message: `${pathShown} is not a ${DSH_PACKAGE_NAME} package (found ${JSON.stringify(manifest.name)})`,
      }),
    )
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    return Result.fail(
      failure({
        code: 'dsh.anchor_invalid',
        path: pathShown,
        message: `${pathShown} declares no DSH version`,
      }),
    )
  }
  const packageDir = dirname(physical)
  const binPath = join(packageDir, DSH_LAUNCHER)
  return Result.succeed({
    version: manifest.version,
    installAnchor: physical,
    packageDir,
    binPath,
    launcher: binPath,
    source,
  })
}

function installationFromPath(
  input: string,
  source: DshSource,
  cwd: string,
): Result.Result<DiscoveredDshInstallation, DshFailure> {
  const absolute = isAbsolute(input) ? input : resolve(cwd, input)
  let anchor: string
  try {
    const stats = statSync(absolute)
    if (stats.isDirectory()) anchor = join(absolute, 'package.json')
    else if (basename(absolute) === 'package.json') anchor = absolute
    else {
      return Result.fail(
        failure({
          code: 'dsh.anchor_invalid',
          path: input,
          message: `${input} is not a DSH package directory or package.json`,
        }),
      )
    }
  } catch (cause) {
    return Result.fail(
      failure({
        code: 'dsh.anchor_invalid',
        path: input,
        message: `cannot read the DSH installation at ${input}`,
        cause,
      }),
    )
  }
  return installationFromAnchor(anchor, source, input)
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
      const manifest = readManifest(anchor)
      if (manifest?.name === DSH_PACKAGE_NAME) return anchor
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function installationFromPathLauncher(
  launcher: string,
): Result.Result<DiscoveredDshInstallation, DshFailure> | undefined {
  let real: string
  try {
    real = realpathSync(launcher)
  } catch {
    return undefined
  }
  const anchor = packageAnchorForLauncher(real)
  if (anchor === undefined) return undefined
  const resolved = installationFromAnchor(anchor, 'path', launcher)
  if (Result.isFailure(resolved)) return resolved
  return Result.succeed({ ...resolved.success, binPath: real, launcher: real })
}

function discoverFromPath(
  env: Record<string, string | undefined>,
): Result.Result<DiscoveredDshInstallation, DshFailure> | undefined {
  const directories = (env.PATH ?? '').split(delimiter).filter((entry) => entry.length > 0)
  for (const directory of directories) {
    for (const name of launcherNames('dsh', env)) {
      const candidate = join(directory, name)
      if (!existsSync(candidate)) continue
      const resolved = installationFromPathLauncher(candidate)
      if (resolved !== undefined && Result.isSuccess(resolved)) return resolved
    }
  }
  return undefined
}

function discoverFromProject(
  cwd: string,
): Result.Result<DiscoveredDshInstallation, DshFailure> | undefined {
  let current = resolve(cwd)
  while (true) {
    const anchor = join(current, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(anchor)) {
      const resolved = installationFromAnchor(anchor, 'project', anchor)
      return Result.isSuccess(resolved) ? resolved : undefined
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Discover one DSH installation with explicit precedence. An invalid explicit
 * selection or anchor fails instead of falling through, so a typo never
 * silently selects a different installation.
 * @param options - explicit path, environment, and working directory.
 * @returns the selected installation, or a tagged discovery failure.
 */
export function discoverDshInstallation(
  options: DiscoverDshOptions = {},
): Result.Result<DiscoveredDshInstallation, DshFailure> {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  if (options.explicit !== undefined && options.explicit.trim() !== '') {
    return installationFromPath(options.explicit, 'explicit', cwd)
  }
  const anchor = env.EEDSH_DSH_ANCHOR
  if (anchor !== undefined && anchor.trim() !== '') {
    return installationFromPath(anchor, 'anchor', cwd)
  }
  const fromPath = discoverFromPath(env)
  if (fromPath !== undefined) return fromPath
  const fromProject = discoverFromProject(cwd)
  if (fromProject !== undefined) return fromProject
  return Result.fail(
    failure({
      code: 'dsh.not_found',
      message: `cannot find a ${DSH_PACKAGE_NAME} installation; install dsh with "npm install -g ${DSH_PACKAGE_NAME}", pass --dsh <path>, or set EEDSH_DSH_ANCHOR`,
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
    failure({
      code: 'dsh.unsupported_version',
      version: installation.version,
      range: SUPPORTED_DSH_RANGE,
      path: installation.installAnchor,
      message: `DSH ${installation.version} is outside eedsh's supported range ${SUPPORTED_DSH_RANGE}`,
    }),
  )
}
