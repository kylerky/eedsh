/**
 * Config discovery and evaluation. A config is a TypeScript module whose
 * default export is a validated profile plan or a validation Result; it is
 * imported in-process through tsx's ESM and CJS hooks, with no build step or
 * temporary file.
 * @module @eedsh/cli/config
 */
import { existsSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type ProfilePlan, validatePlan } from '@eedsh/config'
import { Data, Effect } from 'effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

/** TypeScript config file names, in discovery order. */
export const CONFIG_FILENAMES = ['eedsh.config.ts', 'eedsh.config.mts'] as const

/** JavaScript config names eedsh rejects with a migration hint. */
export const UNSUPPORTED_CONFIG_FILENAMES = ['eedsh.config.mjs', 'eedsh.config.js'] as const

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.mts'])

/** A config discovery, evaluation, or export failure. */
export class ConfigError extends Data.TaggedError('ConfigError')<{
  readonly code: string
  readonly message: string
}> {
  constructor(code: string, message: string) {
    super({ code, message })
  }
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

/** Read a config's default export as a validated plan. */
function exportedPlan(
  exported: unknown,
): Result.Result<ProfilePlan, ConfigError | Schema.SchemaError> {
  if (!Result.isResult(exported)) return validatePlan(exported)
  if (Result.isFailure(exported)) {
    return Schema.isSchemaError(exported.failure)
      ? Result.fail(exported.failure)
      : Result.fail(
          new ConfigError(
            'config.invalid_export',
            `config exported an invalid failure: ${errorMessage(exported.failure)}`,
          ),
        )
  }
  return validatePlan(exported.success)
}

/**
 * Native dynamic import. Going through `new Function` keeps bundlers and test
 * transformers from rewriting the specifier, so config evaluation always uses
 * the process's module loader (tsx, registered by {@link ensureTsxLoader}).
 */
const nativeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<{ default?: unknown }>

let loaderRegistration: Promise<Result.Result<void, unknown>> | undefined

async function registerTsxLoader(): Promise<void> {
  const [esmApi, cjsApi] = await Promise.all([import('tsx/esm/api'), import('tsx/cjs/api')])
  esmApi.register()
  cjsApi.register()
}

/**
 * Register tsx's ESM and CJS hooks once per process. Both are needed: a `.ts`
 * config in a project without `"type": "module"` is classified as CommonJS, so
 * its dynamic import reaches the CJS loader rather than the ESM hooks.
 * Registration is lazy (never for `--help`/`--version`) and idempotent.
 */
function ensureTsxLoader(): Promise<Result.Result<void, unknown>> {
  loaderRegistration ??= registerTsxLoader().then(
    () => Result.succeed(undefined),
    (cause: unknown) => Result.fail(cause),
  )
  return loaderRegistration
}

/**
 * Find the config file in a directory.
 * @param cwd - directory to search.
 * @returns the absolute config path, or undefined when none exists.
 */
export function findConfigPath(cwd: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(cwd, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Find a JavaScript config that discovery rejects rather than silently skips.
 * @param cwd - directory to search.
 * @returns the rejected absolute config path, or undefined when none exists.
 */
export function findUnsupportedConfigPath(cwd: string): string | undefined {
  for (const name of UNSUPPORTED_CONFIG_FILENAMES) {
    const candidate = join(cwd, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * The stable failure for a JavaScript config path.
 * @param configPath - the rejected path.
 * @returns the `config.unsupported_extension` error naming the accepted files.
 */
export function unsupportedConfigExtensionError(configPath: string): ConfigError {
  const accepted = CONFIG_FILENAMES.join(' and ')
  return new ConfigError(
    'config.unsupported_extension',
    `${configPath} is not a TypeScript config; eedsh loads only ${accepted} (rename the file)`,
  )
}

/**
 * Check a config path's extension.
 * @param configPath - absolute config path.
 * @returns success for a supported path, or `config.unsupported_extension` for a
 * JavaScript config.
 */
export function validateConfigPath(configPath: string): Result.Result<void, ConfigError> {
  return SUPPORTED_EXTENSIONS.has(extname(configPath))
    ? Result.succeed(undefined)
    : Result.fail(unsupportedConfigExtensionError(configPath))
}

/**
 * Import a config module and validate its default export as a profile plan.
 * The module URL carries the file's modification time so a watch rerun
 * re-evaluates an edited config instead of reusing the module cache.
 * @param configPath - absolute config path.
 * @returns an Effect carrying the validated plan, a config failure, or the
 * native schema error for an invalid export.
 */
export function loadConfig(
  configPath: string,
): Effect.Effect<ProfilePlan, ConfigError | Schema.SchemaError> {
  return Effect.gen(function* () {
    const pathResult = validateConfigPath(configPath)
    if (Result.isFailure(pathResult)) return yield* Effect.fail(pathResult.failure)

    const loaded = yield* Effect.promise(() => ensureTsxLoader())
    if (Result.isFailure(loaded)) {
      loaderRegistration = undefined
      return yield* Effect.fail(
        new ConfigError(
          'config.import_failed',
          `cannot initialize the TypeScript loader: ${errorMessage(loaded.failure)}`,
        ),
      )
    }

    const stamp = yield* Effect.try({
      try: () => statSync(configPath).mtimeMs,
      catch: (cause) =>
        new ConfigError('config.not_found', `cannot read ${configPath}: ${errorMessage(cause)}`),
    })

    const url = pathToFileURL(configPath)
    url.search = `?eedsh=${stamp}`
    const imported = yield* Effect.tryPromise({
      try: () => nativeImport(url.href),
      catch: (cause) =>
        Schema.isSchemaError(cause)
          ? cause
          : new ConfigError(
              'config.import_failed',
              `cannot import ${configPath}: ${errorMessage(cause)}`,
            ),
    })

    const exported = imported.default
    if (exported === undefined) {
      return yield* Effect.fail(
        new ConfigError(
          'config.missing_default_export',
          `${configPath} must default-export a profile plan`,
        ),
      )
    }
    const result = exportedPlan(exported)
    if (Result.isFailure(result)) return yield* Effect.fail(result.failure)
    return result.success
  })
}
