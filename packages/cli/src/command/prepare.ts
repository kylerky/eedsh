/**
 * Preparation shared by the subcommands: profile directories, DSH discovery and
 * bootstrap, config-path resolution, config loading, and the profile-labelled
 * failure reports a multi-profile command emits. Every capability comes from a
 * service, so preparation takes no runtime bag.
 * @module @eedsh/cli/command/prepare
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProfilePlan } from '@eedsh/plan'
import { Effect } from 'effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { versionProbe } from '../command-runner'
import { type ConfigLoadFailure, type LoadedConfig, validateConfigPath } from '../config'
import { defaultConfigPath } from '../config-path'
import type { DiscoveredDshInstallation } from '../dsh'
import { EXIT_USAGE } from '../exit'
import { anchorForInstallation } from '../installation-anchor'
import { resolveDshHome, resolveProfileDir } from '../internal/dsh-home'
import type { DshFailure } from '../internal/effect/errors'
import {
  BundleResolver,
  type BundleResolverShape,
  CommandRunner,
  type CommandRunnerShape,
  ConfigLoader,
  type ConfigLoaderShape,
  DshDiscovery,
  type DshDiscoveryShape,
  Environment,
  type EnvironmentShape,
  InstallationAnchor,
  type InstallationAnchorShape,
  Output,
  type OutputShape,
} from '../internal/effect/services'
import type { ProfileSelectionError } from '../selection'
import { describeError, EXPLAIN_HINT, rawPreflightWarnings } from './report'

export function profileDirForName(name: string, env: Record<string, string | undefined>): string {
  return resolveProfileDir(name, resolveDshHome(undefined, env))
}

export function profileDirFor(plan: ProfilePlan, env: Record<string, string | undefined>): string {
  return profileDirForName(plan.profile.name, env)
}

/** The capabilities discovery and bridge loading need. */
export type PrepareServices =
  | DshDiscoveryShape
  | EnvironmentShape
  | InstallationAnchorShape
  | CommandRunnerShape
  | BundleResolverShape
  | OutputShape

/**
 * Discover and validate one installation, then load its bridge. Runs before any
 * config import so the authoring layer can record its queries. Setup commands
 * may bootstrap an unresolved PATH launcher through pnpm/npm and record the
 * anchor; doctor, repl, and run --no-sync never do.
 */
export function requireDsh(
  explicit: Option.Option<string>,
  options: { readonly bootstrap?: boolean } = {},
): Effect.Effect<DiscoveredDshInstallation, DshFailure, PrepareServices> {
  return Effect.gen(function* () {
    const { env, cwd } = yield* Environment
    const discovery = yield* DshDiscovery
    const store = yield* InstallationAnchor
    const runner = yield* CommandRunner
    const output = yield* Output
    const discovered = discovery.discover({
      ...(Option.isSome(explicit) ? { explicit: explicit.value } : {}),
      env,
      cwd,
      readAnchor: () => store.read(env),
      probeVersion: versionProbe(runner, env),
    })

    let selected: DiscoveredDshInstallation
    if (Result.isSuccess(discovered)) {
      selected = discovered.success
    } else {
      const envAnchor = env.EEDSH_DSH_ANCHOR
      const explicitAnchor = envAnchor !== undefined && envAnchor.trim() !== ''
      const launcher = discovered.failure.path
      const canBootstrap =
        options.bootstrap === true &&
        !Option.isSome(explicit) &&
        !explicitAnchor &&
        discovered.failure.code === 'dsh.launcher_unresolved' &&
        launcher !== undefined
      if (!canBootstrap) return yield* Effect.fail(discovered.failure)
      const bootstrapped = discovery.bootstrap({
        env,
        cwd,
        launcher: launcher as string,
        runner,
      })
      if (Result.isFailure(bootstrapped)) return yield* Effect.fail(bootstrapped.failure)
      selected = {
        ...bootstrapped.success.installation,
        source: 'bootstrapped',
        launcher: bootstrapped.success.launcher,
      }
      const written = store.write(
        env,
        anchorForInstallation(selected, {
          recordedBy: 'sync',
          launcher: bootstrapped.success.launcher,
          manager: bootstrapped.success.manager,
        }),
      )
      if (!written.ok) {
        output.stderr(
          `eedsh: warning: cannot record the DSH installation anchor: ${written.error}; ` +
            `continuing with ${selected.installAnchor}`,
        )
      }
    }

    const validated = discovery.validate(selected)
    if (Result.isFailure(validated)) return yield* Effect.fail(validated.failure)
    const resolver = yield* BundleResolver
    yield* resolver.loadBridge(validated.success)
    return validated.success
  })
}

/** Resolve the config path, reporting an unusable explicit path or a missing default. */
export function resolveConfigPath(
  requested: Option.Option<string>,
): Effect.Effect<Option.Option<string>, never, EnvironmentShape | OutputShape> {
  return Effect.gen(function* () {
    const output = yield* Output
    if (Option.isSome(requested)) {
      const { cwd } = yield* Environment
      const configPath = resolve(cwd, requested.value)
      const valid = validateConfigPath(configPath)
      if (Result.isFailure(valid)) {
        for (const line of describeError(valid.failure)) output.stderr(`eedsh: ${line}`)
        return Option.none()
      }
      return Option.some(configPath)
    }

    const { env } = yield* Environment
    const configPath = defaultConfigPath(env)
    if (existsSync(configPath)) return Option.some(configPath)

    output.stderr(
      `eedsh: cannot find a config at ${configPath}; run "eedsh init" to create one, or pass --config <path>`,
    )
    return Option.none()
  })
}

export function loadConfigValue(
  configPath: string,
): Effect.Effect<LoadedConfig, ConfigLoadFailure, ConfigLoaderShape> {
  return Effect.flatMap(ConfigLoader, (loader) => loader.load(configPath))
}

/** Report a profile-selection failure and return the usage exit code. */
export function selectionFailure(
  error: ProfileSelectionError,
): Effect.Effect<number, never, OutputShape> {
  return Effect.map(Output, (output) => {
    for (const line of describeError(error)) output.stderr(`eedsh: ${line}`)
    return EXIT_USAGE
  })
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
