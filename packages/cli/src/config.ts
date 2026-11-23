/**
 * Config evaluation. A config is a single TypeScript module at the XDG path or
 * an explicit `--config` path; its default export is a synchronous factory
 * `(input) => ConfigBuilder`. The module is imported in-process through tsx's
 * ESM and CJS hooks, with no build step or temporary file, and resolves imports
 * against its own project's nearest tsconfig. Evaluation records query
 * descriptors; the invocation resolves them in one phase, then the terminal
 * build consumes the resulting table.
 * @module @eedsh/cli/config
 */
import { dirname, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type BundleQueryDescriptor,
  type ConfigProvenance,
  clearProvenance,
  configProvenance,
  isAuthoringDefect,
  type ResolutionTable,
  type ResolutionTrace,
} from '@eedsh/config'
import type { EedshConfig } from '@eedsh/plan'
import { Data, Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { CONFIG_FILENAME } from './config-path'
import type { DiscoveredDshInstallation } from './dsh-discovery'
import { type AuthoringError, isAuthoringError } from './internal/authoring-error'
import type { DshFailure } from './internal/effect/errors'
import { BundleResolver, type BundleResolverShape } from './internal/effect/services'
import { findTsconfigPath } from './internal/tsconfig'

/** A config path, evaluation, or export failure. */
export class ConfigError extends Data.TaggedError('ConfigError')<{
  readonly code: string
  readonly message: string
}> {
  constructor(code: string, message: string) {
    super({ code, message })
  }
}

/** The invocation inputs config evaluation needs. */
export interface ConfigLoadOptions {
  /** The installation selected for this invocation. */
  readonly installation: DiscoveredDshInstallation
  /** The invocation environment, for the preview profile-root override. */
  readonly env: Record<string, string | undefined>
  /** A nonce that makes a watch rerun re-evaluate an edited config. */
  readonly evaluationNonce?: string
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
    const stringified = Result.try(() => JSON.stringify(error))
    return Result.isSuccess(stringified) && typeof stringified.success === 'string'
      ? stringified.success
      : String(error)
  }
  return String(error)
}

/** Every expected failure config evaluation can report. */
export type ConfigLoadFailure =
  | ConfigError
  | Schema.SchemaError
  | AuthoringError
  | ResolutionTableFailure
  | DshFailure

/** Resolution failures produced by the CLI keep the config package's identity. */
type ResolutionTableFailure = import('@eedsh/config').ResolutionError

/** One successful config evaluation, with everything the REPL observes. */
export interface LoadedConfig {
  /** The validated multi-profile config. */
  readonly config: EedshConfig
  /** The most recent evaluation's recorded provenance, when it has any. */
  readonly provenance: ConfigProvenance | undefined
  /** Absolute directory of the evaluated config file. */
  readonly configDir: string
  /** The distinct query descriptors the evaluated builder recorded. */
  readonly queries: readonly BundleQueryDescriptor[]
  /** The complete resolution table the build consumed. */
  readonly resolution: ResolutionTable
  /** One trace per resolved bundle and root pair. */
  readonly traces: readonly ResolutionTrace[]
}

/** A builder shape check that works across two copies of `@eedsh/config`. */
interface ConfigBuilderLike {
  queries(): readonly BundleQueryDescriptor[]
  build(table: ResolutionTable): Result.Result<EedshConfig, Schema.SchemaError>
}

function isConfigBuilder(value: unknown): value is ConfigBuilderLike {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.queries === 'function' && typeof record.build === 'function'
}

/**
 * Native dynamic import. Going through `new Function` keeps bundlers and test
 * transformers from rewriting the specifier, so config evaluation always uses
 * the process's module loader (tsx, registered by {@link ensureTsxLoader}).
 */
const nativeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<{ default?: unknown }>

// tsx preserves the config's source map; Node must map stack frames so
// provenance records the original config line rather than the transformed one.
process.setSourceMapsEnabled(true)

