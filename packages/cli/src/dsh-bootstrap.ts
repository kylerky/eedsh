/**
 * The first-sync bootstrap for pnpm and npm global installations. This module
 * is the only production code that asks a package manager where DSH lives. It
 * reads fixed, read-only metadata commands, matches candidates to one bounded
 * `dsh --version` probe, validates each candidate through the shared anchor
 * reader, deduplicates by real package path, and writes nothing. The caller
 * records the resolved anchor.
 * @module @eedsh/cli/dsh-bootstrap
 */
import { basename, join } from 'node:path'
import type { InstallationAnchorManager } from '@eedsh/runtime/installation-anchor'
import * as Result from 'effect/Result'
import {
  type CommandResult,
  type CommandRunner,
  defaultCommandRunner,
  probeLauncherVersion,
} from './command-runner'
import {
  installationFromManifestAnchor,
  launcherUnresolvedFailure,
  type ValidatedInstallation,
} from './installation-anchor'
import type { DshFailure } from './internal/effect/errors'

/** How long one metadata command may run. */
const METADATA_TIMEOUT_MS = 5000

/** Inputs for {@link bootstrapDshInstallation}. */
export interface BootstrapInput {
  /** Environment the metadata commands and launcher probe run under. */
  readonly env?: Record<string, string | undefined> | undefined
  /** Working directory; kept for symmetry with discovery. */
  readonly cwd?: string | undefined
  /** The absolute PATH launcher whose package is unknown. */
  readonly launcher: string
  /** Replace the fixed-argument command runner. */
  readonly runner?: CommandRunner | undefined
  /** Override the metadata command bound. */
  readonly timeoutMs?: number | undefined
}

/** A bootstrapped installation and the manager metadata that supplied it. */
export interface BootstrappedDsh {
  /** The validated installation. */
  readonly installation: ValidatedInstallation
  /** The manager that supplied the selected candidate. */
  readonly manager: InstallationAnchorManager
  /** The PATH launcher the anchor should record. */
  readonly launcher: string
}

interface Candidate {
  readonly manager: InstallationAnchorManager
  readonly installation: ValidatedInstallation
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function anchorPathFromManagerPath(path: string): string {
  return basename(path) === 'package.json' ? path : join(path, 'package.json')
}

function parsePnpmCandidates(stdout: string): { anchor: string; version?: string }[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  const roots = Array.isArray(parsed) ? parsed : [parsed]
  const candidates: { anchor: string; version?: string }[] = []
  for (const root of roots) {
    if (!isObject(root)) continue
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const dependencies = root[group]
      if (!isObject(dependencies)) continue
      const dependency = dependencies['@deepseek-ai/dsh']
      if (!isObject(dependency)) continue
      const path = dependency.path
      if (typeof path !== 'string' || path.length === 0) continue
      const version = dependency.version
      candidates.push({
        anchor: anchorPathFromManagerPath(path),
        ...(typeof version === 'string' && version.length > 0 ? { version } : {}),
      })
    }
  }
  return candidates
}

function runMetadata(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): CommandResult | undefined {
  const result = runner(command, args, { timeoutMs, env })
  return result.status === 0 ? result : undefined
}

/**
 * Infer the manager from the PATH launcher path. The result only breaks a tie
 * between already-matching candidates; it never selects a package on its own.
 * @param launcher - the PATH launcher path.
 * @returns the indicated manager, or undefined when the path does not say.
 */
export function inferManagerFromLauncher(launcher: string): InstallationAnchorManager | undefined {
  const normalized = launcher.replaceAll('\\', '/').toLowerCase()
  if (normalized.includes('pnpm')) return 'pnpm'
  if (normalized.includes('npm')) return 'npm'
  return undefined
}

function collectCandidates(
  runner: CommandRunner,
  env: Record<string, string | undefined>,
  timeoutMs: number,
  probedVersion: string,
): Candidate[] {
  const raw: { manager: InstallationAnchorManager; anchor: string }[] = []

  const pnpm = runMetadata(runner, 'pnpm', ['list', '-g', '--depth=0', '--json'], env, timeoutMs)
  if (pnpm !== undefined) {
    for (const candidate of parsePnpmCandidates(pnpm.stdout)) {
      raw.push({ manager: 'pnpm', anchor: candidate.anchor })
    }
  }

  const npm = runMetadata(runner, 'npm', ['root', '-g'], env, timeoutMs)
  if (npm !== undefined) {
    const root = npm.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1)
    if (root !== undefined) {
      raw.push({
        manager: 'npm',
        anchor: join(root, '@deepseek-ai', 'dsh', 'package.json'),
      })
    }
  }

  const seen = new Set<string>()
  const candidates: Candidate[] = []
  for (const candidate of raw) {
    const validated = installationFromManifestAnchor(candidate.anchor, candidate.anchor, {
      requireSupported: true,
    })
    if (Result.isFailure(validated)) continue
    const installation = validated.success
    if (installation.version !== probedVersion) continue
    if (seen.has(installation.installAnchor)) continue
    seen.add(installation.installAnchor)
    candidates.push({ manager: candidate.manager, installation })
  }
  return candidates
}

function describeCandidates(candidates: readonly Candidate[]): string {
  return candidates
    .map((candidate) => `${candidate.manager} ${candidate.installation.installAnchor}`)
    .sort()
    .join(', ')
}

/**
 * Bootstrap an installation through pnpm or npm global metadata. The launcher's
 * `dsh --version` must match exactly. When several distinct installations
 * match, the launcher path breaks the tie; otherwise the bootstrap fails with
 * the candidates and `--dsh` instead of guessing.
 * @param input - launcher, environment, and runner seam.
 * @returns the validated installation and manager, or a tagged failure.
 */
export function bootstrapDshInstallation(
  input: BootstrapInput,
): Result.Result<BootstrappedDsh, DshFailure> {
  const env = input.env ?? process.env
  const runner = input.runner ?? defaultCommandRunner
  const metadataTimeout = input.timeoutMs ?? METADATA_TIMEOUT_MS
  const probedVersion = probeLauncherVersion(runner, input.launcher, undefined, env)
  if (probedVersion === undefined) {
    return Result.fail(
      launcherUnresolvedFailure(
        input.launcher,
        `cannot determine the launcher version with "dsh --version"`,
      ),
    )
  }

  const candidates = collectCandidates(runner, env, metadataTimeout, probedVersion)
  if (candidates.length === 1) {
    const only = candidates[0] as Candidate
    return Result.succeed({
      installation: only.installation,
      manager: only.manager,
      launcher: input.launcher,
    })
  }
  if (candidates.length === 0) {
    return Result.fail(
      launcherUnresolvedFailure(
        input.launcher,
        `"dsh --version" reported ${probedVersion} but no pnpm or npm global ` +
          '@deepseek-ai/dsh package matches it',
      ),
    )
  }

  const inferred = inferManagerFromLauncher(input.launcher)
  if (inferred !== undefined) {
    const matching = candidates.filter((candidate) => candidate.manager === inferred)
    if (matching.length === 1) {
      const only = matching[0] as Candidate
      return Result.succeed({
        installation: only.installation,
        manager: only.manager,
        launcher: input.launcher,
      })
    }
  }
  return Result.fail(
    launcherUnresolvedFailure(
      input.launcher,
      `found multiple matching installations (${describeCandidates(candidates)}); pass --dsh to choose one`,
    ),
  )
}
