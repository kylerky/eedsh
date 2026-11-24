/**
 * The config REPL session. It owns evaluation bindings, the selected profile,
 * save-triggered reloads, preview resolution, and in-session publication.
 * Evaluation runs in one `node:vm` context so top-level declarations persist
 * between lines; input and prompting belong to the `Terminal` service.
 * Formatting lives here so the command, tests, and non-TTY runs share it.
 * @module @eedsh/cli/repl/session
 */
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import vm from 'node:vm'
import {
  type BundleQueryDescriptor,
  type ConfigProvenance,
  isPresetEntry,
  type QueryRoot,
  queryKey,
  type ResolutionTrace,
  type ResolvedBundle,
} from '@eedsh/config'
import { canonicalJson, type EedshConfig, type ProfilePlan } from '@eedsh/plan'
import { Cause, Effect, Exit, Fiber, Option, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'
import { asEedshError } from '../command/errors'
import { describeError } from '../command/report'
import type { ConfigLoadFailure, ConfigLoadOptions, LoadedConfig } from '../config'
import { type DoctorResult, doctor } from '../doctor'
import type { DiscoveredDshInstallation } from '../dsh'
import { resolveDshHome, validatedProfileDir } from '../internal/dsh-home'
import type { BundleResolverShape } from '../internal/effect/services'
import type { GenerationRecord } from '../materialize/generated-bundle'
import { classifyGenerationRecord, type GenerationLookup } from '../materialize/generation-record'
import { GENERATED_DIRNAME, GENERATED_MANIFEST_RELATIVE_PATH } from '../materialize/profile'
import { type ProfileManifestRead, readProfileManifest } from '../materialize/profile-manifest'
import { composePreflightLayers, type PreflightLayer, touchedRowIds } from '../preflight'
import { describeProfileSelection, selectProfile } from '../selection'
import type { SpawnLike } from '../spawn'
import type { PathEvent } from '../watch'
import {
  COMMAND_NAMES,
  type CompletionCatalogs,
  type CompletionResult,
  type CompletionRoot,
  complete as completeLine,
  filterCompletionHits,
} from './completion'
import { diffPlans, type PlanMap } from './diff'
import {
  cleanupPreviews,
  installPreviewWithPnpm,
  type PreparedPreview,
  PreviewError,
  type PreviewSpec,
  preparePreview,
  previewCacheRoot,
  removePreview,
} from './preview'
import {
  type CompositionSnapshot,
  ConfigView,
  PackageView,
  type ProfileSnapshot,
  type ProfileView,
  type PublishedSnapshot,
} from './views'

/** A loadable config failure. */
export type ReplConfigFailure = ConfigLoadFailure

/** A line sink. */
export type LineSink = (line: string) => void

/** One successful publication result, as the command's sync runner reports it. */
export interface SyncOutcome {
  readonly changed: boolean
  readonly generationId: string
  readonly restartRequired?: boolean
  readonly warnings?: readonly string[]
  readonly notices?: readonly string[]
}

/** A publication runner supplied by the command or a test. */
export type SyncPlan = (
  plan: ProfilePlan,
  provenance: ConfigProvenance | undefined,
) => Effect.Effect<SyncOutcome, unknown>

/** One preflight composition summary. */
export interface CompositionResult {
  readonly rowCount: number
  readonly warnings: readonly string[]
  readonly error?: string
  /** The composed entries in application order, when composition succeeded. */
  readonly entries?: readonly Record<string, unknown>[]
  /** Row id to the last layer or bundle that touched it. */
  readonly sources?: Readonly<Record<string, string>>
}

/** A composition runner supplied by the session or a test. */
export type ComposePlan = (
  plan: ProfilePlan,
  profileDir: string,
  provenance: ConfigProvenance | undefined,
  configDir: string,
) => Effect.Effect<CompositionResult, unknown>

/** The authoring package loaded from the config project. */
export interface AuthoringPackage {
  readonly module: Record<string, unknown>
  readonly packagePath: string
  readonly entryPath: string
  readonly version: string
}

/** Environment and stream seams for one session. */
export interface ReplSessionOptions {
  readonly configPath: string
  readonly profile?: string
  readonly sync?: boolean
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly stdout: LineSink
  readonly stderr: LineSink
  /** The file-system service for config, snapshot, and preview reads. */
  readonly fileSystem: FileSystem.FileSystem
  /** The child-process spawn seam the preview installer uses. */
  readonly spawner: SpawnLike
  /** The installation selected for the invocation. */
  readonly installation: DiscoveredDshInstallation
  /** The bundle resolver value, passed like the filesystem and spawner. */
  readonly resolver: BundleResolverShape
  /** The config loader the command binds to its service. */
  readonly loadConfig: (
    path: string,
    options: ConfigLoadOptions,
  ) => Effect.Effect<LoadedConfig, ReplConfigFailure>
  /** The config-directory watcher; the command supplies the invocation's service. */
  readonly watch: (dir: string) => Effect.Effect<Stream.Stream<PathEvent>, unknown, Scope.Scope>
  /** The preflight composition runner. */
  readonly compose: ComposePlan
  /** The publication runner; materialization runs in the invocation program. */
  readonly syncPlan: SyncPlan
  /** The preview installer seam. */
  readonly installPreview: (dir: string) => Effect.Effect<void, unknown>
  readonly cacheRoot?: string
  /** The clock seam for preview cleanup and markers. */
  readonly now: () => number
  readonly authoring?: AuthoringPackage
  readonly watchConfig?: boolean
  /** Read the published state of a profile; injectable for tests. */
  readonly doctor: (profileDir: string) => Effect.Effect<DoctorResult, unknown>
  /** Suppress the banner and composition summary for `--eval`. */
  readonly oneShot?: boolean
}

/** A structured session failure with printable diagnostic lines. */
export class ReplSessionError extends Error {
  readonly _tag = 'ReplSessionError'
  readonly code: string
  readonly lines: readonly string[]

  constructor(input: {
    readonly code: string
    readonly message: string
    readonly lines?: readonly string[]
  }) {
    super(input.message)
    this.name = 'ReplSessionError'
    this.code = input.code
    this.lines = input.lines ?? [input.message]
  }
}

/** The curated authoring factories bound into the prompt. */
const AUTHORING_BINDINGS = ['bundle', 'defineConfig', 'definePreset', 'group', 'js'] as const

/** The typed view names the prompt owns; an authoring export must not shadow one. */
const VIEW_BINDINGS = ['config', 'plan', 'selectedProfile'] as const

const HELP_LINES = [
  'bindings:',
  '  config                the loaded config view: defaultProfile, profiles()',
  '  selectedProfile       the selected profile view: name, plan(), bundles(), layers()',
  '  plan                  selectedProfile.plan()',
  'Tab completes commands, chain methods, and profile, bundle, row, and preset names;',
  '  press Tab again to list ambiguous matches',
  'commands:',
  '  .help                 list session and shell commands',
  '  .profile <name>       switch the selected profile without re-importing',
  '  .reload               re-evaluate the config now',
  '  .resolve <name>@<ver> prepare a session preview and evaluate against it',
  '  .sync [on|off]        publish now, or toggle continuous sync',
  '  .clear                clear the screen in a terminal',
  '  .exit                 end the session',
  'expressions accept erasable TypeScript (annotations) and top-level await; bindings persist',
]

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The evaluation surface the session binds names into and queries. */
interface ReplEvaluator {
  /** The value context; the session assigns its bindings here. */
  readonly context: Record<string, unknown>
  /**
   * Evaluate one line or script and resolve its value. TypeScript annotations
   * and a top-level `await` are accepted; a runtime failure rejects.
   * @param code - the expression or script to evaluate.
   * @returns the script's completion value, awaiting a top-level promise.
   */
  evaluate(code: string): Promise<unknown>
  /**
   * Complete a top-level identifier from the context and evaluated
   * declarations. Property paths are not resolved.
   * @param prefix - the text before the cursor.
   * @returns matching identifiers, sorted.
   */
  complete(prefix: string): readonly string[]
}

/** Inputs for {@link createEvaluator}. */
interface EvaluatorOptions {
  /** The directory `require` and `__dirname` resolve against. */
  readonly cwd?: string
}

/** Node's REPL exposes these ambient globals to evaluated scripts. */
const NODE_GLOBALS = [
  'AbortController',
  'AbortSignal',
  'Buffer',
  'TextDecoder',
  'TextEncoder',
  'URL',
  'URLSearchParams',
  'atob',
  'btoa',
  'clearImmediate',
  'clearInterval',
  'clearTimeout',
  'console',
  'crypto',
  'fetch',
  'navigator',
  'performance',
  'process',
  'queueMicrotask',
  'sessionStorage',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'structuredClone',
] as const

/** A top-level declaration whose identifier completion should remember. */
const TOP_LEVEL_DECLARATION =
  /(?:^|[\n;])\s*(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g

/** A JavaScript identifier. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** A syntax error that a top-level `await` explains. */
function isTopLevelAwait(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false
  return (
    error.message.includes('await is only valid') ||
    error.message.includes("Unexpected reserved word 'await'") ||
    error.message.includes("Unexpected token 'await'")
  )
}

/** Compile one script, or undefined when it is not syntactically valid. */
function compile(code: string): vm.Script | undefined {
  return Result.getOrUndefined(Result.try(() => new vm.Script(code, { filename: 'eedsh-repl' })))
}

/**
 * Strip TypeScript syntax, if the installed Node can. The experimental
 * warning is contained so a typed line does not print one; a source the
 * stripper rejects is evaluated unchanged, matching the previous REPL patch.
 * @param source - the source that did not compile as JavaScript.
 * @returns the stripped source, or undefined when stripping failed.
 */
function stripTypes(source: string): string | undefined {
  const emitWarning = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = warning instanceof Error ? warning.message : String(warning)
    if (message.includes('stripTypeScriptTypes')) return
    Reflect.apply(emitWarning, process, [warning, ...args])
  }) as typeof process.emitWarning
  const stripped = Result.try(() => stripTypeScriptTypes(source, { mode: 'strip' }))
  process.emitWarning = emitWarning
  return Result.getOrUndefined(stripped)
}