/** The tsconfig tsx resolves imports against: a path, or false for none. */
type TsxConfigSelection = string | false

interface TsxLoader {
  readonly selection: TsxConfigSelection
  unregister(): Promise<void>
}

let loaderHandle: TsxLoader | undefined
let loaderQueue: Promise<void> = Promise.resolve()
let evaluationSequence = 0

async function createLoader(selection: TsxConfigSelection): Promise<TsxLoader> {
  const [esmApi, cjsApi] = await Promise.all([import('tsx/esm/api'), import('tsx/cjs/api')])
  const esmUnregister = esmApi.register(
    selection === false ? { tsconfig: false } : { tsconfig: selection },
  )
  const cjsUnregister = cjsApi.register()
  return {
    selection,
    unregister: async () => {
      await esmUnregister()
      cjsUnregister()
    },
  }
}

/**
 * Make tsx resolve config imports against the config project's tsconfig. Both
 * hooks are registered: a `.ts` config in a project without
 * `"type": "module"` is classified as CommonJS, so its dynamic import reaches
 * the CJS loader rather than the ESM hooks. Registration is keyed by the
 * tsconfig selection; switching config projects unregisters the previous hooks
 * first. Calls are serialized, and a failed registration is retried by the next
 * load. Never uses the process-global `TSX_TSCONFIG_PATH`.
 */
function ensureTsxLoader(selection: TsxConfigSelection): Promise<Result.Result<void, unknown>> {
  const next = loaderQueue.then(async () => {
    if (loaderHandle !== undefined && loaderHandle.selection === selection) return
    if (loaderHandle !== undefined) {
      const previous = loaderHandle
      loaderHandle = undefined
      await previous.unregister()
    }
    loaderHandle = await createLoader(selection)
  })
  loaderQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next.then(
    () => Result.succeed(undefined),
    (cause: unknown) => Result.fail(cause),
  )
}

/**
 * The stable failure for a non-TypeScript config path.
 * @param configPath - the rejected path.
 * @returns the `config.unsupported_extension` error naming `config.ts`.
 */
export function unsupportedConfigExtensionError(configPath: string): ConfigError {
  return new ConfigError(
    'config.unsupported_extension',
    `${configPath} is not a TypeScript config; eedsh loads only ${CONFIG_FILENAME}`,
  )
}

/**
 * Check a config path's extension. Only `.ts` is accepted; `.mts`, `.js`, and
 * `.mjs` are rejected before evaluation.
 * @param configPath - absolute config path.
 * @returns success for a TypeScript path, or `config.unsupported_extension`.
 */
export function validateConfigPath(configPath: string): Result.Result<void, ConfigError> {
  return extname(configPath) === '.ts'
    ? Result.succeed(undefined)
    : Result.fail(unsupportedConfigExtensionError(configPath))
}

/** Map one thrown evaluation value onto its expected channel or a defect. */
function failureOfEvaluation(
  cause: unknown,
  configPath: string,
  action: string,
): ConfigLoadFailure | { readonly defect: unknown } {
  if (isAuthoringDefect(cause)) return { defect: cause }
  if (Schema.isSchemaError(cause)) return cause
  if (isAuthoringError(cause)) return cause
  return new ConfigError(
    'config.import_failed',
    `cannot ${action} ${configPath}: ${errorMessage(cause)}`,
  )
}

/**
 * Import a config module, invoke its default-exported factory once with the
 * invocation inputs, resolve every query descriptor it recorded, and build the
 * validated config from the resolution table.
 * @param configPath - absolute config path.
 * @param options - the selected installation, environment, and evaluation nonce.
 * @returns an Effect carrying the validated config and its resolution, or a
 * config failure. Authoring defects are defects, not expected failures.
 */
