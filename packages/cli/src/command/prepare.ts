/**
 * Preparation shared by the subcommands: profile directories, DSH discovery and
 * bootstrap, config-path resolution, config loading, and the profile-labelled
 * failure reports a multi-profile command emits.
 * @module @eedsh/cli/command/prepare
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProfilePlan } from '@eedsh/plan'
import { Effect } from 'effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { defaultCommandRunner, versionProbe } from '../command-runner'
import {
  type ConfigLoadFailure,
  type LoadedConfig,
  loadConfig,
  validateConfigPath,
} from '../config'
import { defaultConfigPath } from '../config-path'
import { type DiscoveredDshInstallation, discoverDshInstallation, validateDshVersion } from '../dsh'
import { bootstrapDshInstallation } from '../dsh-bootstrap'
import { loadDshBridge } from '../dsh-bridge'
import { EXIT_USAGE } from '../exit'
import { anchorForInstallation, defaultInstallationAnchorStore } from '../installation-anchor'
import { resolveDshHome, resolveProfileDir } from '../internal/dsh-home'
import type { DshFailure } from '../internal/effect/errors'
import type { ProfileSelectionError } from '../selection'
import type { CommandRuntime } from './context'
import { describeError, EXPLAIN_HINT, rawPreflightWarnings, report } from './report'

export function profileDirForName(name: string, env: Record<string, string | undefined>): string {
  return resolveProfileDir(name, resolveDshHome(undefined, env))
}

export function profileDirFor(plan: ProfilePlan, env: Record<string, string | undefined>): string {
  return profileDirForName(plan.profile.name, env)
}

/**
 * Discover and validate one installation, then install its bridge. Runs before
 * any config import so a top-level query or dshVersion() resolves. Setup
 * commands may bootstrap an unresolved PATH launcher through pnpm/npm and
 * record the anchor; doctor, repl, and run --no-sync never do.
 */
export function requireDsh(
  runtime: CommandRuntime,
  explicit: Option.Option<string>,
  options: { readonly bootstrap?: boolean } = {},
): Effect.Effect<DiscoveredDshInstallation, DshFailure> {
  return Effect.gen(function* () {
    const store = runtime.options.installationAnchor ?? defaultInstallationAnchorStore
    const runner = runtime.options.commandRunner ?? defaultCommandRunner
    const discovery = runtime.options.discoverDsh ?? discoverDshInstallation
    const discovered = yield* Effect.sync(() =>
      discovery({
        ...(Option.isSome(explicit) ? { explicit: explicit.value } : {}),
        env: runtime.env,
        cwd: runtime.cwd,
        readAnchor: () => store.read(runtime.env),
        probeVersion: versionProbe(runner, runtime.env),
      }),
    )

    let selected: DiscoveredDshInstallation
    if (Result.isSuccess(discovered)) {
      selected = discovered.success
    } else {
      const envAnchor = runtime.env.EEDSH_DSH_ANCHOR
      const explicitAnchor = envAnchor !== undefined && envAnchor.trim() !== ''
      const launcher = discovered.failure.path
      const canBootstrap =
        options.bootstrap === true &&
        !Option.isSome(explicit) &&
        !explicitAnchor &&
        discovered.failure.code === 'dsh.launcher_unresolved' &&
        launcher !== undefined
      if (!canBootstrap) return yield* Effect.fail(discovered.failure)
      const bootstrap = runtime.options.bootstrapDsh ?? bootstrapDshInstallation
      const bootstrapped = yield* Effect.sync(() =>
        bootstrap({ env: runtime.env, cwd: runtime.cwd, launcher: launcher as string, runner }),
      )
      if (Result.isFailure(bootstrapped)) return yield* Effect.fail(bootstrapped.failure)
      selected = {
        ...bootstrapped.success.installation,
        source: 'bootstrapped',
        launcher: bootstrapped.success.launcher,
      }
      const written = yield* Effect.sync(() =>
        store.write(
          runtime.env,
          anchorForInstallation(selected, {
            recordedBy: 'sync',
            launcher: bootstrapped.success.launcher,
            manager: bootstrapped.success.manager,
          }),
        ),
      )
      if (!written.ok) {
        runtime.stderr(
          `eedsh: warning: cannot record the DSH installation anchor: ${written.error}; ` +
            `continuing with ${selected.installAnchor}`,
        )
      }
    }

    const validated = validateDshVersion(selected)
    if (Result.isFailure(validated)) return yield* Effect.fail(validated.failure)
    const load = runtime.options.loadDshBridge ?? loadDshBridge
    const loaded = yield* Effect.promise(() => load(validated.success))
    if (Result.isFailure(loaded)) return yield* Effect.fail(loaded.failure)
    runtime.installation = validated.success
    return validated.success
  })
}

export function resolveConfigPath(
  requested: Option.Option<string>,
  runtime: CommandRuntime,
): Option.Option<string> {
  if (Option.isSome(requested)) {
    const configPath = resolve(runtime.cwd, requested.value)
    const valid = validateConfigPath(configPath)
    if (Result.isFailure(valid)) {
      report(runtime.stderr, valid.failure)
      return Option.none()
    }
    return Option.some(configPath)
  }

  const configPath = defaultConfigPath(runtime.env)
  if (existsSync(configPath)) return Option.some(configPath)

  runtime.stderr(
    `eedsh: cannot find a config at ${configPath}; run "eedsh init" to create one, or pass --config <path>`,
  )
  return Option.none()
}

export function loadConfigValue(
  configPath: string,
  runtime: CommandRuntime,
): Effect.Effect<LoadedConfig, ConfigLoadFailure> {
  return (runtime.options.loadConfig ?? loadConfig)(configPath)
}

export function selectionFailure(runtime: CommandRuntime, error: ProfileSelectionError): number {
  for (const line of describeError(error)) runtime.stderr(`eedsh: ${line}`)
  return EXIT_USAGE
}

/** Report one profile-labelled failure without stopping the run. */
export function reportProfileFailure(
  stderr: (line: string) => void,
  name: string,
  error: unknown,
): void {
  stderr(`eedsh: profile "${name}":`)
  for (const line of describeError(error)) stderr(`eedsh: ${line}`)
}

/** Report a profile-labelled sync failure, keeping the explain hint. */
export function reportProfileSyncFailure(
  stderr: (line: string) => void,
  name: string,
  error: unknown,
  explain: boolean,
): void {
  reportProfileFailure(stderr, name, error)
  if (!explain && rawPreflightWarnings(error).length > 0) stderr(EXPLAIN_HINT)
}
