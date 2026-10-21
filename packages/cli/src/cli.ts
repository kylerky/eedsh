/**
 * The `eedsh` command: parse arguments, evaluate the typed config, publish it
 * into a DSH profile, optionally boot the pinned launcher, or run the config
 * project's TypeScript compiler. One-shot syncs use `Effect.runPromise`; watch
 * mode keeps one `ManagedRuntime` alive so the materializer's services are
 * reused across runs.
 * @module @eedsh/cli/cli
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { PlanValidationError, type ProfilePlan } from '@eedsh/config'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { isRecord } from 'effect/Predicate'
import { runCheck } from './check'
import {
  assertSupportedConfigPath,
  CONFIG_FILENAMES,
  ConfigError,
  findConfigPath,
  findUnsupportedConfigPath,
  loadConfig,
  unsupportedConfigExtensionError,
} from './config'
import { resolveDshInstallation } from './dsh'
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from './exit'
import type { DshResolveFailure, MaterializeError } from './internal/effect/errors'
import { liveServiceLayer } from './internal/effect/layer'
import type {
  DshInstallationShape,
  FileSystemShape,
  PackageManagerShape,
  PreflightShape,
} from './internal/effect/services'
import { type MaterializeResult, materialize } from './materialize/program'
import { preflightLayer } from './preflight'
import { defaultSpawn, type SpawnLike } from './spawn'
import { type WatchSession, watchConfigDirectory } from './watch'

const USAGE = `eedsh — typed configuration for DeepSeek Harness profiles

Usage:
  eedsh sync [--config <path>] [--strict] [--watch]
  eedsh check [--config <path>] [-- <tsc args>]
  eedsh run [--config <path>] [--no-sync] [-- <dsh args>]
  eedsh --help | --version

Commands:
  sync   evaluate the config, preflight the layers, and publish the profile
  check  typecheck the config's project with its own tsc; no sync, no publication
  run    sync (unless --no-sync) and boot the pinned dsh against the profile

Options:
  --config <path>  config file to load (default: eedsh.config.ts in the cwd)
  --strict         treat unmatched patch targets as failures
  --watch          re-run sync when files in the config directory change
  --no-sync        skip publication and boot the last published generation
  -- <tsc args>    pass the remaining arguments to the project's tsc
  -- <dsh args>    pass the remaining arguments to the dsh launcher`

/** The services the materializer needs, built once per CLI run. */
export type CliServiceLayer = Layer.Layer<
  FileSystemShape | PackageManagerShape | DshInstallationShape | PreflightShape,
  DshResolveFailure,
  never
>

/** Watch seam for `eedsh sync --watch`. */
export type WatchFactory = (dir: string, onChange: () => void) => Promise<WatchSession>

/** Overridable dependencies, for tests and embedders. */
export interface CliDeps {
  cwd?: string
  env?: Record<string, string | undefined>
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  /** Replace config evaluation. */
  loadConfig?: (configPath: string) => Promise<ProfilePlan>
  /** Replace the materializer's service layer. */
  services?: () => CliServiceLayer
  /** Replace the launcher spawn. */
  spawn?: SpawnLike
  /** Replace the config-directory watcher. */
  watch?: WatchFactory
  /** Stop watch mode when aborted. */
  signal?: AbortSignal
}

/** A parsed command line. */
export interface ParsedCli {
  command: 'sync' | 'run' | 'check' | 'help' | 'version'
  configPath?: string
  strict: boolean
  watch: boolean
  noSync: boolean
  dshArgs: string[]
  tscArgs: string[]
}

