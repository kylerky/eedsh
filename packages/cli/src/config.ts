/**
 * Config evaluation. A config is a single TypeScript module at the XDG path or
 * an explicit `--config` path; its default export is an eedsh config. The
 * module is imported in-process through tsx's ESM and CJS hooks, with no build
 * step or temporary file, and resolves imports against its own project's
 * nearest tsconfig.
 * @module @eedsh/cli/config
 */
import { statSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type EedshConfig, validateConfigValue } from '@eedsh/plan'
import { Data, Effect, Option } from 'effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { CONFIG_FILENAME } from './config-path'
import { resolveDshInstallation } from './dsh'
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

/** Read a config's default export as a validated multi-profile config. */
function exportedConfig(
  exported: unknown,
): Result.Result<EedshConfig, ConfigError | Schema.SchemaError> {
  const result = validateConfigValue(exported)
  if (Result.isFailure(result)) {
    return Schema.isSchemaError(result.failure)
      ? Result.fail(result.failure)
      : Result.fail(new ConfigError(result.failure.code, result.failure.message))
  }
  return Result.succeed(result.success)
}

/**
 * Native dynamic import. Going through `new Function` keeps bundlers and test
 * transformers from rewriting the specifier, so config evaluation always uses
 * the process's module loader (tsx, registered by {@link ensureTsxLoader}).
 */
const nativeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<{ default?: unknown }>

/** The tsconfig tsx resolves imports against: a path, or false for none. */
type TsxConfigSelection = string | false

interface TsxLoader {
  readonly selection: TsxConfigSelection
  unregister(): Promise<void>
}

let loaderHandle: TsxLoader | undefined
let loaderQueue: Promise<void> = Promise.resolve()

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

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name]
  else process.env[name] = previous
}

/**
 * Set the authoring environment for one config import and return its restore
 * function. The pinned DSH manifest survives module duplication and is visible
 * to config-project's own copy of `@eedsh/config`; the config directory lets a
 * relative package root resolve against the file rather than the CLI's cwd.
 */
function importEnvironment(configPath: string): () => void {
  const previousAnchor = process.env.EEDSH_DSH_ANCHOR
  const previousConfigDir = process.env.EEDSH_CONFIG_DIR
  const installation = resolveDshInstallation()
  if (Result.isSuccess(installation)) {
    process.env.EEDSH_DSH_ANCHOR = installation.success.installAnchor
  } else {
    delete process.env.EEDSH_DSH_ANCHOR
  }
  process.env.EEDSH_CONFIG_DIR = dirname(configPath)
  return () => {
    restoreEnv('EEDSH_DSH_ANCHOR', previousAnchor)
    restoreEnv('EEDSH_CONFIG_DIR', previousConfigDir)
  }
}

/**
 * Import a config module and validate its default export as an eedsh config.
 * Imports resolve against the nearest tsconfig at or above the config file (or
 * the loader's ordinary rules when there is none), never the caller's working
 * directory. The module URL carries the file's modification time so a watch
 * rerun re-evaluates an edited config instead of reusing the module cache.
 * @param configPath - absolute config path.
 * @returns an Effect carrying the validated config, a config failure, or the
 * native schema error for an invalid envelope or export.
 */
export function loadConfig(
  configPath: string,
): Effect.Effect<EedshConfig, ConfigError | Schema.SchemaError> {
  return Effect.gen(function* () {
    const pathResult = validateConfigPath(configPath)
    if (Result.isFailure(pathResult)) return yield* Effect.fail(pathResult.failure)

    const tsconfig = findTsconfigPath(configPath)
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

    const stamp = yield* Effect.try({
      try: () => statSync(configPath).mtimeMs,
      catch: (cause) =>
        new ConfigError('config.not_found', `cannot read ${configPath}: ${errorMessage(cause)}`),
    })

    const url = pathToFileURL(configPath)
    url.search = `?eedsh=${stamp}`
    const imported = yield* Effect.tryPromise({
      try: async () => {
        const restore = importEnvironment(configPath)
        try {
          return await nativeImport(url.href)
        } finally {
          restore()
        }
      },
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
          `${configPath} must default-export an eedsh config`,
        ),
      )
    }
    const result = exportedConfig(exported)
    if (Result.isFailure(result)) return yield* Effect.fail(result.failure)
    return result.success
  })
}
