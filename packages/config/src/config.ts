/**
 * Multi-profile config authoring. A config pins one exact DSH version, may
 * name a default profile, and maps profile keys to profile descriptors. The
 * envelope is validated once; each profile plan is validated independently so
 * one broken sibling does not block the rest.
 * @module @eedsh/config/config
 */
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import type { ProfileDefinition } from './api'
import { PLAN_FORMAT, PLAN_VERSION } from './plan/constants'
import { isPlainObject } from './plan/plain-object'
import {
  DshPinSchema,
  type ProfilePlan,
  ProfileNameSchema,
  isSafeProfileName,
} from './plan/schema'
import { validatePlan } from './plan/validate'

/** A config-level validation failure that is not Effect's native schema error. */
export interface InvalidConfigValue {
  readonly _tag: 'InvalidConfigValue'
  /** Stable failure code for command diagnostics. */
  readonly code: 'config.invalid_export'
  readonly message: string
}

/** One validated config: a shared pin and one Result per named profile. */
export interface EedshConfig {
  /** Exact DSH runtime pin applied to every profile plan. */
  readonly dsh: string
  /** Profile selected when a command needs one and none is named. */
  readonly defaultProfile?: string
  /** Profile key to its validated plan, or that profile's native schema error. */
  readonly profiles: Readonly<Record<string, Result.Result<ProfilePlan, Schema.SchemaError>>>
}

/** Input accepted by {@link defineConfig}. */
export interface DefineConfigInput<P extends Record<string, ProfileDefinition>> {
  /** Exact DSH runtime pin applied to every profile plan. */
  readonly dsh: string
  /** A declared profile key, selected when a command needs one and none is named. */
  readonly defaultProfile?: keyof P & string
  /** Named profiles; each key is the profile name. */
  readonly profiles: P
}

/** A validated config envelope, before per-profile plans are built. */
interface ConfigEnvelope {
  readonly dsh: string
  readonly defaultProfile?: string | undefined
  readonly profiles: Readonly<Record<string, unknown>>
}

/**
 * Refine a schema with a filter while keeping the precise derived type.
 * Explicitly passing the base schema keeps the inferred filter schema typed.
 */
function refine<S extends Schema.Top>(
  self: S,
  predicate: (value: S['Type']) => Schema.FilterOutput,
): S['Rebuild'] {
  return Schema.check<S>(Schema.makeFilter<S['Type']>(predicate))(self)
}

/** Require a plain object before decoding a schema boundary. */
function plain<S extends Schema.Constraint>(schema: S, message: string) {
  const input = refine(Schema.Unknown, (value: unknown) => isPlainObject(value) || message)
  return Schema.decodeTo(schema)(input)
}

/** Profile keys are the sole identity and must be safe directory names. */
function profileRecordIssues(
  profiles: Readonly<Record<string, unknown>>,
): Schema.FilterIssue[] {
  const issues: Schema.FilterIssue[] = []
  if (Object.keys(profiles).length === 0) {
    issues.push({ path: [], issue: 'config must declare at least one profile' })
  }
  for (const key of Object.keys(profiles)) {
    if (!isSafeProfileName(key)) {
      issues.push({
        path: [key],
        issue: `profile key "${key}" is not usable as a profile directory`,
      })
    }
  }
  return issues
}

/** A non-empty record of safe profile keys. */
const ProfileRecordSchema = refine(
  Schema.Record(Schema.String, Schema.Unknown),
  profileRecordIssues,
)

const ConfigEnvelopeBaseSchema = plain(
  Schema.Struct({
    dsh: DshPinSchema,
    defaultProfile: Schema.optional(ProfileNameSchema),
    profiles: ProfileRecordSchema,
  }),
  'config must be a JSON object with dsh and profiles',
)

/** A default profile name must be one of the declared keys. */
function defaultProfileIssues(config: {
  readonly defaultProfile?: string | undefined
  readonly profiles: Readonly<Record<string, unknown>>
}): Schema.FilterIssue[] {
  const name = config.defaultProfile
  if (name === undefined || Object.hasOwn(config.profiles, name)) return []
  return [
    {
      path: ['defaultProfile'],
      issue: `default profile "${name}" is not declared in profiles`,
    },
  ]
}

/** The public config envelope schema: exact pin, safe keys, declared default. */
export const EedshConfigSchema = refine(ConfigEnvelopeBaseSchema, defaultProfileIssues)