/** A command-line usage error. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

function takeValue(args: string[], index: number, option: string): [string, number] {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`${option} needs a value`)
  }
  return [value, index + 1]
}

/**
 * Parse the CLI arguments.
 * @param argv - arguments after the executable and script.
 * @returns the parsed command.
 * @throws {UsageError} for an unknown command, option, or missing value.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCli {
  const args = [...argv]
  const parsed: ParsedCli = {
    command: 'help',
    strict: false,
    watch: false,
    noSync: false,
    dshArgs: [],
    tscArgs: [],
  }
  const first = args.shift()
  if (first === undefined || first === '--help' || first === '-h') return parsed
  if (first === '--version' || first === '-v') return { ...parsed, command: 'version' }
  if (first !== 'sync' && first !== 'run' && first !== 'check') {
    throw new UsageError(`unknown command "${first}"`)
  }
  parsed.command = first

  let afterSeparator = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (afterSeparator) {
      if (first === 'check') parsed.tscArgs.push(arg)
      else parsed.dshArgs.push(arg)
      continue
    }
    if (arg === '--') {
      if (first !== 'run' && first !== 'check') {
        throw new UsageError('"--" is only accepted by eedsh run and eedsh check')
      }
      afterSeparator = true
      continue
    }
    if (arg === '--help' || arg === '-h') return { ...parsed, command: 'help' }
    if (arg === '--config') {
      const [value, next] = takeValue(args, index, '--config')
      parsed.configPath = value
      index = next
      continue
    }
    if (arg === '--strict' && first === 'sync') {
      parsed.strict = true
      continue
    }
    if (arg === '--watch' && first === 'sync') {
      parsed.watch = true
      continue
    }
    if (arg === '--no-sync' && first === 'run') {
      parsed.noSync = true
      continue
    }
    throw new UsageError(`unknown option "${arg}"`)
  }
  return parsed
}

function runtimeLinkSpec(): string {
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('@eedsh/runtime/package.json')
  return `link:${dirname(manifest)}`
}

function cliVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  let text = ''
  for (const segment of path) {
    if (typeof segment === 'number') text += `[${segment}]`
    else text += text === '' ? String(segment) : `.${String(segment)}`
  }
  return text === '' ? 'plan' : text
}

function describeError(error: unknown): string[] {
  if (error instanceof PlanValidationError) {
    return error.issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
  }
  if (error instanceof ConfigError) return [`${error.code}: ${error.message}`]
  if (isRecord(error) && '_tag' in error) {
    const tagged = error
    switch (tagged._tag) {
      case 'FileSystemFailure':
        return [
          `cannot ${String(tagged.operation)} ${String(tagged.path)}: ${String(tagged.cause)}`,
        ]
      case 'PackageInstallFailure':
        return [
          `package installation failed in ${String(tagged.profileDir)}: ${String(tagged.cause)}`,
        ]
      case 'PreflightFailure': {
        const warnings = Array.isArray(tagged.warnings) ? tagged.warnings.map(String) : []
        return [String(tagged.message), ...warnings]
      }
      case 'SyncLocked':
        return [
          `another sync is running for this profile${
            tagged.pid === undefined ? '' : ` (pid ${String(tagged.pid)})`
          }; lock: ${String(tagged.lockPath)}`,
        ]
      case 'DshResolveFailure':
        return [`cannot resolve DSH package ${String(tagged.packageName)}: ${String(tagged.cause)}`]
      default:
        break
    }
  }
  return [error instanceof Error ? error.message : String(error)]
}

function report(stderr: (line: string) => void, error: unknown): void {
  for (const line of describeError(error)) stderr(`eedsh: ${line}`)
}

function printResult(
  stdout: (line: string) => void,
  stderr: (line: string) => void,
  plan: ProfilePlan,
  result: MaterializeResult,
): void {
  for (const warning of result.warnings) stderr(`eedsh: warning: ${warning}`)
  stdout(
    `eedsh: ${result.changed ? 'published' : 'unchanged'} profile ${plan.profile.name} (generation ${result.generationId.slice(0, 12)})`,
  )
}

interface CommandContext {
  configPath: string
  parsed: ParsedCli
  plan: ProfilePlan
  stdout: (line: string) => void
  stderr: (line: string) => void
  env: Record<string, string | undefined>
  cwd: string
  deps: CliDeps
}

function defaultServices(): CliServiceLayer {
  return Layer.mergeAll(liveServiceLayer, preflightLayer.pipe(Layer.provide(liveServiceLayer)))
}

function profileDirFor(plan: ProfilePlan, env: Record<string, string | undefined>): string {
  const home = env.DSH_HOME
  return home === undefined || home === ''
    ? resolveProfileDir(plan.profile.name)
    : resolveProfileDir(plan.profile.name, home)
}

function programFor(context: CommandContext, plan: ProfilePlan) {
  return materialize({
    plan,
    profileDir: profileDirFor(plan, context.env),
    eedshVersion: cliVersion(),
    runtimeSpec: runtimeLinkSpec(),
    generatedSpec: 'link:./.eedsh/generated',
    strict: context.parsed.strict,
    explain: false,
  })
}

interface SyncOutcome {
  ok: boolean
  result?: MaterializeResult
}

async function syncOnce(context: CommandContext): Promise<SyncOutcome> {
  const layer = (context.deps.services ?? defaultServices)()
  let outcome:
    | { _tag: 'Left'; left: MaterializeError }
    | { _tag: 'Right'; right: MaterializeResult }
  try {
    outcome = await Effect.runPromise(
      Effect.either(programFor(context, context.plan).pipe(Effect.provide(layer))),
    )
  } catch (error) {
    report(context.stderr, error)
    return { ok: false }
  }
  if (outcome._tag === 'Left') {
    report(context.stderr, outcome.left)
    return { ok: false }
  }
  printResult(context.stdout, context.stderr, context.plan, outcome.right)
  return { ok: true, result: outcome.right }
}

function waitForStop(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolveStop) => {
    if (signal !== undefined) {
      if (signal.aborted) return resolveStop()
      signal.addEventListener('abort', () => resolveStop(), { once: true })
      return
    }
    process.once('SIGINT', () => resolveStop())
    process.once('SIGTERM', () => resolveStop())
  })
}

async function syncWatch(context: CommandContext): Promise<number> {
  const layer = (context.deps.services ?? defaultServices)()
  const runtime = ManagedRuntime.make(layer)
  let running = false
  let queued = false

  const runWith = async (plan: ProfilePlan): Promise<void> => {
    try {
      const outcome = await runtime.runPromise(Effect.either(programFor(context, plan)))
      if (outcome._tag === 'Left') {
        report(context.stderr, outcome.left)
        return
      }
      printResult(context.stdout, context.stderr, plan, outcome.right)
    } catch (error) {
      report(context.stderr, error)
    }
  }

  const runOnce = async (): Promise<void> => {
    if (running) {
      queued = true
      return
    }
    running = true
    try {
      let plan: ProfilePlan
      try {
        plan = await (context.deps.loadConfig ?? loadConfig)(context.configPath)
      } catch (error) {
        report(context.stderr, error)
        return
      }
      await runWith(plan)
    } finally {
      running = false
      if (queued) {
        queued = false
        void runOnce()
      }
    }
  }

  await runWith(context.plan)
  const dir = dirname(context.configPath)
  const onChange = () => {
    void runOnce()
  }
  const session =
    context.deps.watch === undefined
      ? await watchConfigDirectory({ dir, onChange })
      : await context.deps.watch(dir, onChange)
  await waitForStop(context.deps.signal)
  await session.close()
  await runtime.dispose()
  return EXIT_OK
}

async function runCommand(context: CommandContext): Promise<number> {
  if (!context.parsed.noSync) {
    const outcome = await syncOnce(context)
    if (!outcome.ok) return EXIT_FAILURE
  }
  let binPath: string
  try {
    binPath = resolveDshInstallation().binPath
  } catch (error) {
    report(context.stderr, error)
    return EXIT_FAILURE
  }
  const spawnFn: SpawnLike = context.deps.spawn ?? defaultSpawn
  return await new Promise<number>((resolveExit) => {
    const child = spawnFn(
      process.execPath,
      [binPath, '--profile', context.plan.profile.name, ...context.parsed.dshArgs],
      {
        cwd: context.cwd,
        env: context.env,
        stdio: 'inherit',
      },
    )
    child.on('exit', (code) => resolveExit(code ?? EXIT_FAILURE))
    child.on('error', (error) => {
      report(context.stderr, error)
      resolveExit(EXIT_FAILURE)
    })
  })
}

/**
 * Run the CLI.
 * @param argv - arguments after the executable and script.
 * @param deps - overridable dependencies.
 * @returns the process exit code.
 */
