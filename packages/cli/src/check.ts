/**
 * `eedsh check`: run the config project's own TypeScript compiler against its
 * nearest tsconfig and print the exact invocation. The config is never
 * evaluated, nothing is published, and tsc's exit code is the command's.
 * @module @eedsh/cli/check
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { isRecord } from 'effect/Predicate'
import { ConfigError } from './config'
import { EXIT_FAILURE } from './exit'
import type { SpawnLike, SpawnOptionsLike } from './spawn'

const TSCONFIG_FILENAME = 'tsconfig.json'

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
 * @returns the absolute tsconfig path, or undefined when there is none.
 */
export function findTsconfigPath(configPath: string): string | undefined {
  let dir = dirname(configPath)
  for (;;) {
    const candidate = join(dir, TSCONFIG_FILENAME)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Resolve the TypeScript package from the config's project.
 * @param configDir - directory the config lives in.
 * @returns the installation's version and tsc path, or undefined when unresolved.
 */
export function resolveTypeScript(configDir: string): TypeScriptInstallation | undefined {
  const require = createRequire(join(configDir, 'eedsh-check.cjs'))
  let manifestPath: string
  try {
    manifestPath = require.resolve('typescript/package.json')
  } catch {
    return undefined
  }
  let manifest: { version?: unknown; bin?: unknown }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
  } catch {
    return undefined
  }
  const bin = manifest.bin
  const relative = typeof bin === 'string' ? bin : isRecord(bin) ? bin.tsc : undefined
  if (typeof relative !== 'string') return undefined
  return {
    version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
    binPath: resolve(dirname(manifestPath), relative),
  }
}

function formatCommandLine(parts: readonly string[]): string {
  return parts.map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(' ')
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return resolve(left) === resolve(right)
  }
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

function checkFailure(stderr: (line: string) => void, code: string, message: string): number {
  const error = new ConfigError(code, message)
  stderr(`eedsh: ${error.code}: ${error.message}`)
  return EXIT_FAILURE
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
  return new Promise((resolveExit) => {
    const child = input.spawn(command, args, options)
    child.on('exit', (code) => resolveExit(code ?? EXIT_FAILURE))
    child.on('error', (error) => {
      input.stderr(`eedsh: cannot run ${command}: ${error.message}`)
      resolveExit(EXIT_FAILURE)
    })
  })
}

/**
 * Run the project's compiler against the config's project.
 * @param input - config path, passthrough arguments, output sinks, and spawn seam.
 * @returns the compiler's exit code, or a failure code when the check cannot run.
 */
export async function runCheck(input: CheckInput): Promise<number> {
  if (!existsSync(input.configPath)) {
    return checkFailure(
      input.stderr,
      'config.not_found',
      `cannot read ${input.configPath}; create eedsh.config.ts or pass --config <path>`,
    )
  }

  const tsconfigPath = findTsconfigPath(input.configPath)
  if (tsconfigPath === undefined) {
    return checkFailure(
      input.stderr,
      'check.tsconfig_missing',
      `cannot find a tsconfig.json at or above ${input.configPath}; create one that includes the config`,
    )
  }

  const configDir = dirname(input.configPath)
  const typescript = resolveTypeScript(configDir)
  if (typescript === undefined) {
    return checkFailure(
      input.stderr,
      'check.typescript_missing',
      `cannot resolve TypeScript from ${configDir}; install it in the config's project (for example: pnpm add -D typescript)`,
    )
  }

  const args = ['--noEmit', '-p', tsconfigPath, ...input.tscArgs]
  input.stdout(`eedsh: TypeScript ${typescript.version}`)
  input.stdout(`eedsh: tsconfig ${tsconfigPath}`)
  input.stdout(
    `eedsh: running ${formatCommandLine([process.execPath, typescript.binPath, ...args])}`,
  )

  const listing = await capture(input, process.execPath, [
    typescript.binPath,
    '-p',
    tsconfigPath,
    '--listFilesOnly',
  ])
  if (listing.code !== 0) {
    writeLines(input.stderr, listing.stderr)
    input.stderr(`eedsh: cannot list the project files with ${tsconfigPath}`)
    return listing.code
  }
  if (!listedFiles(listing.stdout, input.configPath)) {
    return checkFailure(
      input.stderr,
      'check.config_not_in_project',
      `${input.configPath} is not included by ${tsconfigPath}; add it to the tsconfig's "include" or "files"`,
    )
  }

  const exitCode = await runInherited(input, process.execPath, [typescript.binPath, ...args])
  if (exitCode === 0) input.stdout('eedsh: check passed')
  else input.stderr(`eedsh: check failed (exit ${exitCode})`)
  return exitCode
}
