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
import { Effect, Option, Schema } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { type CommandResult, probeLauncherVersion } from './command-runner'
import {
  installationFromManifestAnchor,
  launcherUnresolvedFailure,
  type ValidatedInstallation,
} from './installation-anchor'
import type { DshFailure } from './internal/effect/errors'
import type { CommandRunnerShape } from './internal/effect/services'
import { readNonEmptyString, readRecord } from './internal/schema-readers'

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

function anchorPathFromManagerPath(path: string): string {
  return basename(path) === 'package.json' ? path : join(path, 'package.json')
}

/** Dependency groups a pnpm global listing may report. */
const PNPM_DEPENDENCY_GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

/** One DSH entry in pnpm's global metadata; other fields are ignored. */
const pnpmEntrySchema = Schema.Struct({ path: Schema.NonEmptyString })

/**
 * Read pnpm's global listing as candidates. A malformed document, root,
 * dependency group, or entry is skipped so its valid siblings survive; the
 * manifest remains the authority for the selected version.
 * @param stdout - the pnpm listing text.
 * @returns one candidate per usable DSH entry.
 */
function parsePnpmCandidates(stdout: string): { anchor: string; version?: string }[] {
  const parsed = Result.try({
    try: () => JSON.parse(stdout) as unknown,
    catch: () => undefined,
  })
  if (Result.isFailure(parsed)) return []
  const roots = Array.isArray(parsed.success) ? parsed.success : [parsed.success]
  const candidates: { anchor: string; version?: string }[] = []
  for (const root of roots) {
    const listing = readRecord(root)
    for (const group of PNPM_DEPENDENCY_GROUPS) {
      const dependency = readRecord(listing[group])['@deepseek-ai/dsh']
      const entry = Schema.decodeUnknownOption(pnpmEntrySchema)(dependency)
      if (Option.isNone(entry)) continue
      const version = readNonEmptyString(readRecord(dependency).version)
      candidates.push({
        anchor: anchorPathFromManagerPath(entry.value.path),
        ...(Option.isNone(version) ? {} : { version: version.value }),
      })
    }
  }
  return candidates
}

function runMetadata(
  runner: CommandRunnerShape,
  command: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Effect.Effect<CommandResult | undefined> {
  return runner(command, args, { timeoutMs, env }).pipe(
    Effect.map((result) => (result.status === 0 ? result : undefined)),
  )
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
  runner: CommandRunnerShape,
  env: Record<string, string | undefined>,
  timeoutMs: number,
  probedVersion: string,
): Effect.Effect<Candidate[], never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const raw: { manager: InstallationAnchorManager; anchor: string }[] = []

    const pnpm = yield* runMetadata(
      runner,
      'pnpm',
      ['list', '-g', '--depth=0', '--json'],
      env,
      timeoutMs,
    )
    if (pnpm !== undefined) {
      for (const candidate of parsePnpmCandidates(pnpm.stdout)) {
        raw.push({ manager: 'pnpm', anchor: candidate.anchor })
      }
    }

    const npm = yield* runMetadata(runner, 'npm', ['root', '-g'], env, timeoutMs)
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
      const validated = yield* installationFromManifestAnchor(candidate.anchor, candidate.anchor, {
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
  })
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
  input: BootstrapInput & { readonly runner: CommandRunnerShape },
): Effect.Effect<
  Result.Result<BootstrappedDsh, DshFailure>,
  PlatformError.PlatformError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const env = input.env ?? process.env
    const metadataTimeout = input.timeoutMs ?? METADATA_TIMEOUT_MS
    const probedVersion = yield* probeLauncherVersion(input.runner, input.launcher, undefined, env)
    if (probedVersion === undefined) {
      return Result.fail(
        launcherUnresolvedFailure(
          input.launcher,
          `cannot determine the launcher version with "dsh --version"`,
        ),
      )
    }

    const candidates = yield* collectCandidates(input.runner, env, metadataTimeout, probedVersion)
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
  })
}
