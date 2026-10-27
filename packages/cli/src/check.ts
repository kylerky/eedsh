/**
 * `eedsh check`: run the config project's own TypeScript compiler against its
 * nearest tsconfig and print the exact invocation. The config is never
 * evaluated, nothing is published, and tsc's exit code is the command's.
 * @module @eedsh/cli/check
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { Effect, Option, Schema } from 'effect'
import * as Result from 'effect/Result'
import { EXIT_FAILURE } from './exit'
import { CheckFailure } from './internal/effect/errors'
import { messageOf } from './internal/error-message'
import { readVersion } from './internal/schema-readers'
import type { SpawnLike, SpawnOptionsLike } from './spawn'

const TSCONFIG_FILENAME = 'tsconfig.json'

const packageBinSchema = Schema.Union([Schema.String, Schema.Struct({ tsc: Schema.String })])

function readPackageBin(value: unknown): Option.Option<string> {
  const decoded = Schema.decodeUnknownOption(packageBinSchema)(value)
  if (Option.isNone(decoded)) return Option.none()
  return Option.some(typeof decoded.value === 'string' ? decoded.value : decoded.value.tsc)
}

/** The project's TypeScript installation. */
export interface TypeScriptInstallation {
  /** The resolved compiler version. */
  version: string
  /** Absolute path of the compiler's `bin/tsc` script. */
  binPath: string
}

/** Inputs for {@link runCheck}. */
export interface CheckInput {
  /** Absolute config path to check. */
  configPath: string
  /** Arguments after `--`, forwarded verbatim to tsc. */
  tscArgs: readonly string[]
  stdout: (line: string) => void
  stderr: (line: string) => void
  env: Record<string, string | undefined>
  cwd: string
  spawn: SpawnLike
}

/**
 * Find the nearest tsconfig.json at or above the config file.
 * @param configPath - absolute config path.
 * @returns the absolute tsconfig path, or None when there is none.
 */
export function findTsconfigPath(configPath: string): Option.Option<string> {
  let dir = dirname(configPath)
  for (;;) {
    const candidate = join(dir, TSCONFIG_FILENAME)
    if (existsSync(candidate)) return Option.some(candidate)
    const parent = dirname(dir)
    if (parent === dir) return Option.none()
    dir = parent
  }
}

/**
 * Resolve the TypeScript package from the config's project.
 * @param configDir - directory the config lives in.
 * @returns the installation's version and tsc path, or None when unresolved.
 */
export function resolveTypeScript(configDir: string): Option.Option<TypeScriptInstallation> {
  const require = createRequire(join(configDir, 'eedsh-check.cjs'))
  const resolved = Result.try({
    try: () => require.resolve('typescript/package.json'),
    catch: () => undefined,
  })
  if (Result.isFailure(resolved)) return Option.none()
  const manifestPath = resolved.success
  const parsed = Result.try({
    try: () =>
      JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown; bin?: unknown },
    catch: () => undefined,
  })
  if (Result.isFailure(parsed)) return Option.none()
  const manifest = parsed.success
  const relative = readPackageBin(manifest.bin)
  if (Option.isNone(relative)) return Option.none()
  return Option.some({
    version: Option.getOrElse(readVersion(manifest.version), () => 'unknown'),
    binPath: resolve(dirname(manifestPath), relative.value),
  })
}

function formatCommandLine(parts: readonly string[]): string {
  return parts.map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(' ')
}

function samePath(left: string, right: string): boolean {
  const real = Result.try(() => realpathSync(left) === realpathSync(right))
  return Result.isSuccess(real) ? real.success : resolve(left) === resolve(right)
}

function listedFiles(stdout: string, configPath: string): boolean {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line !== '' && samePath(line, configPath))
}

function writeLines(stderr: (line: string) => void, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== '') stderr(line)
  }
}

function checkFailure(code: string, message: string): CheckFailure {
  return new CheckFailure({ code, message })
}