/** The top-level identifiers a script declares. */
function declaredNames(code: string): readonly string[] {
  const names: string[] = []
  for (const match of code.matchAll(TOP_LEVEL_DECLARATION)) {
    const name = match[1]
    if (name !== undefined) names.push(name)
  }
  return names
}

/**
 * Evaluate an awaited script. A single expression is run directly so its value
 * is returned; anything else runs as an async function body. Declarations made
 * inside the async body are local to that one evaluation.
 */
async function evaluateAwait(context: vm.Context, code: string): Promise<unknown> {
  const expression = `(async () => (\n${code.replace(/[\s;]+$/, '')}\n))()`
  const asExpression = compile(expression)
  if (asExpression !== undefined) return await asExpression.runInContext(context)
  const statements = new vm.Script(`(async () => {\n${code}\n})()`, {
    filename: 'eedsh-repl',
  })
  return await statements.runInContext(context)
}

/**
 * Create one evaluator over a fresh Node context.
 * @param options - the directory `require` resolves against.
 * @returns the context, evaluator, and identifier completion.
 */
function createEvaluator(options: EvaluatorOptions = {}): ReplEvaluator {
  const cwd = options.cwd ?? process.cwd()
  const hostGlobals = globalThis as unknown as Record<string, unknown>
  const sandbox: Record<string, unknown> = {}
  for (const name of NODE_GLOBALS) sandbox[name] = hostGlobals[name]
  const moduleShim: { exports: Record<string, unknown> } = { exports: {} }
  sandbox.__dirname = cwd
  sandbox.__filename = join(cwd, 'eedsh-repl.ts')
  sandbox.exports = moduleShim.exports
  sandbox.module = moduleShim
  sandbox.require = createRequire(join(cwd, 'eedsh-repl.cjs'))
  const context = vm.createContext(sandbox)
  const declared = new Set<string>()
  const builtins = new Set<string>()
  const names = Result.try(() => vm.runInContext('Object.getOwnPropertyNames(globalThis)', context))
  if (Result.isSuccess(names) && Array.isArray(names.success)) {
    for (const name of names.success) if (typeof name === 'string') builtins.add(name)
  }

  return {
    context: context as Record<string, unknown>,
    evaluate: async (source) => {
      let code = source
      let script = compile(source)
      if (script === undefined) {
        const stripped = stripTypes(source)
        if (stripped !== undefined && stripped !== source) {
          code = stripped
          script = compile(code)
        }
      }
      if (script === undefined) {
        // Recompile so the caller receives the real SyntaxError, not a
        // swallowed compile probe.
        const failure = Result.try(() => new vm.Script(code, { filename: 'eedsh-repl' }))
        if (Result.isFailure(failure)) {
          if (isTopLevelAwait(failure.failure)) return await evaluateAwait(context, code)
          return Promise.reject(failure.failure)
        }
        const value = failure.success.runInContext(context)
        for (const name of declaredNames(code)) declared.add(name)
        return value
      }
      const value = script.runInContext(context)
      for (const name of declaredNames(code)) declared.add(name)
      return value
    },
    complete: (prefix) => {
      const names = new Set<string>(builtins)
      for (const name of Object.getOwnPropertyNames(context)) names.add(name)
      for (const name of declared) names.add(name)
      return [...names].filter((name) => IDENTIFIER.test(name) && name.startsWith(prefix)).sort()
    },
  }
}

/** Whether a path exists; an inspection failure counts as missing. */
function pathExists(fileSystem: FileSystem.FileSystem, path: string): Effect.Effect<boolean> {
  return fileSystem.exists(path).pipe(
    Effect.result,
    Effect.map((checked) => (Result.isSuccess(checked) ? checked.success : false)),
  )
}

/** Render a caught value with the CLI's one diagnostic vocabulary. */
function errorLines(error: unknown): string[] {
  return describeError(asEedshError(error))
}

function planMap(config: EedshConfig): PlanMap {
  const map = new Map<string, ProfilePlan | undefined>()
  for (const [name, result] of Object.entries(config.profiles)) {
    map.set(name, Result.isSuccess(result) ? result.success : undefined)
  }
  return map
}

function selectedPlan(
  config: EedshConfig,
  profile: string | undefined,
): Result.Result<{ readonly name: string; readonly plan: ProfilePlan }, ReplSessionError> {
  const selection = selectProfile(
    config,
    profile === undefined ? Option.none() : Option.some(profile),
  )
  if (Result.isFailure(selection)) {
    const message = describeProfileSelection(selection.failure)
    return Result.fail(
      new ReplSessionError({
        code: 'repl.profile_selection',
        message,
        lines: [message],
      }),
    )
  }
  if (Result.isFailure(selection.success.plan)) {
    return Result.fail(
      new ReplSessionError({
        code: 'repl.invalid_profile',
        message: `profile ${JSON.stringify(selection.success.name)} is invalid`,
        lines: [
          `profile ${JSON.stringify(selection.success.name)} is invalid`,
          ...selection.success.plan.failure.message.split('\n'),
        ],
      }),
    )
  }
  return Result.succeed({ name: selection.success.name, plan: selection.success.plan.success })
}

