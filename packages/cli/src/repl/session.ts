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
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Cause, Effect, Exit, Fiber, Option, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import * as Scope from 'effect/Scope'
import { asEedshError } from '../command/errors'
import { describeError } from '../command/report'
import {
  type ConfigLoadFailure,
  type ConfigLoadOptions,
  loadConfig as defaultLoadConfig,
  type LoadedConfig,
} from '../config'
import { type DoctorResult, doctor } from '../doctor'
import type { DiscoveredDshInstallation } from '../dsh'
import { resolveDshHome, resolveProfileDir } from '../internal/dsh-home'
import type { BundleResolverShape } from '../internal/effect/services'
import { BundleResolver } from '../internal/effect/services'
import type { GenerationRecord } from '../materialize/generated-bundle'
import { classifyGenerationRecord, type GenerationLookup } from '../materialize/generation-record'
import { GENERATED_DIRNAME, GENERATED_MANIFEST_RELATIVE_PATH } from '../materialize/profile'
import { composePreflightLayers, type PreflightLayer, touchedRowIds } from '../preflight'
import { describeProfileSelection, selectProfile } from '../selection'
import type { SpawnLike } from '../spawn'
import { type PathEvent, watchConfigDirectory } from '../watch'
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
) => Promise<SyncOutcome>

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
) => Promise<CompositionResult>

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
  readonly stdout?: LineSink
  readonly stderr?: LineSink
  /** The file-system service for config, snapshot, and preview reads. */
  readonly fileSystem: FileSystem.FileSystem
  /** The child-process spawn seam the preview installer uses. */
  readonly spawner: SpawnLike
  /** The installation selected for the invocation. */
  readonly installation: DiscoveredDshInstallation
  /** The bundle resolver value, passed like the filesystem and spawner. */
  readonly resolver: BundleResolverShape
  readonly loadConfig?: (
    path: string,
    options: ConfigLoadOptions,
  ) => Effect.Effect<LoadedConfig, ReplConfigFailure>
  /** The config-directory watcher; the command supplies the invocation's service. */
  readonly watch?: (dir: string) => Effect.Effect<Stream.Stream<PathEvent>, unknown, Scope.Scope>
  readonly compose?: ComposePlan
  readonly syncPlan?: SyncPlan
  readonly installPreview?: (dir: string) => Promise<void>
  readonly cacheRoot?: string
  readonly now?: () => number
  readonly authoring?: AuthoringPackage
  readonly watchConfig?: boolean
  /** Read the published state of a profile; injectable for tests. */
  readonly doctor?: (profileDir: string) => Promise<DoctorResult>
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
  try {
    return new vm.Script(code, { filename: 'eedsh-repl' })
  } catch {
    return undefined
  }
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
  try {
    return stripTypeScriptTypes(source, { mode: 'strip' })
  } catch {
    return undefined
  } finally {
    process.emitWarning = emitWarning
  }
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
  try {
    const names = vm.runInContext('Object.getOwnPropertyNames(globalThis)', context)
    if (Array.isArray(names)) {
      for (const name of names) if (typeof name === 'string') builtins.add(name)
    }
  } catch {
    // Completion degrades to the bindings assigned by the session.
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
        let error: unknown
        try {
          new vm.Script(code, { filename: 'eedsh-repl' })
        } catch (caught) {
          error = caught
        }
        if (isTopLevelAwait(error)) return await evaluateAwait(context, code)
        throw error
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
async function pathExists(fileSystem: FileSystem.FileSystem, path: string): Promise<boolean> {
  try {
    return await Effect.runPromise(fileSystem.exists(path))
  } catch {
    return false
  }
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
): { name: string; plan: ProfilePlan } {
  const selection = selectProfile(
    config,
    profile === undefined ? Option.none() : Option.some(profile),
  )
  if (Result.isFailure(selection)) {
    throw new ReplSessionError({
      code: 'repl.profile_selection',
      message: describeProfileSelection(selection.failure),
      lines: [describeProfileSelection(selection.failure)],
    })
  }
  if (Result.isFailure(selection.success.plan)) {
    throw new ReplSessionError({
      code: 'repl.invalid_profile',
      message: `profile ${JSON.stringify(selection.success.name)} is invalid`,
      lines: [
        `profile ${JSON.stringify(selection.success.name)} is invalid`,
        ...selection.success.plan.failure.message.split('\n'),
      ],
    })
  }
  return { name: selection.success.name, plan: selection.success.plan.success }
}

async function declaresAuthoring(
  fileSystem: FileSystem.FileSystem,
  configDir: string,
): Promise<boolean> {
  let dir = configDir
  while (true) {
    const manifestPath = join(dir, 'package.json')
    if (await pathExists(fileSystem, manifestPath)) {
      try {
        const manifest = JSON.parse(
          await Effect.runPromise(fileSystem.readFileString(manifestPath)),
        ) as Record<string, unknown>
        for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
          const value = manifest[section]
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            if (Object.hasOwn(value, '@eedsh/config')) return true
          }
        }
      } catch {
        // A malformed project manifest does not prove the dependency exists.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

async function authoringPackage(
  fileSystem: FileSystem.FileSystem,
  configPath: string,
): Promise<AuthoringPackage> {
  const configDir = dirname(configPath)
  const require = createRequire(join(configDir, 'package.json'))
  const localPackage = join(configDir, 'node_modules', '@eedsh', 'config', 'package.json')
  let packagePath: string
  let entryPath: string
  if (
    !(await pathExists(fileSystem, localPackage)) &&
    !(await declaresAuthoring(fileSystem, configDir))
  ) {
    throw new ReplSessionError({
      code: 'repl.authoring_package_missing',
      message: `the config project at ${configDir} has not installed @eedsh/config (no node_modules/@eedsh/config and no declaring package.json)`,
    })
  }
  try {
    packagePath = require.resolve('@eedsh/config/package.json')
    entryPath = require.resolve('@eedsh/config')
  } catch (cause) {
    throw new ReplSessionError({
      code: 'repl.authoring_package_missing',
      message: `the config project at ${configDir} has not installed @eedsh/config: ${messageOf(cause)}`,
    })
  }
  let version = 'unknown'
  try {
    const manifest = JSON.parse(
      await Effect.runPromise(fileSystem.readFileString(packagePath)),
    ) as { version?: unknown }
    if (typeof manifest.version === 'string') version = manifest.version
  } catch {
    // The package resolved; a missing version only weakens the banner.
  }
  return {
    module: {},
    packagePath,
    entryPath,
    version,
  }
}

async function loadAuthoringModule(
  packageInfo: AuthoringPackage,
): Promise<Record<string, unknown>> {
  try {
    return (await import(pathToFileURL(packageInfo.entryPath).href)) as Record<string, unknown>
  } catch (cause) {
    throw new ReplSessionError({
      code: 'repl.authoring_package_unloadable',
      message: `cannot import the config project's @eedsh/config at ${packageInfo.entryPath}: ${messageOf(cause)}`,
    })
  }
}

function profileDirectory(name: string, env: Record<string, string | undefined>): string {
  return resolveProfileDir(name, resolveDshHome(undefined, env))
}

async function defaultDoctor(
  profileDir: string,
  env: Record<string, string | undefined>,
): Promise<DoctorResult> {
  return await Effect.runPromise(
    doctor({ profileDir, dshHome: resolveDshHome(undefined, env) }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  )
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

async function defaultCompose(
  plan: ProfilePlan,
  profileDir: string,
  installation: DiscoveredDshInstallation,
  provenance: ConfigProvenance | undefined,
  configDir: string,
  resolver: BundleResolverShape,
): Promise<CompositionResult> {
  const loaded = await Effect.runPromise(Effect.result(resolver.loadBridge(installation)))
  if (loaded._tag === 'Failure') {
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
    const resolved = await Effect.runPromise(
      Effect.result(resolver.resolveBundlePatches(item.name, profileDir, installAnchor)),
    )
    if (resolved._tag === 'Failure') {
      return {
        rowCount: 0,
        warnings: [],
        error: `cannot resolve bundle ${JSON.stringify(item.name)}: ${messageOf(resolved.failure)} `,
      }
    }
    layers.push({ label: `bundle:${item.name}`, patches: [...resolved.success] })
  }
  if (!generatedPlaced) layers.push(...generatedPreflightLayers(plan, provenance))
  const compose = await Effect.runPromise(Effect.result(resolver.composeEntries(installAnchor)))
  if (compose._tag === 'Failure') {
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
  private readonly loadConfig: (
    path: string,
    options: ConfigLoadOptions,
  ) => Effect.Effect<LoadedConfig, ReplConfigFailure>
  private readonly compose: ComposePlan
  private readonly runDoctor: (profileDir: string) => Promise<DoctorResult>
  private readonly syncPlan: SyncPlan | undefined
  private readonly installPreview: ((dir: string) => Promise<void>) | undefined
  private readonly cacheRoot: string
  private readonly now: () => number
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
  private reloadQueue: Promise<void> = Promise.resolve()
  private evaluationNonce = 0
  private catalogVersion = 0
  private catalogCache:
    | { readonly version: number; readonly catalogs: CompletionCatalogs }
    | undefined

  private constructor(options: ReplSessionOptions, authoring: AuthoringPackage) {
    this.options = options
    this.configPath = options.configPath
    this.configDir = dirname(options.configPath)
    this.stdout = options.stdout ?? ((line) => console.log(line))
    this.stderr = options.stderr ?? ((line) => console.error(line))
    this.env = options.env ?? process.env
    this.fileSystem = options.fileSystem
    this.spawner = options.spawner
    this.installation = options.installation
    this.resolver = options.resolver
    this.authoring = authoring
    this.loadConfig =
      options.loadConfig ??
      ((path, loadOptions) =>
        defaultLoadConfig(path, loadOptions).pipe(
          Effect.provideService(FileSystem.FileSystem, this.fileSystem),
          Effect.provideService(BundleResolver, this.resolver),
        ))
    this.runDoctor = options.doctor ?? ((profileDir) => defaultDoctor(profileDir, this.env))
    this.syncPlan = options.syncPlan
    this.installPreview = options.installPreview
    this.cacheRoot = options.cacheRoot ?? previewCacheRoot(this.env)
    this.now = options.now ?? Date.now
    this.syncEnabled = options.sync === true
    this.compose =
      options.compose ??
      ((plan, profileDir, provenance, configDir) =>
        defaultCompose(plan, profileDir, this.installation, provenance, configDir, this.resolver))
    this.previousOverride = process.env.EEDSH_PROFILE_ROOT_OVERRIDE
  }

  /**
   * Resolve the config project's authoring package and start a session.
   * @param options - config path, profile, streams, and seams.
   * @returns the initialized session, or a structured failure.
   */
  static async create(options: ReplSessionOptions): Promise<ReplSession> {
    let authoring = options.authoring
    if (authoring === undefined) {
      const info = await authoringPackage(options.fileSystem, options.configPath)
      authoring = { ...info, module: await loadAuthoringModule(info) }
    }
    const session = new ReplSession(options, authoring)
    await session.initialize()
    return session
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

  private async initialize(): Promise<void> {
    try {
      this.evaluator = createEvaluator({ cwd: this.configDir })
      this.evaluateRaw = this.evaluator.evaluate
      if (this.options.oneShot !== true) {
        this.stdout(
          `eedsh repl (profile selection: ${this.options.profile === undefined ? 'config default' : JSON.stringify(this.options.profile)}; sync: ${this.syncEnabled ? 'on' : 'off'})`,
        )
        this.stdout(`config: ${this.configPath}`)
        this.stdout(`authoring: ${this.authoring.entryPath} (${this.authoring.version})`)
        this.stdout('bindings: config, selectedProfile, plan')
        this.stdout(
          'commands: .profile <name>, .help, .resolve, .sync, .reload; Tab completes commands and names (a second Tab lists ambiguous matches)',
        )
        if (this.options.cacheRoot === undefined) {
          await cleanupPreviews(this.cacheRoot, this.fileSystem, { now: this.now }).catch(
            () => undefined,
          )
        }
      }
      await this.loadAndSelect()
      if (this.options.watchConfig !== false) await this.startWatching()
    } catch (error) {
      await this.close()
      throw error
    }
  }

  private bind(): void {
    const context = this.evaluator.context
    for (const name of VIEW_BINDINGS) {
      if (Object.hasOwn(this.authoring.module, name)) {
        throw new ReplSessionError({
          code: 'repl.binding_collision',
          message: `the config project's @eedsh/config exports "${name}", which collides with the session binding "${name}"`,
        })
      }
    }
    const bindings: Record<string, unknown> = {}
    for (const name of AUTHORING_BINDINGS) {
      if (Object.hasOwn(this.authoring.module, name)) bindings[name] = this.authoring.module[name]
    }
    Object.assign(context, bindings, {
      config: this.configView,
      selectedProfile: this.selectedProfileView,
      plan: this.selectedProfileView.plan(),
    })
  }

  private async applySelection(
    config: EedshConfig,
    plan: ProfilePlan,
    name: string,
    provenance: ConfigProvenance | undefined,
    resolutionBundles: readonly ResolvedBundle[] = [],
    queries: readonly BundleQueryDescriptor[] = [],
  ): Promise<void> {
    this.config = config
    this.plan = plan
    this.profileName = name
    this.provenance = provenance
    this.resolutionBundles = resolutionBundles
    this.queries = queries
    this.completionBundles = new Map(
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
    await this.refreshViews()
  }

  private async refreshViews(): Promise<void> {
    const snapshots = await this.buildSnapshots(this.config, this.resolutionBundles, this.queries)
    this.configView = new ConfigView(this.config, snapshots)
    const selected = this.configView.profile(this.profileName)
    if (selected === undefined) {
      throw new ReplSessionError({
        code: 'repl.profile_selection',
        message: `profile ${JSON.stringify(this.profileName)} is not declared`,
      })
    }
    this.selectedProfileView = selected
    this.invalidateCatalogs()
  }

  private async buildSnapshots(
    config: EedshConfig,
    resolutionBundles: readonly ResolvedBundle[],
    queries: readonly BundleQueryDescriptor[],
  ): Promise<ReadonlyMap<string, ProfileSnapshot>> {
    const snapshots = new Map<string, ProfileSnapshot>()
    for (const [name, result] of Object.entries(config.profiles)) {
      const profileDir =
        name === this.profileName ? this.effectiveProfileDir() : profileDirectory(name, this.env)
      const plan = Result.isSuccess(result) ? result.success : undefined
      let composition: CompositionSnapshot | undefined
      if (plan !== undefined) {
        try {
          const composed = await this.compose(plan, profileDir, this.provenance, this.configDir)
          composition = {
            rowCount: composed.rowCount,
            entries: composed.entries ?? [],
            sources: composed.sources ?? {},
            warnings: composed.warnings,
            error: composed.error,
          }
        } catch (error) {
          composition = {
            rowCount: 0,
            entries: [],
            sources: {},
            warnings: [],
            error: messageOf(error),
          }
        }
      }
      const resolvedBundles = await this.resolveProfileBundles(
        name,
        plan,
        resolutionBundles,
        queries,
      )
      const published = await this.publishedSnapshot(profileDir)
      const packages = await PackageView.read(plan, profileDir, published.manifest, this.fileSystem)
      snapshots.set(name, { profileDir, composition, published, packages, resolvedBundles })
    }
    return snapshots
  }

  /** Resolve every bundle selection one profile view exposes. */
  private async resolveProfileBundles(
    profile: string,
    plan: ProfilePlan | undefined,
    resolutionBundles: readonly ResolvedBundle[],
    queries: readonly BundleQueryDescriptor[],
  ): Promise<ReadonlyMap<string, ResolvedBundle>> {
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
      const item = await Effect.runPromise(
        Effect.result(
          this.resolver.resolveQuery({
            bundle: selection.name,
            root: { profile },
            installation: this.installation,
            configDir: this.configDir,
            env: this.env,
          }),
        ),
      )
      if (item._tag === 'Success') resolved.set(selection.name, item.success)
    }
    return resolved
  }

  private async publishedSnapshot(profileDir: string): Promise<PublishedSnapshot> {
    const exists = profileDir !== '' && (await pathExists(this.fileSystem, profileDir))
    const manifest = exists
      ? await this.readJsonRecord(join(profileDir, 'package.json'))
      : undefined
    let generation: GenerationLookup | undefined
    let record: GenerationRecord | undefined
    let plan: unknown
    let planPath: string | undefined
    if (exists) {
      const recordPath = join(profileDir, GENERATED_MANIFEST_RELATIVE_PATH)
      if (await pathExists(this.fileSystem, recordPath)) {
        try {
          const parsed = JSON.parse(
            await Effect.runPromise(this.fileSystem.readFileString(recordPath)),
          ) as unknown
          generation = classifyGenerationRecord(parsed, recordPath)
          if (generation._tag === 'valid') {
            record = generation.record
            planPath = join(profileDir, GENERATED_DIRNAME, 'plans', `${record.generationId}.json`)
            if (await pathExists(this.fileSystem, planPath)) {
              plan = JSON.parse(
                await Effect.runPromise(this.fileSystem.readFileString(planPath)),
              ) as unknown
            }
          }
        } catch {
          generation = undefined
        }
      }
    }
    let findings: DoctorResult
    try {
      findings =
        profileDir === ''
          ? { findings: [], errors: 0, warnings: 0 }
          : await this.runDoctor(profileDir)
    } catch {
      findings = { findings: [], errors: 0, warnings: 0 }
    }
    return {
      dir: profileDir,
      exists,
      manifest,
      generation,
      record,
      plan,
      planPath,
      findings: findings.findings,
      errors: findings.errors,
      warnings: findings.warnings,
    }
  }

  private async readJsonRecord(path: string): Promise<Record<string, unknown> | undefined> {
    try {
      if (!(await pathExists(this.fileSystem, path))) return undefined
      const parsed = JSON.parse(
        await Effect.runPromise(this.fileSystem.readFileString(path)),
      ) as unknown
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }

  private invalidateCatalogs(): void {
    this.catalogVersion += 1
  }

  private async completionCatalogs(): Promise<CompletionCatalogs> {
    if (this.catalogCache?.version === this.catalogVersion) return this.catalogCache.catalogs
    const catalogs: CompletionCatalogs = {
      commands: COMMAND_NAMES,
      profiles: this.configView?.profiles().map((profile) => profile.name) ?? [],
      bundles: await this.catalogBundles(),
      packages: await this.catalogPackages(),
      rows: (bundle, root) => this.catalogRows(bundle, root),
      presets: (bundle, root) => this.catalogPresets(bundle, root),
    }
    this.catalogCache = { version: this.catalogVersion, catalogs }
    return catalogs
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
  private async prefetchCompletion(line: string): Promise<void> {
    const bundle = /bundle\(\s*(['"])(.*?)\1\s*\)/.exec(line)?.[2]
    if (bundle === undefined) return
    const profile = /\.fromProfile\(\s*(['"])(.*?)\1\s*\)/.exec(line)?.[2]
    const packageDir = /\.fromPackageDir\(\s*(['"])(.*?)\1\s*\)/.exec(line)?.[2]
    const root: QueryRoot =
      profile !== undefined ? { profile } : packageDir !== undefined ? { packageDir } : {}
    const key = queryKey(bundle, root)
    if (this.completionBundles.has(key)) return
    const resolved = await Effect.runPromise(
      Effect.result(
        this.resolver.resolveQuery({
          bundle,
          root,
          installation: this.installation,
          configDir: this.configDir,
          env: this.env,
        }),
      ),
    )
    if (resolved._tag === 'Success') this.completionBundles.set(key, resolved.success)
  }

  private async catalogBundles(): Promise<readonly string[]> {
    const names = new Set<string>()
    for (const item of this.plan?.bundles ?? []) {
      if (item.kind === 'bundle') names.add(item.name)
    }
    for (const name of await this.manifestBundles()) names.add(name)
    for (const name of await this.activeBundles()) names.add(name)
    for (const spec of this.previewSpecs) names.add(spec.name)
    return [...names].sort()
  }

  private async profileManifest(): Promise<Record<string, unknown> | undefined> {
    return await this.readJsonRecord(join(this.effectiveProfileDir(), 'package.json'))
  }

  private async manifestBundles(): Promise<readonly string[]> {
    const manifest = await this.profileManifest()
    const dsh = manifest?.dsh
    const profile =
      dsh !== null && typeof dsh === 'object' ? (dsh as Record<string, unknown>).profile : undefined
    const bundles =
      profile !== null && typeof profile === 'object'
        ? (profile as Record<string, unknown>).bundles
        : undefined
    return Array.isArray(bundles)
      ? bundles.filter((item): item is string => typeof item === 'string')
      : []
  }

  private async catalogPackages(): Promise<readonly string[]> {
    const names = new Set<string>(Object.keys(this.plan?.packages ?? {}))
    const manifest = await this.profileManifest()
    if (manifest !== undefined) {
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const value = manifest[section]
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
        for (const name of Object.keys(value)) names.add(name)
      }
    }
    return [...names].sort()
  }

  private async activeBundles(): Promise<readonly string[]> {
    const anchor = this.installation.installAnchor
    try {
      const manifest = JSON.parse(
        await Effect.runPromise(this.fileSystem.readFileString(anchor)),
      ) as Record<string, unknown>
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
          if (await this.declaresBundle(anchor, name)) names.push(name)
        }
      }
      return names
    } catch {
      return []
    }
  }

  private async declaresBundle(anchor: string, name: string): Promise<boolean> {
    try {
      const path = createRequire(anchor).resolve(`${name}/package.json`)
      const manifest = JSON.parse(
        await Effect.runPromise(this.fileSystem.readFileString(path)),
      ) as Record<string, unknown>
      const dsh = manifest.dsh
      return dsh !== null && typeof dsh === 'object' && 'bundle' in dsh
    } catch {
      return false
    }
  }

  /**
   * Complete one line against the current evaluation's catalogs. A descriptor
   * the line names is resolved read-only first; a failure contributes no hits.
   * @param line - the text before the cursor.
   * @returns the token start and hits.
   */
  async complete(line: string): Promise<CompletionResult> {
    await this.prefetchCompletion(line).catch(() => undefined)
    return completeLine({ line, cursor: line.length, catalogs: await this.completionCatalogs() })
  }

  /**
   * Fall back to top-level identifier completion from the evaluator context.
   * @param line - the text before the cursor.
   * @returns the filtered hits and the completed-on token.
   */
  async completeGeneric(line: string): Promise<readonly [string[], string]> {
    try {
      return [filterCompletionHits(this.evaluator.complete(line)), line]
    } catch {
      return [[], line]
    }
  }

  private async loadCandidate(): Promise<{
    config: EedshConfig
    plan: ProfilePlan
    name: string
    traces: readonly ResolutionTrace[]
    provenance: ConfigProvenance | undefined
    resolutionBundles: readonly ResolvedBundle[]
    queries: readonly BundleQueryDescriptor[]
  }> {
    this.evaluationNonce += 1
    const exit = await Effect.runPromiseExit(
      this.loadConfig(this.configPath, {
        installation: this.installation,
        env: this.env,
        evaluationNonce: String(this.evaluationNonce),
      }),
    )
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) throw new Error('interrupted')
      throw Cause.squash(exit.cause)
    }
    const selected = selectedPlan(exit.value.config, this.options.profile)
    return {
      config: exit.value.config,
      plan: selected.plan,
      name: selected.name,
      traces: exit.value.traces,
      provenance: exit.value.provenance,
      resolutionBundles: exit.value.resolution.bundles,
      queries: exit.value.queries,
    }
  }

  private async loadAndSelect(): Promise<void> {
    const loaded = await this.loadCandidate()
    await this.applySelection(
      loaded.config,
      loaded.plan,
      loaded.name,
      loaded.provenance,
      loaded.resolutionBundles,
      loaded.queries,
    )
    this.bind()
    this.printTraces(loaded.traces)
    this.printComposition()
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
  async reload(): Promise<void> {
    const previous = planMap(this.config)
    const previousFingerprint = this.fingerprint()
    let loaded: Awaited<ReturnType<ReplSession['loadCandidate']>>
    try {
      loaded = await this.loadCandidate()
    } catch (error) {
      this.reportFailure('reload failed', error)
      return
    }
    const next = planMap(loaded.config)
    const diff = diffPlans(previous, next)
    if (diff.length === 0) this.stdout('reload: no changes')
    else for (const line of diff) this.stdout(line)
    await this.applySelection(
      loaded.config,
      loaded.plan,
      loaded.name,
      loaded.provenance,
      loaded.resolutionBundles,
      loaded.queries,
    )
    this.bind()
    this.printTraces(loaded.traces)
    this.printComposition()
    if (!this.syncEnabled) return
    const nextFingerprint = this.fingerprint()
    if (nextFingerprint === previousFingerprint) return
    if (this.pausedFingerprint === nextFingerprint) {
      this.stdout('sync: still paused after the previous failure; waiting for a changed save')
      return
    }
    await this.syncNow()
  }

  /** Queue a reload so a burst of watcher callbacks cannot overlap evaluations. */
  private enqueueReload(): Promise<void> {
    this.reloadQueue = this.reloadQueue
      .then(() => this.reload())
      .catch((error: unknown) => {
        this.reportFailure('reload failed', error)
      })
    return this.reloadQueue
  }

  private async startWatching(): Promise<void> {
    const dir = this.configDir
    const watch = this.options.watch ?? ((path: string) => watchConfigDirectory(path))
    const reload = (): void => void this.enqueueReload()
    const reportWatchFailure = (cause: Cause.Cause<unknown>): void => {
      this.reportFailure('watch failed', Cause.squash(cause))
    }
    const scope = await Effect.runPromise(Scope.make())
    try {
      // Acquire the watcher first: it is ready (or its start failure is real)
      // before the session reports itself initialized. The scope owns the
      // subscription; close() interrupts the consumer and closes the scope.
      const events = await Effect.runPromise(Effect.provideService(watch(dir), Scope.Scope, scope))
      this.watcherScope = scope
      this.watcherFiber = await Effect.runPromise(
        events.pipe(
          Stream.debounce('150 millis'),
          Stream.runForEach(() => Effect.sync(reload)),
          Effect.catchCause((cause) => Effect.sync(() => reportWatchFailure(cause))),
          Effect.forkDetach,
        ),
      )
    } catch (cause) {
      await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))).catch(() => undefined)
      throw new ReplSessionError({
        code: 'repl.watch_failed',
        message: `cannot watch ${this.configDir}: ${messageOf(cause)}`,
      })
    }
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

  /** Evaluate without throwing, for prompt loops that must stay alive. */
  async evaluateOutcome(
    code: string,
  ): Promise<
    { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }
  > {
    try {
      return { ok: true, value: await this.evaluate(code) }
    } catch (error) {
      return { ok: false, error }
    }
  }

  /** Print an evaluated value through the session sink. */
  printValue(value: unknown): void {
    this.stdout(inspect(value, { colors: false, depth: 6, breakLength: 100 }))
  }

  /** Run one dot command. Returns true when the session should exit. */
  async command(line: string): Promise<boolean> {
    const trimmed = line.trim()
    const [word = '', ...args] = trimmed.split(/\s+/)
    switch (word) {
      case '.help':
        for (const help of HELP_LINES) this.stdout(help)
        return false
      case '.profile': {
        const name = args[0]
        if (args.length !== 1 || name === undefined) {
          this.stderr('usage: .profile <name>')
          return false
        }
        await this.switchProfile(name)
        return false
      }
      case '.reload':
        await this.enqueueReload()
        return false
      case '.exit':
        return true
      case '.clear':
        this.stdout('\u001b[2J\u001b[H')
        return false
      case '.resolve':
        if (args.length === 0) {
          this.stderr('usage: .resolve <name>@<exact-version>')
          return false
        }
        await this.resolve(args)
        return false
      case '.sync': {
        if (args.length === 0) {
          await this.syncNow()
          return false
        }
        if (args.length !== 1 || (args[0] !== 'on' && args[0] !== 'off')) {
          this.stderr('usage: .sync [on|off]')
          return false
        }
        this.syncEnabled = args[0] === 'on'
        this.pausedFingerprint = undefined
        this.stdout(`sync: ${this.syncEnabled ? 'on' : 'off'}`)
        return false
      }
      default:
        if (word.startsWith('.')) {
          this.stderr(`invalid command: ${word}; run .help to list commands`)
          return false
        }
        return false
    }
  }

  private async switchProfile(name: string): Promise<void> {
    const names = this.configView.profiles().map((profile) => profile.name)
    const view = this.configView.profile(name)
    if (view === undefined) {
      this.reportFailure(
        'profile not switched',
        new ReplSessionError({
          code: 'repl.unknown_profile',
          message: `profile ${JSON.stringify(name)} is not declared; available profiles: ${names.join(', ')}`,
        }),
      )
      return
    }
    if (!view.valid) {
      this.reportFailure(
        'profile not switched',
        new ReplSessionError({
          code: 'repl.invalid_profile',
          message: `profile ${JSON.stringify(name)} is invalid`,
          lines: [`profile ${JSON.stringify(name)} is invalid`, ...(view.error ?? '').split('\n')],
        }),
      )
      return
    }
    this.plan = view.plan()
    this.profileName = name
    await this.refreshViews()
    this.bind()
    this.stdout(`profile: ${name}`)
  }

  private parseSpecs(raw: readonly string[]): PreviewSpec[] {
    const specs: PreviewSpec[] = []
    for (const value of raw) {
      const at = value.lastIndexOf('@')
      if (at <= 0) {
        throw new PreviewError({
          code: 'preview.invalid_spec',
          message: `${JSON.stringify(value)} is not <name>@<exact-version>`,
        })
      }
      const name = value.slice(0, at)
      const version = value.slice(at + 1)
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new PreviewError({
          code: 'preview.inexact_version',
          message: `${JSON.stringify(value)} must name an exact version, not ${JSON.stringify(version)}`,
        })
      }
      specs.push({ name, version })
    }
    return specs
  }

  /** Prepare a preview and re-evaluate the config against it. */
  async resolve(rawSpecs: readonly string[]): Promise<void> {
    if (this.config === undefined) return
    let specs: PreviewSpec[]
    try {
      specs = this.parseSpecs(rawSpecs)
    } catch (error) {
      this.reportFailure('preview not ready', error)
      return
    }
    const profileDir = profileDirectory(this.profileName, this.env)
    const merged = new Map(this.previewSpecs.map((spec) => [spec.name, spec]))
    for (const spec of specs) merged.set(spec.name, spec)
    specs = [...merged.values()]
    let prepared: PreparedPreview
    try {
      prepared = await preparePreview(
        {
          profileName: this.profileName,
          profileDir,
          dshVersion: this.installation.version,
          specs,
          env: this.env,
          ...(this.options.cacheRoot === undefined ? {} : { cacheRoot: this.options.cacheRoot }),
          ...(this.installPreview === undefined ? {} : { install: this.installPreview }),
          now: this.now,
        },
        { fileSystem: this.fileSystem, spawner: this.spawner },
      )
    } catch (error) {
      this.reportFailure('preview not ready', error)
      return
    }
    const previous = {
      preview: this.preview,
      specs: this.previewSpecs,
      config: this.config,
      plan: this.plan,
      profileName: this.profileName,
      provenance: this.provenance,
      resolutionBundles: this.resolutionBundles,
      queries: this.queries,
    }
    this.preview = prepared
    this.previewSpecs = [...specs]
    this.applyPreviewEnv()
    let loaded: Awaited<ReturnType<ReplSession['loadCandidate']>>
    try {
      loaded = await this.loadCandidate()
      await this.applySelection(
        loaded.config,
        loaded.plan,
        loaded.name,
        loaded.provenance,
        loaded.resolutionBundles,
        loaded.queries,
      )
      this.bind()
    } catch (error) {
      this.preview = previous.preview
      this.previewSpecs = previous.specs
      await this.applySelection(
        previous.config,
        previous.plan,
        previous.profileName,
        previous.provenance,
        previous.resolutionBundles,
        previous.queries,
      )
      this.applyPreviewEnv()
      this.reportFailure('preview not ready', error)
      return
    }
    this.stdout(
      `preview: ${specs.map((spec) => `${spec.name}@${spec.version}`).join(', ')} at ${prepared.dir}${prepared.reused ? ' (reused)' : ''}`,
    )
    this.stdout(`profile-root override: ${JSON.stringify({ [this.profileName]: prepared.dir })}`)
    this.printTraces(loaded.traces)
    this.printComposition()
  }

  /** Publish the current evaluation, or report why publication did not happen. */
  async syncNow(): Promise<SyncOutcome | undefined> {
    if (this.syncPlan === undefined) {
      this.stderr('sync: this session has no publication runner')
      return undefined
    }
    const plan = this.plan
    try {
      const outcome = await this.syncPlan(plan, this.provenance)
      for (const warning of outcome.warnings ?? []) this.stderr(`warning: ${warning}`)
      for (const notice of outcome.notices ?? []) this.stderr(notice)
      this.stdout(
        outcome.changed
          ? `published profile ${JSON.stringify(plan.profile.name)} (generation ${outcome.generationId.slice(0, 12)})`
          : `profile ${JSON.stringify(plan.profile.name)} is up to date (generation ${outcome.generationId.slice(0, 12)})`,
      )
      if (outcome.changed && outcome.restartRequired === true) {
        this.stdout('restart required: the published bundle or package set changed')
      }
      this.pausedFingerprint = undefined
      if (this.preview !== undefined && outcome.changed) await this.verifyPreview(plan)
      await this.refreshViews()
      this.bind()
      return outcome
    } catch (error) {
      this.pausedFingerprint = this.fingerprint()
      this.reportFailure('sync failed', error)
      if (this.preview !== undefined)
        this.stderr('preview: still active; fix the failure and run .sync again')
      return undefined
    }
  }

  private async verifyPreview(published: ProfilePlan): Promise<void> {
    const preview = this.preview
    if (preview === undefined) return
    this.clearPreviewEnv()
    try {
      const loaded = await this.loadCandidate()
      if (canonicalJson(loaded.plan) === canonicalJson(published)) {
        await removePreview(preview.dir, this.fileSystem)
        this.preview = undefined
        this.previewSpecs = []
        this.retainedPreviewDir = undefined
        await this.applySelection(
          loaded.config,
          loaded.plan,
          loaded.name,
          loaded.provenance,
          loaded.resolutionBundles,
          loaded.queries,
        )
        this.bind()
        this.stdout(
          'bootstrap complete: the real install reproduces the published plan; preview deleted',
        )
        return
      }
      this.preview = undefined
      this.previewSpecs = []
      this.retainedPreviewDir = preview.dir
      this.config = loaded.config
      this.plan = loaded.plan
      this.profileName = loaded.name
      this.provenance = loaded.provenance
      this.resolutionBundles = loaded.resolutionBundles
      this.queries = loaded.queries
      this.bind()
      this.stdout('preview divergence: the real install does not reproduce the published plan')
      this.stdout(
        `kept preview at ${preview.dir}; the real evaluation is active for the next .sync`,
      )
      this.printTraces(loaded.traces)
    } catch (error) {
      this.applyPreviewEnv()
      this.preview = preview
      this.reportFailure('preview verification failed; preview kept', error)
    }
  }

  /** Stop watching, close the evaluator, and restore the process environment. */
  async close(): Promise<void> {
    if (this.watcherFiber !== undefined) {
      await Effect.runPromise(Fiber.interrupt(this.watcherFiber))
      this.watcherFiber = undefined
    }
    if (this.watcherScope !== undefined) {
      const scope = this.watcherScope
      this.watcherScope = undefined
      await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))).catch(() => undefined)
    }
    this.clearPreviewEnv()
    if (this.retainedPreviewDir !== undefined) {
      this.stdout(`preview retained at ${this.retainedPreviewDir}`)
    }
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