export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line))
  const stderr = deps.stderr ?? ((line: string) => console.error(line))
  const env = deps.env ?? process.env
  const cwd = deps.cwd ?? process.cwd()

  let parsed: ParsedCli
  try {
    parsed = parseCliArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`eedsh: ${error.message}`)
      stderr(USAGE)
      return EXIT_USAGE
    }
    throw error
  }
  if (parsed.command === 'help') {
    stdout(USAGE)
    return EXIT_OK
  }
  if (parsed.command === 'version') {
    stdout(cliVersion())
    return EXIT_OK
  }

  let configPath: string
  if (parsed.configPath === undefined) {
    const discovered = findConfigPath(cwd)
    if (discovered === undefined) {
      const rejected = findUnsupportedConfigPath(cwd)
      if (rejected !== undefined) {
        report(stderr, unsupportedConfigExtensionError(rejected))
        return EXIT_FAILURE
      }
      stderr(`eedsh: cannot find a config (${CONFIG_FILENAMES.join(', ')}) in ${cwd}`)
      return EXIT_FAILURE
    }
    configPath = discovered
  } else {
    configPath = resolve(cwd, parsed.configPath)
    try {
      assertSupportedConfigPath(configPath)
    } catch (error) {
      report(stderr, error)
      return EXIT_FAILURE
    }
  }

  if (parsed.command === 'check') {
    return runCheck({
      configPath,
      tscArgs: parsed.tscArgs,
      stdout,
      stderr,
      env,
      cwd,
      spawn: deps.spawn ?? defaultSpawn,
    })
  }

  let plan: ProfilePlan
  try {
    plan = await (deps.loadConfig ?? loadConfig)(configPath)
  } catch (error) {
    report(stderr, error)
    return EXIT_FAILURE
  }

  const context: CommandContext = { configPath, parsed, plan, stdout, stderr, env, cwd, deps }
  if (parsed.command === 'sync' && parsed.watch) return syncWatch(context)
  if (parsed.command === 'sync') {
    const outcome = await syncOnce(context)
    return outcome.ok ? EXIT_OK : EXIT_FAILURE
  }
  return runCommand(context)
}