function declaresAuthoring(
  fileSystem: FileSystem.FileSystem,
  configDir: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    let dir = configDir
    while (true) {
      const manifestPath = join(dir, 'package.json')
      if (yield* pathExists(fileSystem, manifestPath)) {
        const content = yield* Effect.result(fileSystem.readFileString(manifestPath))
        if (Result.isSuccess(content)) {
          const manifest = Result.getOrUndefined(
            Result.try(() => JSON.parse(content.success) as Record<string, unknown>),
          )
          if (manifest !== undefined) {
            for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
              const value = manifest[section]
              if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                if (Object.hasOwn(value, '@eedsh/config')) return true
              }
            }
          }
        }
      }
      const parent = dirname(dir)
      if (parent === dir) return false
      dir = parent
    }
  })
}

function authoringPackage(
  fileSystem: FileSystem.FileSystem,
  configPath: string,
): Effect.Effect<AuthoringPackage, ReplSessionError> {
  return Effect.gen(function* () {
    const configDir = dirname(configPath)
    const require = createRequire(join(configDir, 'package.json'))
    const localPackage = join(configDir, 'node_modules', '@eedsh', 'config', 'package.json')
    if (
      !(yield* pathExists(fileSystem, localPackage)) &&
      !(yield* declaresAuthoring(fileSystem, configDir))
    ) {
      return yield* Effect.fail(
        new ReplSessionError({
          code: 'repl.authoring_package_missing',
          message: `the config project at ${configDir} has not installed @eedsh/config (no node_modules/@eedsh/config and no declaring package.json)`,
        }),
      )
    }
    const resolved = Result.try(() => ({
      packagePath: require.resolve('@eedsh/config/package.json'),
      entryPath: require.resolve('@eedsh/config'),
    }))
    if (Result.isFailure(resolved)) {
      return yield* Effect.fail(
        new ReplSessionError({
          code: 'repl.authoring_package_missing',
          message: `the config project at ${configDir} has not installed @eedsh/config: ${messageOf(resolved.failure)}`,
        }),
      )
    }
    let version = 'unknown'
    const content = yield* Effect.result(fileSystem.readFileString(resolved.success.packagePath))
    if (Result.isSuccess(content)) {
      const manifest = Result.getOrUndefined(
        Result.try(() => JSON.parse(content.success) as { version?: unknown }),
      )
      if (manifest !== undefined && typeof manifest.version === 'string') version = manifest.version
    }
    return {
      module: {},
      packagePath: resolved.success.packagePath,
      entryPath: resolved.success.entryPath,
      version,
    }
  })
}

function loadAuthoringModule(
  packageInfo: AuthoringPackage,
): Effect.Effect<Record<string, unknown>, ReplSessionError> {
  return Effect.tryPromise({
    try: () =>
      import(pathToFileURL(packageInfo.entryPath).href) as Promise<Record<string, unknown>>,
    catch: (cause) =>
      new ReplSessionError({
        code: 'repl.authoring_package_unloadable',
        message: `cannot import the config project's @eedsh/config at ${packageInfo.entryPath}: ${messageOf(cause)}`,
      }),
  })
}

function profileDirectory(name: string, env: Record<string, string | undefined>): string {
  return validatedProfileDir(name, resolveDshHome(undefined, env))
}

/** One generated preflight layer per plan group, with recorded provenance. */
function generatedPreflightLayers(
  plan: ProfilePlan,
  provenance: ConfigProvenance | undefined,
): PreflightLayer[] {
  const groups = provenance?.profiles[plan.profile.name] ?? []
  return plan.layers.map((layer, index) => {
    const recorded = groups[index]
    return {
      label: `generated #${index + 1}`,
      patches: layer.patches as Record<string, unknown>[],
      generated: {
        position: index + 1,
        label: recorded?.label,
        sites: recorded?.sites ?? [],
      },
    }
  })
}

/** The last-touch source of one patched row: site, then group position, then bundle. */
function sourceOf(layer: PreflightLayer, offset: number, configDir: string): string {
  const group = layer.generated
  if (group === undefined) return layer.label
  const site = group.sites[offset]
  if (site !== undefined) return `${relative(configDir, site.file)}:${site.line}:${site.column}`
  return `generated #${group.position}`
}

/** The default composition runner, over the invocation's resolver. */
function defaultCompose(
  plan: ProfilePlan,
  profileDir: string,
  installation: DiscoveredDshInstallation,
  provenance: ConfigProvenance | undefined,
  configDir: string,
  resolver: BundleResolverShape,
): Effect.Effect<CompositionResult> {
  return Effect.gen(function* () {
    const loaded = yield* Effect.result(resolver.loadBridge(installation))
    if (Result.isFailure(loaded)) {
      return { rowCount: 0, warnings: [], error: loaded.failure.message }
    }
    const installAnchor = installation.installAnchor
    const layers: PreflightLayer[] = []
    let generatedPlaced = false
    for (const item of plan.bundles) {
      if (item.kind === 'generated') {
        layers.push(...generatedPreflightLayers(plan, provenance))
        generatedPlaced = true
        continue
      }
      const resolved = yield* Effect.result(
        resolver.resolveBundlePatches(item.name, profileDir, installAnchor),
      )
      if (Result.isFailure(resolved)) {
        return {
          rowCount: 0,
          warnings: [],
          error: `cannot resolve bundle ${JSON.stringify(item.name)}: ${messageOf(resolved.failure)} `,
        }
      }
      layers.push({ label: `bundle:${item.name}`, patches: [...resolved.success] })
    }
    if (!generatedPlaced) layers.push(...generatedPreflightLayers(plan, provenance))
    const compose = yield* Effect.result(resolver.composeEntries(installAnchor))
    if (Result.isFailure(compose)) {
      return { rowCount: 0, warnings: [], error: compose.failure.message }
    }
    const sources: Record<string, string> = {}
    for (const layer of layers) {
      for (const [offset, patch] of layer.patches.entries()) {
        const source = sourceOf(layer, offset, configDir)
        for (const id of touchedRowIds([patch])) sources[id] = source
      }
    }
    const composition = composePreflightLayers(layers, compose.success)
    const warnings = [...composition.warnings]
    if (composition.duplicateInsertIds.length > 0) {
      warnings.push(`duplicate inserted row ids: ${composition.duplicateInsertIds.join(', ')}`)
    }
    return {
      rowCount: composition.entries.length,
      warnings,
      entries: composition.entries,
      sources,
    }
  })
}

/** Build the real composition runner for one installation and resolver. */
export function composeFor(
  installation: DiscoveredDshInstallation,
  resolver: BundleResolverShape,
): ComposePlan {
  return (plan, profileDir, provenance, configDir) =>
    defaultCompose(plan, profileDir, installation, provenance, configDir, resolver)
}

/** Build the real doctor runner for one environment and file system. */
export function doctorFor(
  env: Record<string, string | undefined>,
  fileSystem: FileSystem.FileSystem,
): (profileDir: string) => Effect.Effect<DoctorResult> {
  return (profileDir) =>
    doctor({ profileDir, dshHome: resolveDshHome(undefined, env) }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    )
}

/** Build the real preview installer over the child-process seam. */
export function installPreviewFor(
  spawner: SpawnLike,
): (dir: string) => Effect.Effect<void, unknown> {
  return (dir) => installPreviewWithPnpm(dir, spawner)
}

/** One interactive config session. Construct with {@link ReplSession.create}. */
export class ReplSession {
  readonly configPath: string
  readonly configDir: string
  readonly stdout: LineSink
  readonly stderr: LineSink
  readonly authoring: AuthoringPackage

