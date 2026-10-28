/**
 * Multi-profile config authoring. A config pins one exact DSH version, may
 * name a default profile, and maps profile keys to profile descriptors. The
 * envelope is validated once by the plan contract; each profile plan is
 * validated independently so one broken sibling does not block the rest.
 * @module @eedsh/config/config
 */
import {
  configValue,
  decodeConfigEnvelope,
  type EedshConfig,
  type ProfilePlan,
  validateProfileDefinition,
} from '@eedsh/plan'
import * as Result from 'effect/Result'
import type * as Schema from 'effect/Schema'
import type { ProfileDefinition } from './api'

/** Input accepted by {@link defineConfig}. */
export interface DefineConfigInput<P extends Record<string, ProfileDefinition>> {
  /** Exact DSH runtime pin applied to every profile plan. */
  readonly dsh: string
  /** A declared profile key, selected when a command needs one and none is named. */
  readonly defaultProfile?: keyof P & string
  /** Named profiles; each key is the profile name. */
  readonly profiles: P
}

/**
 * Author a multi-profile config. The envelope is validated first: an invalid
 * DSH pin, an empty or unsafe profile record, or an unknown default profile
 * fails the whole Result with Effect's native schema error. Each profile is
 * then validated independently and stored as its own success or failure.
 * @param input - the shared pin, optional default, and named profiles.
 * @returns the validated config, or the envelope's native schema error.
 */
export function defineConfig<P extends Record<string, ProfileDefinition>>(
  input: DefineConfigInput<P>,
): Result.Result<EedshConfig, Schema.SchemaError> {
  const decoded = decodeConfigEnvelope(input)
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
  const envelope = decoded.success
  const profiles: Record<string, Result.Result<ProfilePlan, Schema.SchemaError>> = {}
  for (const [name, definition] of Object.entries(envelope.profiles)) {
    profiles[name] = validateProfileDefinition(name, envelope.dsh, definition)
  }
  return Result.succeed(configValue(envelope, profiles))
}
