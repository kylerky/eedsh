/**
 * Profile selection over a loaded multi-profile config. Sync with no
 * `--profile` selects every profile; commands that need one profile select
 * the explicit name, then the declared default, then the sole profile.
 * @module @eedsh/cli/selection
 */
import type { EedshConfig, ProfilePlan } from '@eedsh/plan'
import { Data, Option } from 'effect'
import * as Result from 'effect/Result'
import type * as Schema from 'effect/Schema'

/** One selected profile: its name and its per-profile validation Result. */
export interface SelectedProfile {
  readonly name: string
  readonly plan: Result.Result<ProfilePlan, Schema.SchemaError>
}

/** A requested profile name that the config does not declare. */
export class UnknownProfile extends Data.TaggedError('UnknownProfile')<{
  readonly requested: string
  readonly names: readonly string[]
}> {}

/** Several profiles and no default, so a one-profile command cannot choose. */
export class AmbiguousProfile extends Data.TaggedError('AmbiguousProfile')<{
  readonly names: readonly string[]
}> {}

/** Why a one-profile selection could not be made. */
export type ProfileSelectionError = UnknownProfile | AmbiguousProfile

/** The declared profile names, in authored record order. */
export function profileNames(config: EedshConfig): string[] {
  return Object.keys(config.profiles)
}

function entryOf(config: EedshConfig, name: string): SelectedProfile | undefined {
  const plan = config.profiles[name]
  return plan === undefined ? undefined : { name, plan }
}

/**
 * Select exactly one profile: the explicit name, else the declared default,
 * else the sole profile. An explicit name never falls back to the default.
 * @param config - the loaded config.
 * @param requested - the `--profile` value, when one was supplied.
 * @returns the selection, or a tagged usage failure.
 */
export function selectProfile(
  config: EedshConfig,
  requested: Option.Option<string>,
): Result.Result<SelectedProfile, ProfileSelectionError> {
  if (Option.isSome(requested)) {
    const entry = entryOf(config, requested.value)
    return entry === undefined
      ? Result.fail(new UnknownProfile({ requested: requested.value, names: profileNames(config) }))
      : Result.succeed(entry)
  }
  if (config.defaultProfile !== undefined) {
    const entry = entryOf(config, config.defaultProfile)
    if (entry !== undefined) return Result.succeed(entry)
  }
  const names = profileNames(config)
  const sole = names.length === 1 ? names[0] : undefined
  if (sole !== undefined) {
    const entry = entryOf(config, sole)
    if (entry !== undefined) return Result.succeed(entry)
  }
  return Result.fail(new AmbiguousProfile({ names }))
}

/**
 * Select every declared profile for a bare multi-profile sync.
 * @param config - the loaded config.
 * @returns one entry per key, in record order.
 */
export function selectAllProfiles(config: EedshConfig): SelectedProfile[] {
  return profileNames(config).flatMap((name) => {
    const entry = entryOf(config, name)
    return entry === undefined ? [] : [entry]
  })
}

/**
 * Select the profiles a sync run should publish: every profile when no
 * `--profile` is supplied, or exactly the named profile.
 * @param config - the loaded config.
 * @param requested - the `--profile` value, when one was supplied.
 * @returns the selected entries, or a tagged usage failure.
 */
export function selectSyncProfiles(
  config: EedshConfig,
  requested: Option.Option<string>,
): Result.Result<readonly SelectedProfile[], ProfileSelectionError> {
  if (Option.isNone(requested)) return Result.succeed(selectAllProfiles(config))
  const selection = selectProfile(config, requested)
  return Result.isFailure(selection)
    ? Result.fail(selection.failure)
    : Result.succeed([selection.success])
}

/**
 * Render a selection failure as one diagnostic line.
 * @param error - the tagged selection failure.
 * @returns the message naming the available profiles.
 */
export function describeProfileSelection(error: ProfileSelectionError): string {
  switch (error._tag) {
    case 'UnknownProfile':
      return `profile "${error.requested}" is not declared; available profiles: ${error.names.join(', ')}`
    case 'AmbiguousProfile':
      return `several profiles are declared (${error.names.join(', ')}); pass --profile <name>`
  }
}