  private readonly options: ReplSessionOptions
  private readonly fileSystem: FileSystem.FileSystem
  private readonly spawner: SpawnLike
  private readonly installation: DiscoveredDshInstallation
  private readonly resolver: BundleResolverShape
  private readonly env: Record<string, string | undefined>
  private readonly previousOverride: string | undefined
  private readonly loadConfig: ReplSessionOptions['loadConfig']
  private readonly compose: ComposePlan
  private readonly runDoctor: ReplSessionOptions['doctor']
  private readonly syncPlan: SyncPlan
  private readonly installPreview: ReplSessionOptions['installPreview']
  private readonly cacheRoot: string
  private readonly now: () => number
  private readonly reloadSemaphore: Semaphore.Semaphore
  private evaluator!: ReplEvaluator
  private evaluateRaw!: (code: string) => Promise<unknown>
  private config!: EedshConfig
  private plan!: ProfilePlan
  private provenance: ConfigProvenance | undefined
  private resolutionBundles: readonly ResolvedBundle[] = []
  private queries: readonly BundleQueryDescriptor[] = []
  private completionBundles = new Map<string, ResolvedBundle>()
  private profileName!: string
  private configView!: ConfigView
  private selectedProfileView!: ProfileView
  private syncEnabled: boolean
  private preview: PreparedPreview | undefined
  private previewSpecs: PreviewSpec[] = []
  private retainedPreviewDir: string | undefined
  private pausedFingerprint: string | undefined
  private watcherFiber: Fiber.Fiber<void> | undefined
  private watcherScope: Scope.Closeable | undefined
  private evaluationNonce = 0
  private catalogVersion = 0
  private catalogCache:
    | { readonly version: number; readonly catalogs: CompletionCatalogs }
    | undefined

  private constructor(options: ReplSessionOptions, authoring: AuthoringPackage) {
    this.options = options
    this.configPath = options.configPath
    this.configDir = dirname(options.configPath)
    this.stdout = options.stdout
    this.stderr = options.stderr
    this.env = options.env ?? process.env
    this.fileSystem = options.fileSystem
    this.spawner = options.spawner
    this.installation = options.installation
    this.resolver = options.resolver
    this.authoring = authoring
    this.loadConfig = options.loadConfig
    this.runDoctor = options.doctor
    this.syncPlan = options.syncPlan
    this.installPreview = options.installPreview
    this.cacheRoot = options.cacheRoot ?? previewCacheRoot(this.env)
    this.now = options.now
    this.syncEnabled = options.sync === true
    this.compose = options.compose
    this.previousOverride = process.env.EEDSH_PROFILE_ROOT_OVERRIDE
    this.reloadSemaphore = Semaphore.makeUnsafe(1)
  }

  /**
   * Resolve the config project's authoring package and start a session.
   * @param options - config path, profile, streams, and seams.
   * @returns the initialized session, or a structured failure.
   */
  static create(
    options: ReplSessionOptions,
  ): Effect.Effect<ReplSession, ReplSessionError | ReplConfigFailure> {
    return Effect.gen(function* () {
      let authoring = options.authoring
      if (authoring === undefined) {
        const info = yield* authoringPackage(options.fileSystem, options.configPath)
        authoring = { ...info, module: yield* loadAuthoringModule(info) }
      }
      const session = new ReplSession(options, authoring)
      const initialized = yield* Effect.exit(session.initialize())
      if (Exit.isFailure(initialized)) {
        yield* session.close()
        return yield* Effect.failCause(initialized.cause)
      }
      return session
    })
  }

  /** The selected profile's validated plan. */
  get currentPlan(): ProfilePlan {
    return this.plan
  }

  /** The selected profile name. */
  get profile(): string {
    return this.profileName
  }

  /** Whether continuous sync is enabled. */
  get continuousSync(): boolean {
    return this.syncEnabled
  }

  /** Whether a session preview is active. */
  get previewActive(): boolean {
    return this.preview !== undefined
  }

  private initialize(): Effect.Effect<void, ReplSessionError | ReplConfigFailure> {
    const self = this
    return Effect.gen(function* () {
      self.evaluator = createEvaluator({ cwd: self.configDir })
      self.evaluateRaw = self.evaluator.evaluate
      if (self.options.oneShot !== true) {
        self.stdout(
          `eedsh repl (profile selection: ${self.options.profile === undefined ? 'config default' : JSON.stringify(self.options.profile)}; sync: ${self.syncEnabled ? 'on' : 'off'})`,
        )
        self.stdout(`config: ${self.configPath}`)
        self.stdout(`authoring: ${self.authoring.entryPath} (${self.authoring.version})`)
        self.stdout('bindings: config, selectedProfile, plan')
        self.stdout(
          'commands: .profile <name>, .help, .resolve, .sync, .reload; Tab completes commands and names (a second Tab lists ambiguous matches)',
        )
        if (self.options.cacheRoot === undefined) {
          yield* Effect.exit(cleanupPreviews(self.cacheRoot, self.fileSystem, { now: self.now }))
        }
      }
      yield* self.loadAndSelect()
      if (self.options.watchConfig !== false) yield* self.startWatching()
    })
  }

  private bind(): Result.Result<void, ReplSessionError> {
    const context = this.evaluator.context
    for (const name of VIEW_BINDINGS) {
      if (Object.hasOwn(this.authoring.module, name)) {
        return Result.fail(
          new ReplSessionError({
            code: 'repl.binding_collision',
            message: `the config project's @eedsh/config exports "${name}", which collides with the session binding "${name}"`,
          }),
        )
      }
    }
    const plan = this.selectedProfileView.plan()
    if (plan === undefined) {
      return Result.fail(
        new ReplSessionError({
          code: 'repl.profile_selection',
          message: `profile ${JSON.stringify(this.profileName)} is invalid`,
        }),
      )
    }
    const bindings: Record<string, unknown> = {}
    for (const name of AUTHORING_BINDINGS) {
      if (Object.hasOwn(this.authoring.module, name)) bindings[name] = this.authoring.module[name]
    }
    Object.assign(context, bindings, {
      config: this.configView,
      selectedProfile: this.selectedProfileView,
      plan,
    })
    return Result.succeed(undefined)
  }

  private applySelection(
    config: EedshConfig,
    plan: ProfilePlan,
    name: string,
    provenance: ConfigProvenance | undefined,
    resolutionBundles: readonly ResolvedBundle[] = [],
    queries: readonly BundleQueryDescriptor[] = [],
  ): Effect.Effect<void, ReplSessionError> {
    const self = this
    return Effect.gen(function* () {
      self.config = config
      self.plan = plan
      self.profileName = name
      self.provenance = provenance
      self.resolutionBundles = resolutionBundles
      self.queries = queries
      self.completionBundles = new Map(
        queries.flatMap((descriptor) => {
          const resolved = resolutionBundles.find(
            (item) =>
              item.bundle === descriptor.bundle &&
              queryKey(item.bundle, item.root) === queryKey(descriptor.bundle, descriptor.root),
          )
          return resolved === undefined
            ? []
            : ([[queryKey(descriptor.bundle, descriptor.root), resolved]] as const)
        }),
      )
      yield* self.refreshViews()
    })
  }

  private refreshViews(): Effect.Effect<void, ReplSessionError> {
    const self = this
    return Effect.gen(function* () {
      const snapshots = yield* self.buildSnapshots(
        self.config,
        self.resolutionBundles,
        self.queries,
      )
      self.configView = new ConfigView(self.config, snapshots)
      const selected = self.configView.profile(self.profileName)
      if (selected === undefined) {
        return yield* Effect.fail(
          new ReplSessionError({
            code: 'repl.profile_selection',
            message: `profile ${JSON.stringify(self.profileName)} is not declared`,
          }),
        )
      }
      self.selectedProfileView = selected
      self.invalidateCatalogs()
    })
  }