const decodeEnvelope = Schema.decodeUnknownResult(EedshConfigSchema, {
  errors: 'all',
  onExcessProperty: 'error',
})

/** The authored profile shape before the envelope supplies its identity. */
const ProfileDefinitionSchema = Schema.Struct({
  bundles: Schema.optional(Schema.Array(Schema.Unknown)),
  layers: Schema.optional(Schema.Array(Schema.Unknown)),
  packages: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const decodeProfileDefinition = Schema.decodeUnknownResult(ProfileDefinitionSchema, {
  errors: 'all',
})

/**
 * Build and validate one profile plan from its descriptor. The key supplies
 * the profile name and the config supplies the shared DSH pin, so a plan
 * forged inside a profile Result cannot choose either.
 */
function validateProfileDefinition(
  name: string,
  dsh: string,
  definition: unknown,
): Result.Result<ProfilePlan, Schema.SchemaError> {
  const decoded = decodeProfileDefinition(definition)
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
  return validatePlan({
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    profile: { name },
    dsh,
    bundles: decoded.success.bundles ?? [],
    layers: decoded.success.layers ?? [],
    packages: decoded.success.packages ?? {},
  })
}

function configValue(
  envelope: ConfigEnvelope,
  profiles: Readonly<Record<string, Result.Result<ProfilePlan, Schema.SchemaError>>>,
): EedshConfig {
  const base = { dsh: envelope.dsh, profiles }
  return envelope.defaultProfile === undefined
    ? base
    : { ...base, defaultProfile: envelope.defaultProfile }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/** A forged or foreign Result failure: a config-level invalid export. */
function invalidExport(failure: unknown): InvalidConfigValue {
  return {
    _tag: 'InvalidConfigValue',
    code: 'config.invalid_export',
    message: `config exported an invalid failure: ${errorMessage(failure)}`,
  }
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
  const decoded = decodeEnvelope(input)
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
  const envelope = decoded.success
  const profiles: Record<string, Result.Result<ProfilePlan, Schema.SchemaError>> = {}
  for (const [name, definition] of Object.entries(envelope.profiles)) {
    profiles[name] = validateProfileDefinition(name, envelope.dsh, definition)
  }
  return Result.succeed(configValue(envelope, profiles))
}

/**
 * Unwrap a config-level Result export. A native schema failure is preserved;
 * any other failure is a config-level invalid export.
 */
function unwrapConfigValue(
  value: unknown,
): Result.Result<unknown, Schema.SchemaError | InvalidConfigValue> {
  if (!Result.isResult(value)) return Result.succeed(value)
  if (Result.isFailure(value)) {
    return Schema.isSchemaError(value.failure)
      ? Result.fail(value.failure)
      : Result.fail(invalidExport(value.failure))
  }
  return Result.succeed(value.success)
}

/**
 * Normalize and validate a plain config value or a config-valued Result. The
 * envelope is validated with the strict config contract, and every profile is
 * revalidated, including a profile Result's success value, so a forged Result
 * cannot bypass the plan contract. A lone profile plan is not a config.
 * @param value - the exported config value.
 * @returns the validated config, a native envelope schema failure, or a
 * config-level invalid-export failure.
 */
export function validateConfigValue(
  value: unknown,
): Result.Result<EedshConfig, Schema.SchemaError | InvalidConfigValue> {
  const unwrapped = unwrapConfigValue(value)
  if (Result.isFailure(unwrapped)) return Result.fail(unwrapped.failure)
  const decoded = decodeEnvelope(unwrapped.success)
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
  const envelope = decoded.success
  const profiles: Record<string, Result.Result<ProfilePlan, Schema.SchemaError>> = {}
  for (const [name, entry] of Object.entries(envelope.profiles)) {
    if (Result.isResult(entry)) {
      if (Result.isFailure(entry)) {
        if (!Schema.isSchemaError(entry.failure)) return Result.fail(invalidExport(entry.failure))
        profiles[name] = Result.fail(entry.failure)
        continue
      }
      profiles[name] = validateProfileDefinition(name, envelope.dsh, entry.success)
      continue
    }
    profiles[name] = validateProfileDefinition(name, envelope.dsh, entry)
  }
  return Result.succeed(configValue(envelope, profiles))
}
