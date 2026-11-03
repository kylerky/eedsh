/**
 * The multi-profile config envelope contract: the strict envelope schema, the
 * per-profile plan validation, and the untrusted-export normalization shared by
 * the CLI and the authoring package.
 * @module @eedsh/plan/envelope
 */
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { PLAN_FORMAT, PLAN_VERSION } from './constants'
import { isPlainObject } from './plain-object'
import { isSafeProfileName, ProfileNameSchema, type ProfilePlan } from './schema'
import { validatePlan } from './validate'

/** A config-level validation failure that is not Effect's native schema error. */
export interface InvalidConfigValue {
  readonly _tag: 'InvalidConfigValue'
  /** Stable failure code for command diagnostics. */
  readonly code: 'config.invalid_export'
  readonly message: string
}

/** One validated config: one Result per named profile. */
export interface EedshConfig {
  /** Profile selected when a command needs one and none is named. */
  readonly defaultProfile?: string
  /** Profile key to its validated plan, or that profile's native schema error. */
  readonly profiles: Readonly<Record<string, Result.Result<ProfilePlan, Schema.SchemaError>>>
}

/** A validated config envelope, before per-profile plans are built. */
export interface ConfigEnvelope {
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
function profileRecordIssues(profiles: Readonly<Record<string, unknown>>): Schema.FilterIssue[] {
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
    defaultProfile: Schema.optional(ProfileNameSchema),
    profiles: ProfileRecordSchema,
  }),
  'config must be a JSON object with profiles',
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

/** The public config envelope schema: safe keys and a declared default. */
export const EedshConfigSchema = refine(ConfigEnvelopeBaseSchema, defaultProfileIssues)

const decodeEnvelope = Schema.decodeUnknownResult(EedshConfigSchema, {
  errors: 'all',
  onExcessProperty: 'error',
})

/**
 * Decode the strict config envelope: safe profile keys and a declared default.
 * Profile plans are not decoded here.
 * @param value - the candidate config envelope.
 * @returns the envelope, or Effect's native schema error.
 */
export function decodeConfigEnvelope(
  value: unknown,
): Result.Result<ConfigEnvelope, Schema.SchemaError> {
  return decodeEnvelope(value)
}

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
 * the profile name, so a plan forged inside a profile Result cannot choose it.
 * @param name - the profile key.
 * @param definition - the profile descriptor.
 * @returns the validated plan, or Effect's native schema error.
 */
export function validateProfileDefinition(
  name: string,
  definition: unknown,
): Result.Result<ProfilePlan, Schema.SchemaError> {
  const decoded = decodeProfileDefinition(definition)
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
  return validatePlan({
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    profile: { name },
    bundles: decoded.success.bundles ?? [],
    layers: decoded.success.layers ?? [],
    packages: decoded.success.packages ?? {},
  })
}

/**
 * Assemble a validated config value from a decoded envelope and its profiles.
 * @param envelope - the decoded envelope.
 * @param profiles - one plan Result per profile key.
 * @returns the detached config value.
 */
export function configValue(
  envelope: ConfigEnvelope,
  profiles: Readonly<Record<string, Result.Result<ProfilePlan, Schema.SchemaError>>>,
): EedshConfig {
  const base = { profiles }
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
      profiles[name] = validateProfileDefinition(name, entry.success)
      continue
    }
    profiles[name] = validateProfileDefinition(name, entry)
  }
  return Result.succeed(configValue(envelope, profiles))
}