  private buildSnapshots(
    config: EedshConfig,
    resolutionBundles: readonly ResolvedBundle[],
    queries: readonly BundleQueryDescriptor[],
  ): Effect.Effect<ReadonlyMap<string, ProfileSnapshot>> {
    const self = this
    return Effect.gen(function* () {
      const snapshots = new Map<string, ProfileSnapshot>()
      for (const [name, result] of Object.entries(config.profiles)) {
        const profileDir =
          name === self.profileName ? self.effectiveProfileDir() : profileDirectory(name, self.env)
        const plan = Result.isSuccess(result) ? result.success : undefined
        let composition: CompositionSnapshot | undefined
        if (plan !== undefined) {
          const composed = yield* Effect.exit(
            Effect.suspend(() => self.compose(plan, profileDir, self.provenance, self.configDir)),
          )
          composition = Exit.isSuccess(composed)
            ? {
                rowCount: composed.value.rowCount,
                entries: composed.value.entries ?? [],
                sources: composed.value.sources ?? {},
                warnings: composed.value.warnings,
                error: composed.value.error,
              }
            : {
                rowCount: 0,
                entries: [],
                sources: {},
                warnings: [],
                error: messageOf(Cause.squash(composed.cause)),
              }
        }
        const resolvedBundles = yield* self.resolveProfileBundles(
          name,
          plan,
          resolutionBundles,
          queries,
        )
        const published = yield* self.publishedSnapshot(profileDir)
        const packages = yield* PackageView.read(
          plan,
          profileDir,
          published.manifest,
          self.fileSystem,
        )
        snapshots.set(name, { profileDir, composition, published, packages, resolvedBundles })
      }
      return snapshots
    })
  }

  /** Resolve every bundle selection one profile view exposes. */
  private resolveProfileBundles(
    profile: string,
    plan: ProfilePlan | undefined,
    resolutionBundles: readonly ResolvedBundle[],
    queries: readonly BundleQueryDescriptor[],
  ): Effect.Effect<ReadonlyMap<string, ResolvedBundle>> {
    const self = this
    return Effect.gen(function* () {
      const resolved = new Map<string, ResolvedBundle>()
      for (const descriptor of queries) {
        if (descriptor.root.profile !== profile) continue
        const item = resolutionBundles.find(
          (candidate) =>
            candidate.bundle === descriptor.bundle &&
            queryKey(candidate.bundle, candidate.root) ===
              queryKey(descriptor.bundle, descriptor.root),
        )
        if (item !== undefined && !resolved.has(item.bundle)) resolved.set(item.bundle, item)
      }
      for (const selection of plan?.bundles ?? []) {
        if (selection.kind !== 'bundle' || resolved.has(selection.name)) continue
        const queried = yield* Effect.result(
          self.resolver.resolveQuery({
            bundle: selection.name,
            root: { profile },
            installation: self.installation,
            configDir: self.configDir,
            env: self.env,
          }),
        )
        if (Result.isSuccess(queried)) resolved.set(selection.name, queried.success)
      }
      return resolved
    })
  }

  private readJson(path: string): Effect.Effect<unknown | undefined> {
    const self = this
    return Effect.gen(function* () {
      if (!(yield* pathExists(self.fileSystem, path))) return undefined
      const content = yield* Effect.result(self.fileSystem.readFileString(path))
      if (Result.isFailure(content)) return undefined
      return Result.getOrUndefined(Result.try(() => JSON.parse(content.success) as unknown))
    })
  }

  /** The profile manifest's classification, or undefined when it cannot be read. */
  private profileManifestRead(profileDir: string): Effect.Effect<ProfileManifestRead | undefined> {
    const self = this
    return Effect.gen(function* () {
      if (profileDir === '') return undefined
      const read = yield* Effect.result(
        readProfileManifest(join(profileDir, 'package.json'), self.fileSystem),
      )
      return Result.isSuccess(read) ? read.success : undefined
    })
  }

  private readJsonRecord(path: string): Effect.Effect<Record<string, unknown> | undefined> {
    const self = this
    return Effect.gen(function* () {
      const parsed = yield* self.readJson(path)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined
    })
  }

  /**
   * Read one profile's generation record and authoritative plan. A record that
   * cannot be read or classified contributes no generation.
   */
  private readGeneration(profileDir: string): Effect.Effect<{
    readonly generation: GenerationLookup | undefined
    readonly record: GenerationRecord | undefined
    readonly plan: unknown
    readonly planPath: string | undefined
  }> {
    const self = this
    return Effect.gen(function* () {
      const recordPath = join(profileDir, GENERATED_MANIFEST_RELATIVE_PATH)
      if (!(yield* pathExists(self.fileSystem, recordPath))) {
        return { generation: undefined, record: undefined, plan: undefined, planPath: undefined }
      }
      const parsed = yield* self.readJson(recordPath)
      if (parsed === undefined) {
        return { generation: undefined, record: undefined, plan: undefined, planPath: undefined }
      }
      const generation = Result.getOrUndefined(
        Result.try(() => classifyGenerationRecord(parsed, recordPath)),
      )
      if (generation === undefined || generation._tag !== 'valid') {
        return { generation, record: undefined, plan: undefined, planPath: undefined }
      }
      const record = generation.record
      const planPath = join(profileDir, GENERATED_DIRNAME, 'plans', `${record.generationId}.json`)
      const plan = (yield* pathExists(self.fileSystem, planPath))
        ? yield* self.readJson(planPath)
        : undefined
      return { generation, record, plan, planPath }
    })
  }

  private publishedSnapshot(profileDir: string): Effect.Effect<PublishedSnapshot> {
    const self = this
    return Effect.gen(function* () {
      const exists = profileDir !== '' && (yield* pathExists(self.fileSystem, profileDir))
      const manifest = exists ? yield* self.profileManifestRead(profileDir) : undefined
      const generation = exists
        ? yield* self.readGeneration(profileDir)
        : { generation: undefined, record: undefined, plan: undefined, planPath: undefined }
      const findings = yield* self.doctorResult(profileDir)
      return {
        dir: profileDir,
        exists,
        manifest,
        generation: generation.generation,
        record: generation.record,
        plan: generation.plan,
        planPath: generation.planPath,
        findings: findings.findings,
        errors: findings.errors,
        warnings: findings.warnings,
      }
    })
  }

  private doctorResult(profileDir: string): Effect.Effect<DoctorResult> {
    const self = this
    return Effect.gen(function* () {
      if (profileDir === '') return { findings: [], errors: 0, warnings: 0 }
      const findings = yield* Effect.exit(Effect.suspend(() => self.runDoctor(profileDir)))
      return Exit.isSuccess(findings) ? findings.value : { findings: [], errors: 0, warnings: 0 }
    })
  }

  private invalidateCatalogs(): void {
    this.catalogVersion += 1
  }

  private completionCatalogs(): Effect.Effect<CompletionCatalogs> {
    const self = this
    return Effect.gen(function* () {
      if (self.catalogCache?.version === self.catalogVersion) return self.catalogCache.catalogs
      const catalogs: CompletionCatalogs = {
        commands: COMMAND_NAMES,
        profiles: self.configView?.profiles().map((profile) => profile.name) ?? [],
        bundles: yield* self.catalogBundles(),
        packages: yield* self.catalogPackages(),
        rows: (bundle, root) => self.catalogRows(bundle, root),
        presets: (bundle, root) => self.catalogPresets(bundle, root),
      }
      self.catalogCache = { version: self.catalogVersion, catalogs }
      return catalogs
    })
  }