function spawnFailure(command: string, cause: unknown): CheckFailure {
  const message = messageOf(cause)
  return new CheckFailure({
    code: 'check.spawn_failed',
    message: `cannot run ${command}: ${message}`,
  })
}

function capture(
  input: CheckInput,
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const options: SpawnOptionsLike = { cwd: input.cwd, env: input.env, stdio: 'pipe' }
    const child = input.spawn(command, args, options)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('close', (code) => resolveResult({ code: code ?? EXIT_FAILURE, stdout, stderr }))
    child.on('error', rejectResult)
  })
}

function runInherited(input: CheckInput, command: string, args: string[]): Promise<number> {
  const options: SpawnOptionsLike = { cwd: input.cwd, env: input.env, stdio: 'inherit' }
  return new Promise((resolveExit, rejectExit) => {
    const child = input.spawn(command, args, options)
    child.on('exit', (code) => resolveExit(code ?? EXIT_FAILURE))
    child.on('error', rejectExit)
  })
}

/**
 * Run the project's compiler against the config's project.
 * @param input - config path, passthrough arguments, output sinks, and spawn seam.
 * @returns an Effect carrying the compiler's exit code, or a check failure when
 * the check cannot run. A nonzero compiler exit is a successful outcome.
 */
export function runCheck(input: CheckInput): Effect.Effect<number, CheckFailure> {
  return Effect.gen(function* () {
    if (!existsSync(input.configPath)) {
      return yield* Effect.fail(
        checkFailure(
          'config.not_found',
          `cannot read ${input.configPath}; create eedsh.config.ts or pass --config <path>`,
        ),
      )
    }

    const tsconfigPath = findTsconfigPath(input.configPath)
    if (Option.isNone(tsconfigPath)) {
      return yield* Effect.fail(
        checkFailure(
          'check.tsconfig_missing',
          `cannot find a tsconfig.json at or above ${input.configPath}; create one that includes the config`,
        ),
      )
    }

    const configDir = dirname(input.configPath)
    const typescript = resolveTypeScript(configDir)
    if (Option.isNone(typescript)) {
      return yield* Effect.fail(
        checkFailure(
          'check.typescript_missing',
          `cannot resolve TypeScript from ${configDir}; install it in the config's project (for example: pnpm add -D typescript)`,
        ),
      )
    }

    const args = ['--noEmit', '-p', tsconfigPath.value, ...input.tscArgs]
    input.stdout(`eedsh: TypeScript ${typescript.value.version}`)
    input.stdout(`eedsh: tsconfig ${tsconfigPath.value}`)
    input.stdout(
      `eedsh: running ${formatCommandLine([process.execPath, typescript.value.binPath, ...args])}`,
    )

    const listing = yield* Effect.tryPromise({
      try: () =>
        capture(input, process.execPath, [
          typescript.value.binPath,
          '-p',
          tsconfigPath.value,
          '--listFilesOnly',
        ]),
      catch: (cause) => spawnFailure(process.execPath, cause),
    })
    if (listing.code !== 0) {
      writeLines(input.stderr, listing.stderr)
      input.stderr(`eedsh: cannot list the project files with ${tsconfigPath.value}`)
      return listing.code
    }
    if (!listedFiles(listing.stdout, input.configPath)) {
      return yield* Effect.fail(
        checkFailure(
          'check.config_not_in_project',
          `${input.configPath} is not included by ${tsconfigPath}; add it to the tsconfig's "include" or "files"`,
        ),
      )
    }

    const exitCode = yield* Effect.tryPromise({
      try: () => runInherited(input, process.execPath, [typescript.value.binPath, ...args]),
      catch: (cause) => spawnFailure(process.execPath, cause),
    })
    if (exitCode === 0) input.stdout('eedsh: check passed')
    else input.stderr(`eedsh: check failed (exit ${exitCode})`)
    return exitCode
  })
}