export function loadConfig(
  configPath: string,
  options: ConfigLoadOptions,
): Effect.Effect<LoadedConfig, ConfigLoadFailure, FileSystem.FileSystem | BundleResolverShape> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const resolver = yield* BundleResolver
    const pathResult = validateConfigPath(configPath)
    if (Result.isFailure(pathResult)) return yield* Effect.fail(pathResult.failure)

    const tsconfig = yield* findTsconfigPath(configPath).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    )
    const selection: TsxConfigSelection = Option.isSome(tsconfig) ? tsconfig.value : false
    const loaded = yield* Effect.promise(() => ensureTsxLoader(selection))
    if (Result.isFailure(loaded)) {
      return yield* Effect.fail(
        new ConfigError(
          'config.import_failed',
          `cannot initialize the TypeScript loader: ${errorMessage(loaded.failure)}`,
        ),
      )
    }

    const stamp = yield* fs.stat(configPath).pipe(
      Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
      Effect.mapError(
        (cause) =>
          new ConfigError('config.not_found', `cannot read ${configPath}: ${errorMessage(cause)}`),
      ),
    )

    const url = pathToFileURL(configPath)
    let evaluation = options.evaluationNonce
    if (evaluation === undefined) {
      evaluationSequence += 1
      evaluation = String(evaluationSequence)
    }
    url.search = `?eedsh=${stamp}&evaluation=${encodeURIComponent(evaluation)}`
    process.setSourceMapsEnabled(true)
    clearProvenance()
    const attempt = yield* Effect.result(
      Effect.tryPromise({
        try: async () => ({ module: await nativeImport(url.href) }),
        catch: (cause) => ({ cause }),
      }),
    )
    if (Result.isFailure(attempt)) {
      const mapped = failureOfEvaluation(attempt.failure.cause, configPath, 'import')
      if ('defect' in mapped) return yield* Effect.die(mapped.defect)
      return yield* Effect.fail(mapped)
    }

    const exported = attempt.success.module.default
    if (exported === undefined) {
      return yield* Effect.fail(
        new ConfigError(
          'config.missing_default_export',
          `${configPath} must default-export an eedsh config`,
        ),
      )
    }
    if (typeof exported !== 'function') {
      return yield* Effect.fail(
        new ConfigError(
          'config.invalid_default_export',
          `${configPath} must default-export a (input) => ConfigBuilder function; received ${typeof exported}`,
        ),
      )
    }

    const configDir = dirname(configPath)
    const input = {
      dshVersion: options.installation.version,
      configDir,
    }
    const built = Result.try(() => (exported as (value: typeof input) => unknown)(input))
    if (Result.isFailure(built)) {
      const mapped = failureOfEvaluation(built.failure, configPath, 'evaluate')
      if ('defect' in mapped) return yield* Effect.die(mapped.defect)
      return yield* Effect.fail(mapped)
    }
    if (!isConfigBuilder(built.success)) {
      return yield* Effect.fail(
        new ConfigError(
          'config.invalid_default_export',
          `${configPath} must default-export a function that returns a ConfigBuilder`,
        ),
      )
    }
    const builder = built.success

    const queries = Result.try(() => builder.queries())
    if (Result.isFailure(queries)) {
      const mapped = failureOfEvaluation(queries.failure, configPath, 'evaluate')
      if ('defect' in mapped) return yield* Effect.die(mapped.defect)
      return yield* Effect.fail(mapped)
    }

    const outcome = yield* resolver.resolve({
      queries: queries.success,
      installation: options.installation,
      configDir,
      env: options.env,
    })

    const result = Result.try(() => builder.build(outcome.table))
    if (Result.isFailure(result)) {
      const mapped = failureOfEvaluation(result.failure, configPath, 'build')
      if ('defect' in mapped) return yield* Effect.die(mapped.defect)
      return yield* Effect.fail(mapped)
    }
    if (Result.isFailure(result.success)) return yield* Effect.fail(result.success.failure)
    const loadedConfig: LoadedConfig = {
      config: result.success.success,
      provenance: configProvenance(),
      configDir,
      queries: queries.success,
      resolution: outcome.table,
      traces: outcome.traces,
    }
    return loadedConfig
  })
}