  private catalogRows(bundle: string, root: CompletionRoot): readonly string[] {
    const resolved = this.completionBundles.get(queryKey(bundle, root))
    if (resolved === undefined) return []
    const ids: string[] = []
    const seen = new Set<string>()
    for (const row of resolved.rows) {
      const id = typeof row.id === 'string' ? row.id : ''
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    return ids
  }

  private catalogPresets(bundle: string, root: CompletionRoot): readonly string[] {
    const resolved = this.completionBundles.get(queryKey(bundle, root))
    if (resolved === undefined) return []
    const ids: string[] = []
    const seen = new Set<string>()
    for (const row of resolved.rows) {
      if (!isPresetEntry(row)) continue
      const config = row.config
      const id =
        config !== null && typeof config === 'object' && !Array.isArray(config)
          ? (config as Record<string, unknown>).id
          : undefined
      if (typeof id !== 'string' || id === '' || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    return ids
  }

  /** Resolve the bundle a completion line names, so its row and preset catalogs are available. */
  private prefetchCompletion(line: string): Effect.Effect<void> {
    const self = this
    return Effect.gen(function* () {
      const bundle = /bundle\(\s*(['"])(.*?)\1\s*\)/.exec(line)?.[2]
      if (bundle === undefined) return
      const profile = /\.fromProfile\(\s*(['"])(.*?)\1\s*\)/.exec(line)?.[2]
      const packageDir = /\.fromPackageDir\(\s*(['"])(.*?)\1\s*\)/.exec(line)?.[2]
      const root: QueryRoot =
        profile !== undefined ? { profile } : packageDir !== undefined ? { packageDir } : {}
      const key = queryKey(bundle, root)
      if (self.completionBundles.has(key)) return
      const resolved = yield* Effect.exit(
        Effect.suspend(() =>
          self.resolver.resolveQuery({
            bundle,
            root,
            installation: self.installation,
            configDir: self.configDir,
            env: self.env,
          }),
        ),
      )
      if (Exit.isSuccess(resolved)) self.completionBundles.set(key, resolved.value)
    })
  }

  private catalogBundles(): Effect.Effect<readonly string[]> {
    const self = this
    return Effect.gen(function* () {
      const names = new Set<string>()
      for (const item of self.plan?.bundles ?? []) {
        if (item.kind === 'bundle') names.add(item.name)
      }
      for (const name of yield* self.manifestBundles()) names.add(name)
      for (const name of yield* self.activeBundles()) names.add(name)
      for (const spec of self.previewSpecs) names.add(spec.name)
      return [...names].sort()
    })
  }

  private profileManifest(): Effect.Effect<ProfileManifestRead | undefined> {
    return this.profileManifestRead(this.effectiveProfileDir())
  }

  private manifestBundles(): Effect.Effect<readonly string[]> {
    const self = this
    return Effect.gen(function* () {
      const manifest = yield* self.profileManifest()
      return manifest !== undefined && manifest._tag === 'valid' ? [...manifest.bundles.names] : []
    })
  }

  private catalogPackages(): Effect.Effect<readonly string[]> {
    const self = this
    return Effect.gen(function* () {
      const names = new Set<string>(Object.keys(self.plan?.packages ?? {}))
      const manifest = yield* self.profileManifest()
      if (manifest !== undefined && manifest._tag === 'valid') {
        for (const section of [
          manifest.dependencies,
          manifest.devDependencies,
          manifest.optionalDependencies,
        ]) {
          for (const name of Object.keys(section.entries)) names.add(name)
        }
      }
      return [...names].sort()
    })
  }

  private activeBundles(): Effect.Effect<readonly string[]> {
    const self = this
    return Effect.gen(function* () {
      const anchor = self.installation.installAnchor
      const manifest = yield* self.readJsonRecord(anchor)
      if (manifest === undefined) return []
      const names: string[] = []
      for (const section of ['dependencies', 'optionalDependencies']) {
        const dependencies = manifest[section]
        if (
          dependencies === null ||
          typeof dependencies !== 'object' ||
          Array.isArray(dependencies)
        ) {
          continue
        }
        for (const name of Object.keys(dependencies)) {
          if (yield* self.declaresBundle(anchor, name)) names.push(name)
        }
      }
      return names
    })
  }

  private declaresBundle(anchor: string, name: string): Effect.Effect<boolean> {
    const self = this
    return Effect.gen(function* () {
      const path = Result.getOrUndefined(
        Result.try(() => createRequire(anchor).resolve(`${name}/package.json`)),
      )
      if (path === undefined) return false
      const manifest = yield* self.readJsonRecord(path)
      if (manifest === undefined) return false
      const dsh = manifest.dsh
      return dsh !== null && typeof dsh === 'object' && 'bundle' in dsh
    })
  }

  /**
   * Complete one line against the current evaluation's catalogs. A descriptor
   * the line names is resolved read-only first; a failure contributes no hits.
   * @param line - the text before the cursor.
   * @returns the token start and hits.
   */
  complete(line: string): Effect.Effect<CompletionResult> {
    const self = this
    return Effect.gen(function* () {
      yield* self.prefetchCompletion(line)
      const catalogs = yield* self.completionCatalogs()
      return completeLine({ line, cursor: line.length, catalogs })
    })
  }

  /**
   * Fall back to top-level identifier completion from the evaluator context.
   * @param line - the text before the cursor.
   * @returns the filtered hits and the completed-on token.
   */
  completeGeneric(line: string): Effect.Effect<readonly [string[], string]> {
    return Effect.map(
      Effect.sync(() => Result.try(() => filterCompletionHits(this.evaluator.complete(line)))),
      (hits) => (Result.isSuccess(hits) ? ([hits.success, line] as const) : ([[], line] as const)),
    )
  }

  private loadCandidate(): Effect.Effect<
    {
      config: EedshConfig
      plan: ProfilePlan
      name: string
      traces: readonly ResolutionTrace[]
      provenance: ConfigProvenance | undefined
      resolutionBundles: readonly ResolvedBundle[]
      queries: readonly BundleQueryDescriptor[]
    },
    ReplConfigFailure | ReplSessionError
  > {
    const self = this
    return Effect.gen(function* () {
      self.evaluationNonce += 1
      const loaded = yield* Effect.suspend(() =>
        self.loadConfig(self.configPath, {
          installation: self.installation,
          env: self.env,
          evaluationNonce: String(self.evaluationNonce),
        }),
      )
      const selected = yield* Effect.fromResult(selectedPlan(loaded.config, self.options.profile))
      return {
        config: loaded.config,
        plan: selected.plan,
        name: selected.name,
        traces: loaded.traces,
        provenance: loaded.provenance,
        resolutionBundles: loaded.resolution.bundles,
        queries: loaded.queries,
      }
    })
  }

  private loadAndSelect(): Effect.Effect<void, ReplConfigFailure | ReplSessionError> {
    const self = this
    return Effect.gen(function* () {
      const loaded = yield* self.loadCandidate()
      yield* self.applySelection(
        loaded.config,
        loaded.plan,
        loaded.name,
        loaded.provenance,
        loaded.resolutionBundles,
        loaded.queries,
      )
      yield* Effect.fromResult(self.bind())
      self.printTraces(loaded.traces)
      self.printComposition()
    })
  }

  private printTraces(traces: readonly ResolutionTrace[]): void {
    if (this.options.oneShot === true) return
    for (const trace of traces) {
      const source =
        trace.origin === 'preview'
          ? 'the session preview'
          : trace.origin === 'profile'
            ? `profile ${JSON.stringify(trace.profile ?? '')}`
            : trace.origin === 'packageDir'
              ? 'an explicit package directory'
              : 'the active installation'
      this.stdout(
        `resolved ${trace.bundle} from ${source} at ${trace.packageDir} (${trace.version})`,
      )
    }
  }

  private printComposition(): void {
    if (this.options.oneShot === true) return
    const composition = this.selectedProfileView.composition()
    if (composition.error !== undefined) {
      this.stderr(`composition unavailable: ${composition.error}`)
      return
    }
    const warnings = composition.warnings
    this.stdout(
      `composition: ${composition.rowCount} row${composition.rowCount === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
    )
    for (const warning of warnings) this.stderr(`preflight: ${warning}`)
  }

  private effectiveProfileDir(): string {
    return this.preview?.dir ?? profileDirectory(this.profileName, this.env)
  }

  private applyPreviewEnv(): void {
    const override =
      this.preview === undefined ? this.previousOverride : JSON.stringify(this.preview.override)
    if (override === undefined) delete process.env.EEDSH_PROFILE_ROOT_OVERRIDE
    else process.env.EEDSH_PROFILE_ROOT_OVERRIDE = override
    if (override === undefined) delete this.env.EEDSH_PROFILE_ROOT_OVERRIDE
    else this.env.EEDSH_PROFILE_ROOT_OVERRIDE = override
  }

  private clearPreviewEnv(): void {
    if (this.previousOverride === undefined) delete process.env.EEDSH_PROFILE_ROOT_OVERRIDE
    else process.env.EEDSH_PROFILE_ROOT_OVERRIDE = this.previousOverride
    if (this.previousOverride === undefined) delete this.env.EEDSH_PROFILE_ROOT_OVERRIDE
    else this.env.EEDSH_PROFILE_ROOT_OVERRIDE = this.previousOverride
  }

  private fingerprint(): string {
    return canonicalJson(this.plan)
  }

  /** Re-evaluate the config and report the diff against the last good plan. */
  reload(): Effect.Effect<void> {
    const self = this
    return Effect.gen(function* () {
      const previous = planMap(self.config)
      const previousFingerprint = self.fingerprint()
      const loaded = yield* Effect.exit(self.loadCandidate())
      if (Exit.isFailure(loaded)) {
        self.reportFailure('reload failed', Cause.squash(loaded.cause))
        return
      }
      const next = planMap(loaded.value.config)
      const diff = diffPlans(previous, next)
      if (diff.length === 0) self.stdout('reload: no changes')
      else for (const line of diff) self.stdout(line)
      const applied = yield* Effect.result(
        self.applySelection(
          loaded.value.config,
          loaded.value.plan,
          loaded.value.name,
          loaded.value.provenance,
          loaded.value.resolutionBundles,
          loaded.value.queries,
        ),
      )
      if (Result.isFailure(applied)) {
        self.reportFailure('reload failed', applied.failure)
        return
      }
      const bound = self.bind()
      if (Result.isFailure(bound)) {
        self.reportFailure('reload failed', bound.failure)
        return
      }
      self.printTraces(loaded.value.traces)
      self.printComposition()
      if (!self.syncEnabled) return
      const nextFingerprint = self.fingerprint()
      if (nextFingerprint === previousFingerprint) return
      if (self.pausedFingerprint === nextFingerprint) {
        self.stdout('sync: still paused after the previous failure; waiting for a changed save')
        return
      }
      yield* self.syncNow()
    })
  }

  /** Queue a reload so a burst of watcher callbacks cannot overlap evaluations. */
  private enqueueReload(): Effect.Effect<void> {
    return this.reloadSemaphore.withPermits(1)(this.reload())
  }

  private startWatching(): Effect.Effect<void, ReplSessionError> {
    const self = this
    return Effect.gen(function* () {
      const dir = self.configDir
      const scope = yield* Scope.make()
      const events = yield* Effect.exit(
        Effect.suspend(() => Effect.provideService(self.options.watch(dir), Scope.Scope, scope)),
      )
      if (Exit.isFailure(events)) {
        yield* Scope.close(scope, Exit.void)
        return yield* Effect.fail(
          new ReplSessionError({
            code: 'repl.watch_failed',
            message: `cannot watch ${dir}: ${messageOf(Cause.squash(events.cause))}`,
          }),
        )
      }
      self.watcherScope = scope
      const fiber = yield* events.value.pipe(
        Stream.debounce('150 millis'),
        Stream.runForEach(() => self.enqueueReload()),
        Effect.catchCause((cause) =>
          Effect.sync(() => self.reportFailure('watch failed', Cause.squash(cause))),
        ),
        Effect.forkIn(scope),
      )
      self.watcherFiber = fiber
    })
  }

  private reportFailure(prefix: string, error: unknown): void {
    const lines = errorLines(error)
    this.stderr(`${prefix}: ${lines[0] ?? messageOf(error)}`)
    for (const line of lines.slice(1)) this.stderr(line)
  }

  /** Evaluate one TypeScript expression. */
  async evaluate(code: string): Promise<unknown> {
    return await this.evaluateRaw(code)
  }

  /** Evaluate without rejecting, for prompt loops that must stay alive. */
  evaluateOutcome(
    code: string,
  ): Effect.Effect<
    { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }
  > {
    const self = this
    return Effect.gen(function* () {
      const evaluated = yield* Effect.exit(
        Effect.tryPromise({
          try: () => self.evaluate(code),
          catch: (error) => error,
        }),
      )
      if (Exit.isSuccess(evaluated)) return { ok: true, value: evaluated.value }
      return { ok: false, error: Cause.squash(evaluated.cause) }
    })
  }

  /** Print an evaluated value through the session sink. */
  printValue(value: unknown): void {
    this.stdout(inspect(value, { colors: false, depth: 6, breakLength: 100 }))
  }

  /** Run one dot command. Returns true when the session should exit. */
  command(line: string): Effect.Effect<boolean> {
    const self = this
    return Effect.gen(function* () {
      const trimmed = line.trim()
      const [word = '', ...args] = trimmed.split(/\s+/)
      switch (word) {
        case '.help':
          for (const help of HELP_LINES) self.stdout(help)
          return false
        case '.profile': {
          const name = args[0]
          if (args.length !== 1 || name === undefined) {
            self.stderr('usage: .profile <name>')
            return false
          }
          yield* self.switchProfile(name)
          return false
        }
        case '.reload':
          yield* self.enqueueReload()
          return false
        case '.exit':
          return true
        case '.clear':
          self.stdout('\u001b[2J\u001b[H')
          return false
        case '.resolve':
          if (args.length === 0) {
            self.stderr('usage: .resolve <name>@<exact-version>')
            return false
          }
          yield* self.resolve(args)
          return false
        case '.sync': {
          if (args.length === 0) {
            yield* self.syncNow()
            return false
          }
          if (args.length !== 1 || (args[0] !== 'on' && args[0] !== 'off')) {
            self.stderr('usage: .sync [on|off]')
            return false
          }
          self.syncEnabled = args[0] === 'on'
          self.pausedFingerprint = undefined
          self.stdout(`sync: ${self.syncEnabled ? 'on' : 'off'}`)
          return false
        }
        default:
          if (word.startsWith('.')) {
            self.stderr(`invalid command: ${word}; run .help to list commands`)
            return false
          }
          return false
      }
    })
  }

  private switchProfile(name: string): Effect.Effect<void> {
    const self = this
    return Effect.gen(function* () {
      const names = self.configView.profiles().map((profile) => profile.name)
      const view = self.configView.profile(name)
      if (view === undefined) {
        self.reportFailure(
          'profile not switched',
          new ReplSessionError({
            code: 'repl.unknown_profile',
            message: `profile ${JSON.stringify(name)} is not declared; available profiles: ${names.join(', ')}`,
          }),
        )
        return
      }
      if (!view.valid) {
        self.reportFailure(
          'profile not switched',
          new ReplSessionError({
            code: 'repl.invalid_profile',
            message: `profile ${JSON.stringify(name)} is invalid`,
            lines: [
              `profile ${JSON.stringify(name)} is invalid`,
              ...(view.error ?? '').split('\n'),
            ],
          }),
        )
        return
      }
      const plan = view.plan()
      if (plan === undefined) return
      self.plan = plan
      self.profileName = name
      const refreshed = yield* Effect.result(self.refreshViews())
      if (Result.isFailure(refreshed)) {
        self.reportFailure('profile not switched', refreshed.failure)
        return
      }
      const bound = self.bind()
      if (Result.isFailure(bound)) {
        self.reportFailure('profile not switched', bound.failure)
        return
      }
      self.stdout(`profile: ${name}`)
    })
  }

  private parseSpecs(raw: readonly string[]): Result.Result<PreviewSpec[], PreviewError> {
    const specs: PreviewSpec[] = []
    for (const value of raw) {
      const at = value.lastIndexOf('@')
      if (at <= 0) {
        return Result.fail(
          new PreviewError({
            code: 'preview.invalid_spec',
            message: `${JSON.stringify(value)} is not <name>@<exact-version>`,
          }),
        )
      }
      const name = value.slice(0, at)
      const version = value.slice(at + 1)
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
        return Result.fail(
          new PreviewError({
            code: 'preview.inexact_version',
            message: `${JSON.stringify(value)} must name an exact version, not ${JSON.stringify(version)}`,
          }),
        )
      }
      specs.push({ name, version })
    }
    return Result.succeed(specs)
  }

  /** Prepare a preview and re-evaluate the config against it. */
  resolve(rawSpecs: readonly string[]): Effect.Effect<void> {
    const self = this
    return Effect.gen(function* () {
      if (self.config === undefined) return
      const parsed = self.parseSpecs(rawSpecs)
      if (Result.isFailure(parsed)) {
        self.reportFailure('preview not ready', parsed.failure)
        return
      }
      let specs = parsed.success
      const profileDir = profileDirectory(self.profileName, self.env)
      const merged = new Map(self.previewSpecs.map((spec) => [spec.name, spec]))
      for (const spec of specs) merged.set(spec.name, spec)
      specs = [...merged.values()]
      const prepared = yield* Effect.exit(
        Effect.suspend(() =>
          preparePreview(
            {
              profileName: self.profileName,
              profileDir,
              dshVersion: self.installation.version,
              specs,
              env: self.env,
              ...(self.options.cacheRoot === undefined
                ? {}
                : { cacheRoot: self.options.cacheRoot }),
              install: self.installPreview,
              now: self.now,
            },
            { fileSystem: self.fileSystem, spawner: self.spawner },
          ),
        ),
      )
      if (Exit.isFailure(prepared)) {
        self.reportFailure('preview not ready', Cause.squash(prepared.cause))
        return
      }
      const previous = {
        preview: self.preview,
        specs: self.previewSpecs,
        config: self.config,
        plan: self.plan,
        profileName: self.profileName,
        provenance: self.provenance,
        resolutionBundles: self.resolutionBundles,
        queries: self.queries,
      }
      self.preview = prepared.value
      self.previewSpecs = [...specs]
      self.applyPreviewEnv()
      const applied = yield* Effect.exit(
        Effect.gen(function* () {
          const loaded = yield* self.loadCandidate()
          yield* self.applySelection(
            loaded.config,
            loaded.plan,
            loaded.name,
            loaded.provenance,
            loaded.resolutionBundles,
            loaded.queries,
          )
          yield* Effect.fromResult(self.bind())
          return loaded
        }),
      )
      if (Exit.isFailure(applied)) {
        self.preview = previous.preview
        self.previewSpecs = previous.specs
        yield* Effect.ignore(
          self.applySelection(
            previous.config,
            previous.plan,
            previous.profileName,
            previous.provenance,
            previous.resolutionBundles,
            previous.queries,
          ),
        )
        self.applyPreviewEnv()
        self.reportFailure('preview not ready', Cause.squash(applied.cause))
        return
      }
      self.stdout(
        `preview: ${specs.map((spec) => `${spec.name}@${spec.version}`).join(', ')} at ${prepared.value.dir}${prepared.value.reused ? ' (reused)' : ''}`,
      )
      self.stdout(
        `profile-root override: ${JSON.stringify({ [self.profileName]: prepared.value.dir })}`,
      )
      self.printTraces(applied.value.traces)
      self.printComposition()
    })
  }

  /** Publish the current evaluation, or report why publication did not happen. */
  syncNow(): Effect.Effect<SyncOutcome | undefined> {
    const self = this
    return Effect.gen(function* () {
      const plan = self.plan
      const published = yield* Effect.exit(
        Effect.gen(function* () {
          const outcome = yield* Effect.suspend(() => self.syncPlan(plan, self.provenance))
          for (const warning of outcome.warnings ?? []) self.stderr(`warning: ${warning}`)
          for (const notice of outcome.notices ?? []) self.stderr(notice)
          self.stdout(
            outcome.changed
              ? `published profile ${JSON.stringify(plan.profile.name)} (generation ${outcome.generationId.slice(0, 12)})`
              : `profile ${JSON.stringify(plan.profile.name)} is up to date (generation ${outcome.generationId.slice(0, 12)})`,
          )
          if (outcome.changed && outcome.restartRequired === true) {
            self.stdout('restart required: the published bundle or package set changed')
          }
          if (self.preview !== undefined && outcome.changed) yield* self.verifyPreview(plan)
          yield* self.refreshViews()
          yield* Effect.fromResult(self.bind())
          return outcome
        }),
      )
      if (Exit.isFailure(published)) {
        self.pausedFingerprint = self.fingerprint()
        self.reportFailure('sync failed', Cause.squash(published.cause))
        if (self.preview !== undefined) {
          self.stderr('preview: still active; fix the failure and run .sync again')
        }
        return undefined
      }
      self.pausedFingerprint = undefined
      return published.value
    })
  }

  private verifyPreview(published: ProfilePlan): Effect.Effect<void> {
    const self = this
    return Effect.gen(function* () {
      const preview = self.preview
      if (preview === undefined) return
      self.clearPreviewEnv()
      const verified = yield* Effect.exit(
        Effect.gen(function* () {
          const loaded = yield* self.loadCandidate()
          if (canonicalJson(loaded.plan) === canonicalJson(published)) {
            yield* removePreview(preview.dir, self.fileSystem)
            self.preview = undefined
            self.previewSpecs = []
            self.retainedPreviewDir = undefined
            yield* self.applySelection(
              loaded.config,
              loaded.plan,
              loaded.name,
              loaded.provenance,
              loaded.resolutionBundles,
              loaded.queries,
            )
            yield* Effect.fromResult(self.bind())
            self.stdout(
              'bootstrap complete: the real install reproduces the published plan; preview deleted',
            )
            return
          }
          self.preview = undefined
          self.previewSpecs = []
          self.retainedPreviewDir = preview.dir
          self.config = loaded.config
          self.plan = loaded.plan
          self.profileName = loaded.name
          self.provenance = loaded.provenance
          self.resolutionBundles = loaded.resolutionBundles
          self.queries = loaded.queries
          yield* Effect.fromResult(self.bind())
          self.stdout('preview divergence: the real install does not reproduce the published plan')
          self.stdout(
            `kept preview at ${preview.dir}; the real evaluation is active for the next .sync`,
          )
          self.printTraces(loaded.traces)
        }),
      )
      if (Exit.isFailure(verified)) {
        self.applyPreviewEnv()
        self.preview = preview
        self.reportFailure(
          'preview verification failed; preview kept',
          Cause.squash(verified.cause),
        )
      }
    })
  }

  /** Stop watching, close the evaluator, and restore the process environment. */
  close(): Effect.Effect<void> {
    const self = this
    return Effect.gen(function* () {
      if (self.watcherFiber !== undefined) {
        const fiber = self.watcherFiber
        self.watcherFiber = undefined
        yield* Fiber.interrupt(fiber)
      }
      if (self.watcherScope !== undefined) {
        const scope = self.watcherScope
        self.watcherScope = undefined
        yield* Scope.close(scope, Exit.void)
      }
      self.clearPreviewEnv()
      if (self.retainedPreviewDir !== undefined) {
        self.stdout(`preview retained at ${self.retainedPreviewDir}`)
        self.retainedPreviewDir = undefined
      }
    })
  }
}

/** Format an error for the interactive prompt without ending the session. */
export function formatSessionError(error: unknown): string[] {
  return errorLines(error)
}

/** Split an interactive input line into an optional dot command. */
export function isDotCommand(line: string): boolean {
  return line.trim().startsWith('.')
}
