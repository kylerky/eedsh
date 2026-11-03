/**
 * The config REPL session. It owns evaluation bindings, the selected profile,
 * save-triggered reloads, preview resolution, and in-session publication.
 * Formatting lives here so the command, tests, and non-TTY runs share it.
 * @module @eedsh/cli/repl/session
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import type { REPLServer } from 'node:repl'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { activeDshBridge, type ConfigProvenance, bundle as defaultBundle } from '@eedsh/config'
import { canonicalJson, type EedshConfig, type ProfilePlan } from '@eedsh/plan'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Cause, Effect, Exit, Option } from 'effect'
import * as Result from 'effect/Result'
import {
  type ConfigLoadFailure,
  loadConfig as defaultLoadConfig,
  type LoadedConfig,
} from '../config'
import { type DoctorResult, doctor } from '../doctor'
import { resolveBundleLayers } from '../dsh'
import { presetDefinitionErrorLines } from '../internal/authoring-error'
import { resolveDshHome, resolveProfileDir } from '../internal/dsh-home'
import type { GenerationRecord } from '../materialize/generated-bundle'
import { classifyGenerationRecord, type GenerationLookup } from '../materialize/generation-record'
import { GENERATED_DIRNAME, GENERATED_MANIFEST_RELATIVE_PATH } from '../materialize/profile'
import { composePreflightLayers, type PreflightLayer, touchedRowIds } from '../preflight'
import { describeProfileSelection, selectProfile } from '../selection'
import { type WatchSession, watchConfigDirectory } from '../watch'
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

/** The structural query handle completion needs from either authoring copy. */
interface QueryHandleLike {
  rows(): readonly { readonly id: string }[]
  presets(): readonly { readonly id: string }[]
  fromProfile(profile: string): QueryHandleLike
  fromPackageDir(dir: string): QueryHandleLike
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
  readonly loadConfig?: (
    path: string,
    evaluationNonce?: string,
  ) => Effect.Effect<LoadedConfig, ReplConfigFailure>
  readonly watch?: (dir: string, onChange: () => void) => Promise<WatchSession>
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

interface ResolutionTrace {
  readonly bundle: string
  readonly packageDir: string
  readonly version: string
  readonly origin: 'active' | 'profile' | 'packageDir' | 'preview'
  readonly profile?: string
}

const TRACE_KEY = Symbol.for('@eedsh/config.resolution-trace')
/** The bridge the CLI installs for the selected DSH installation. */
const DSH_BRIDGE_KEY = Symbol.for('@eedsh/config.dsh-bridge')

/** The selected installation's version, when a bridge has been installed. */
function activeDshVersion(): string {
  const bridge = (globalThis as { [key: symbol]: unknown })[DSH_BRIDGE_KEY]
  if (bridge !== null && typeof bridge === 'object') {
    const version = (bridge as { version?: unknown }).version
    if (typeof version === 'string') return version
  }
  return 'unknown'
}
/** The curated authoring factories bound into the prompt. */
const AUTHORING_BINDINGS = [
  'bundle',
  'defineConfig',
  'definePreset',
  'dshVersion',
  'group',
  'js',
] as const

/** The typed view names the prompt owns; an authoring export must not shadow one. */
const VIEW_BINDINGS = ['config', 'plan', 'selectedProfile'] as const

const HELP_LINES = [
  'bindings:',
  '  config                the loaded config view: defaultProfile, profiles()',
  '  dshVersion()          the exact version of the selected DSH installation',
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
  'expressions are TypeScript and may use top-level await; bindings persist',
]

function traceStore(): ResolutionTrace[] {
  const global = globalThis as typeof globalThis & { [key: symbol]: unknown }
  const existing = global[TRACE_KEY]
  if (Array.isArray(existing)) return existing as ResolutionTrace[]
  const created: ResolutionTrace[] = []
  global[TRACE_KEY] = created
  return created
}

function takeTrace(): ResolutionTrace[] {
  const store = traceStore()
  return store.splice(0, store.length)
}

function clearTrace(): void {
  traceStore().splice(0, traceStore().length)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorLines(error: unknown): string[] {
  const tagged =
    error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  if (typeof tagged._tag === 'string') {
    switch (tagged._tag) {
      case 'ConfigError':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'ResolutionError':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'PresetDefinitionError':
        return presetDefinitionErrorLines(tagged)
      case 'PreviewError':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'ReplSessionError':
        return Array.isArray(tagged.lines) ? tagged.lines.map(String) : [messageOf(error)]
      case 'SyncLocked':
        return [`another sync is running for this profile; lock: ${String(tagged.lockPath)}`]
      case 'PreflightFailure': {
        const warnings = Array.isArray(tagged.warnings) ? tagged.warnings.map(String) : []
        return [String(tagged.message), ...warnings]
      }
      case 'PackageInstallFailure':
        return [
          `package installation failed in ${String(tagged.profileDir)}: ${String(tagged.cause)}`,
        ]
      case 'OwnershipRecordInvalid':
        return [`cannot reconcile ${String(tagged.path)}: ${String(tagged.detail)}`]
      default:
        break
    }
  }
  if (typeof tagged.message === 'string') return tagged.message.split('\n')
  return [messageOf(error)]
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

function declaresAuthoring(configDir: string): boolean {
  let dir = configDir
  while (true) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
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

function authoringPackage(configPath: string): AuthoringPackage {
  const configDir = dirname(configPath)
  const require = createRequire(join(configDir, 'package.json'))
  const localPackage = join(configDir, 'node_modules', '@eedsh', 'config', 'package.json')
  let packagePath: string
  let entryPath: string
  if (!existsSync(localPackage) && !declaresAuthoring(configDir)) {
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
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown }
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

async function createEvaluator(): Promise<{
  server: REPLServer
  evaluate: (code: string) => Promise<unknown>
}> {
  await import('tsx/patch-repl')
  const repl = await import('node:repl')
  const input = new PassThrough()
  const output = new PassThrough()
  const server = repl.start({
    input,
    output,
    terminal: false,
    prompt: '',
    useColors: false,
    breakEvalOnSigint: false,
  })
  const evaluate = (code: string): Promise<unknown> =>
    new Promise((resolvePromise, reject) => {
      const target = server as unknown as {
        eval: (
          code: string,
          context: unknown,
          filename: string,
          callback: (error: Error | null, result: unknown) => void,
        ) => void
        _handleError?: (error: unknown) => unknown
      }
      const originalHandleError = target._handleError
      let settled = false
      const finish = (error: unknown, result?: unknown): void => {
        if (settled) return
        settled = true
        if (originalHandleError === undefined) delete target._handleError
        else target._handleError = originalHandleError
        if (error === null || error === undefined) resolvePromise(result)
        else reject(error)
      }
      // Node's REPL reports runtime errors through _handleError instead of the
      // eval callback. Capture that path so one-shot evaluation and the prompt
      // both receive the failure and keep the session alive.
      target._handleError = (error: unknown) => {
        finish(error)
        return 'handled'
      }
      const fn = target.eval
      try {
        fn.call(server, code, server.context, 'eedsh', (error, result) => {
          finish(error, result)
        })
      } catch (error) {
        finish(error)
      }
    })
  return { server, evaluate }
}

function profileDirectory(name: string, env: Record<string, string | undefined>): string {
  return resolveProfileDir(name, resolveDshHome(undefined, env))
}

async function defaultDoctor(profileDir: string): Promise<DoctorResult> {
  return await Effect.runPromise(doctor({ profileDir }).pipe(Effect.provide(NodeServices.layer)))
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
  installAnchor: string,
  provenance: ConfigProvenance | undefined,
  configDir: string,
): Promise<CompositionResult> {
  const layers: PreflightLayer[] = []
  let generatedPlaced = false
  for (const item of plan.bundles) {
    if (item.kind === 'generated') {
      layers.push(...generatedPreflightLayers(plan, provenance))
      generatedPlaced = true
      continue
    }
    const result = resolveBundleLayers(item.name, profileDir, installAnchor)
    if (Result.isFailure(result)) {
      return {
        rowCount: 0,
        warnings: [],
        error: `cannot resolve bundle ${JSON.stringify(item.name)}: ${messageOf(result.failure)} `,
      }
    }
    layers.push({ label: `bundle:${item.name}`, patches: result.success })
  }
  if (!generatedPlaced) layers.push(...generatedPreflightLayers(plan, provenance))
  const sources: Record<string, string> = {}
  for (const layer of layers) {
    for (const [offset, patch] of layer.patches.entries()) {
      const source = sourceOf(layer, offset, configDir)
      for (const id of touchedRowIds([patch])) sources[id] = source
    }
  }
  const composition = composePreflightLayers(layers)
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
  private readonly env: Record<string, string | undefined>
  private readonly previousEnv: {
    anchor: string | undefined
    configDir: string | undefined
    override: string | undefined
    dshHome: string | undefined
  }
  private readonly loadConfig: (
    path: string,
    evaluationNonce?: string,
  ) => Effect.Effect<LoadedConfig, ReplConfigFailure>
  private readonly compose: ComposePlan
  private readonly runDoctor: (profileDir: string) => Promise<DoctorResult>
  private readonly syncPlan: SyncPlan | undefined
  private readonly installPreview: ((dir: string) => Promise<void>) | undefined
  private readonly cacheRoot: string
  private readonly now: () => number
  private server!: REPLServer
  private evaluateRaw!: (code: string) => Promise<unknown>
  private config!: EedshConfig
  private plan!: ProfilePlan
  private provenance: ConfigProvenance | undefined
  private profileName!: string
  private configView!: ConfigView
  private selectedProfileView!: ProfileView
  private syncEnabled: boolean
  private preview: PreparedPreview | undefined
  private previewSpecs: PreviewSpec[] = []
  private retainedPreviewDir: string | undefined
  private pausedFingerprint: string | undefined
  private watcher: WatchSession | undefined
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
    this.authoring = authoring
    this.loadConfig = options.loadConfig ?? defaultLoadConfig
    this.runDoctor = options.doctor ?? defaultDoctor
    this.syncPlan = options.syncPlan
    this.installPreview = options.installPreview
    this.cacheRoot = options.cacheRoot ?? previewCacheRoot(this.env)
    this.now = options.now ?? Date.now
    this.syncEnabled = options.sync === true
    this.compose =
      options.compose ??
      ((plan, profileDir, provenance, configDir) => {
        const bridge = activeDshBridge()
        if (bridge === undefined) {
          return Promise.resolve({
            rowCount: 0,
            warnings: [],
            error: 'the REPL needs the active DSH installation; run "eedsh repl" or select one with --dsh',
          })
        }
        return defaultCompose(
          plan,
          profileDir,
          bridge.installation.installAnchor,
          provenance,
          configDir,
        )
      })
    this.previousEnv = {
      anchor: process.env.EEDSH_DSH_ANCHOR,
      configDir: process.env.EEDSH_CONFIG_DIR,
      override: process.env.EEDSH_PROFILE_ROOT_OVERRIDE,
      dshHome: process.env.DSH_HOME,
    }
  }

  /**
   * Resolve the config project's authoring package and start a session.
   * @param options - config path, profile, streams, and seams.
   * @returns the initialized session, or a structured failure.
   */
  static async create(options: ReplSessionOptions): Promise<ReplSession> {
    let authoring = options.authoring
    if (authoring === undefined) {
      const info = authoringPackage(options.configPath)
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
    const bridge = activeDshBridge()
    if (bridge === undefined) {
      throw new ReplSessionError({
        code: 'repl.bridge_missing',
        message:
          'the REPL needs the active DSH installation; run through "eedsh repl" or select one with --dsh',
      })
    }
    const installation = { installAnchor: bridge.installation.installAnchor }
    try {
      this.env.EEDSH_DSH_ANCHOR = installation.installAnchor
      this.env.EEDSH_CONFIG_DIR = this.configDir
      process.env.EEDSH_DSH_ANCHOR = installation.installAnchor
      process.env.EEDSH_CONFIG_DIR = this.configDir
      const dshHome = this.env.DSH_HOME
      if (dshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = dshHome
      const evaluator = await createEvaluator()
      this.server = evaluator.server
      this.evaluateRaw = evaluator.evaluate
      if (this.options.oneShot !== true) {
        this.stdout(
          `eedsh repl (profile selection: ${this.options.profile === undefined ? 'config default' : JSON.stringify(this.options.profile)}; sync: ${this.syncEnabled ? 'on' : 'off'})`,
        )
        this.stdout(`config: ${this.configPath}`)
        this.stdout(`authoring: ${this.authoring.entryPath} (${this.authoring.version})`)
        this.stdout('bindings: config, selectedProfile, plan, dshVersion()')
        this.stdout(
          'commands: .profile <name>, .help, .resolve, .sync, .reload; Tab completes commands and names (a second Tab lists ambiguous matches)',
        )
        if (this.options.cacheRoot === undefined) {
          await cleanupPreviews(this.cacheRoot, { now: this.now }).catch(() => undefined)
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
    const context = this.server.context as Record<string, unknown>
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
  ): Promise<void> {
    this.config = config
    this.plan = plan
    this.profileName = name
    this.provenance = provenance
    await this.refreshViews()
  }

  private async refreshViews(): Promise<void> {
    const snapshots = await this.buildSnapshots(this.config)
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

  private async buildSnapshots(config: EedshConfig): Promise<ReadonlyMap<string, ProfileSnapshot>> {
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
      const published = await this.publishedSnapshot(profileDir)
      snapshots.set(name, { profileDir, composition, published })
    }
    return snapshots
  }

  private async publishedSnapshot(profileDir: string): Promise<PublishedSnapshot> {
    const exists = profileDir !== '' && existsSync(profileDir)
    const manifest = exists ? this.readJsonRecord(join(profileDir, 'package.json')) : undefined
    let generation: GenerationLookup | undefined
    let record: GenerationRecord | undefined
    let plan: unknown
    let planPath: string | undefined
    if (exists) {
      const recordPath = join(profileDir, GENERATED_MANIFEST_RELATIVE_PATH)
      if (existsSync(recordPath)) {
        try {
          const parsed = JSON.parse(readFileSync(recordPath, 'utf8')) as unknown
          generation = classifyGenerationRecord(parsed, recordPath)
          if (generation._tag === 'valid') {
            record = generation.record
            planPath = join(profileDir, GENERATED_DIRNAME, 'plans', `${record.generationId}.json`)
            if (existsSync(planPath)) {
              plan = JSON.parse(readFileSync(planPath, 'utf8')) as unknown
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

  private readJsonRecord(path: string): Record<string, unknown> | undefined {
    try {
      if (!existsSync(path)) return undefined
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
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

  private completionCatalogs(): CompletionCatalogs {
    if (this.catalogCache?.version === this.catalogVersion) return this.catalogCache.catalogs
    const catalogs: CompletionCatalogs = {
      commands: COMMAND_NAMES,
      profiles: this.configView?.profiles().map((profile) => profile.name) ?? [],
      bundles: this.catalogBundles(),
      packages: this.catalogPackages(),
      rows: (bundle, root) => this.catalogRows(bundle, root),
      presets: (bundle, root) => this.catalogPresets(bundle, root),
    }
    this.catalogCache = { version: this.catalogVersion, catalogs }
    return catalogs
  }

  private queryFactory(): (name: string) => QueryHandleLike {
    const candidate = this.authoring.module.bundle
    return typeof candidate === 'function'
      ? (candidate as unknown as (name: string) => QueryHandleLike)
      : (defaultBundle as unknown as (name: string) => QueryHandleLike)
  }

  private queryHandle(bundle: string, root: CompletionRoot): QueryHandleLike {
    let handle = this.queryFactory()(bundle)
    if (root.profile !== undefined) handle = handle.fromProfile(root.profile)
    else if (root.packageDir !== undefined) handle = handle.fromPackageDir(root.packageDir)
    return handle
  }

  private catalogRows(bundle: string, root: CompletionRoot): readonly string[] {
    try {
      const ids: string[] = []
      const seen = new Set<string>()
      for (const row of this.queryHandle(bundle, root).rows()) {
        if (row.id === '' || seen.has(row.id)) continue
        seen.add(row.id)
        ids.push(row.id)
      }
      return ids
    } catch {
      return []
    }
  }

  private catalogPresets(bundle: string, root: CompletionRoot): readonly string[] {
    try {
      const ids: string[] = []
      const seen = new Set<string>()
      for (const preset of this.queryHandle(bundle, root).presets()) {
        if (preset.id === '' || seen.has(preset.id)) continue
        seen.add(preset.id)
        ids.push(preset.id)
      }
      return ids
    } catch {
      return []
    }
  }

  private catalogBundles(): readonly string[] {
    const names = new Set<string>()
    for (const item of this.plan?.bundles ?? []) {
      if (item.kind === 'bundle') names.add(item.name)
    }
    for (const name of this.manifestBundles()) names.add(name)
    for (const name of this.activeBundles()) names.add(name)
    for (const spec of this.previewSpecs) names.add(spec.name)
    return [...names].sort()
  }

  private profileManifest(): Record<string, unknown> | undefined {
    try {
      const path = join(this.effectiveProfileDir(), 'package.json')
      if (!existsSync(path)) return undefined
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }

  private manifestBundles(): readonly string[] {
    const manifest = this.profileManifest()
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

  private catalogPackages(): readonly string[] {
    const names = new Set<string>(Object.keys(this.plan?.packages ?? {}))
    const manifest = this.profileManifest()
    if (manifest !== undefined) {
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const value = manifest[section]
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
        for (const name of Object.keys(value)) names.add(name)
      }
    }
    return [...names].sort()
  }

  private activeBundles(): readonly string[] {
    const bridge = activeDshBridge()
    if (bridge === undefined) return []
    const anchor = bridge.installation.installAnchor
    try {
      const manifest = JSON.parse(readFileSync(anchor, 'utf8')) as Record<string, unknown>
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
          if (this.declaresBundle(anchor, name)) names.push(name)
        }
      }
      return names
    } catch {
      return []
    }
  }

  private declaresBundle(anchor: string, name: string): boolean {
    try {
      const path = createRequire(anchor).resolve(`${name}/package.json`)
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      const dsh = manifest.dsh
      return dsh !== null && typeof dsh === 'object' && 'bundle' in dsh
    } catch {
      return false
    }
  }

  /**
   * Complete one line against the current evaluation's catalogs. Resolution
   * traces produced by completion are drained so Tab never prints provenance.
   * @param line - the text before the cursor.
   * @returns the token start and hits.
   */
  async complete(line: string): Promise<CompletionResult> {
    takeTrace()
    try {
      return completeLine({ line, cursor: line.length, catalogs: this.completionCatalogs() })
    } finally {
      takeTrace()
    }
  }

  /**
   * Fall back to the hidden evaluator's JavaScript completion.
   * @param line - the text before the cursor.
   * @returns the filtered hits and the completed-on token.
   */
  async completeGeneric(line: string): Promise<readonly [string[], string]> {
    const server = this.server as unknown as {
      complete?: (
        text: string,
        callback: (error: unknown, result?: [string[], string]) => void,
      ) => void
    }
    const run = server.complete
    if (typeof run !== 'function') return [[], line]
    return await new Promise<readonly [string[], string]>((resolve) => {
      let settled = false
      const finish = (error: unknown, result?: [string[], string]): void => {
        if (settled) return
        settled = true
        if ((error !== null && error !== undefined) || result === undefined) {
          resolve([[], line])
          return
        }
        resolve([filterCompletionHits(result[0]), result[1]])
      }
      try {
        run.call(server, line, finish)
      } catch {
        resolve([[], line])
      }
    })
  }

  private async loadCandidate(): Promise<{
    config: EedshConfig
    plan: ProfilePlan
    name: string
    traces: ResolutionTrace[]
    provenance: ConfigProvenance | undefined
  }> {
    clearTrace()
    this.evaluationNonce += 1
    const exit = await Effect.runPromiseExit(
      this.loadConfig(this.configPath, String(this.evaluationNonce)),
    )
    const traces = takeTrace()
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) throw new Error('interrupted')
      throw Cause.squash(exit.cause)
    }
    const selected = selectedPlan(exit.value.config, this.options.profile)
    return {
      config: exit.value.config,
      plan: selected.plan,
      name: selected.name,
      traces,
      provenance: exit.value.provenance,
    }
  }

  private async loadAndSelect(): Promise<void> {
    const loaded = await this.loadCandidate()
    await this.applySelection(loaded.config, loaded.plan, loaded.name, loaded.provenance)
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
      this.preview === undefined ? this.previousEnv.override : JSON.stringify(this.preview.override)
    if (override === undefined) delete process.env.EEDSH_PROFILE_ROOT_OVERRIDE
    else process.env.EEDSH_PROFILE_ROOT_OVERRIDE = override
  }

  private clearPreviewEnv(): void {
    if (this.previousEnv.override === undefined) delete process.env.EEDSH_PROFILE_ROOT_OVERRIDE
    else process.env.EEDSH_PROFILE_ROOT_OVERRIDE = this.previousEnv.override
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
    await this.applySelection(loaded.config, loaded.plan, loaded.name, loaded.provenance)
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
    try {
      this.watcher =
        this.options.watch === undefined
          ? await watchConfigDirectory({
              dir: this.configDir,
              onChange: () => void this.enqueueReload(),
            })
          : await this.options.watch(this.configDir, () => void this.enqueueReload())
    } catch (cause) {
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
    clearTrace()
    try {
      const value = await this.evaluateRaw(code)
      this.printTraces(takeTrace())
      return value
    } catch (error) {
      this.printTraces(takeTrace())
      throw error
    }
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
      prepared = await preparePreview({
        profileName: this.profileName,
        profileDir,
        dshVersion: activeDshVersion(),
        specs,
        env: this.env,
        ...(this.options.cacheRoot === undefined ? {} : { cacheRoot: this.options.cacheRoot }),
        ...(this.installPreview === undefined ? {} : { install: this.installPreview }),
        now: this.now,
      })
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
    }
    this.preview = prepared
    this.previewSpecs = [...specs]
    this.applyPreviewEnv()
    let loaded: Awaited<ReturnType<ReplSession['loadCandidate']>>
    try {
      loaded = await this.loadCandidate()
      await this.applySelection(loaded.config, loaded.plan, loaded.name, loaded.provenance)
      this.bind()
    } catch (error) {
      this.preview = previous.preview
      this.previewSpecs = previous.specs
      await this.applySelection(
        previous.config,
        previous.plan,
        previous.profileName,
        previous.provenance,
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
        await removePreview(preview.dir)
        this.preview = undefined
        this.previewSpecs = []
        this.retainedPreviewDir = undefined
        await this.applySelection(loaded.config, loaded.plan, loaded.name, loaded.provenance)
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
    await this.watcher?.close().catch(() => undefined)
    this.watcher = undefined
    if (this.server !== undefined) this.server.close()
    this.clearPreviewEnv()
    if (this.previousEnv.anchor === undefined) delete process.env.EEDSH_DSH_ANCHOR
    else process.env.EEDSH_DSH_ANCHOR = this.previousEnv.anchor
    if (this.previousEnv.configDir === undefined) delete process.env.EEDSH_CONFIG_DIR
    else process.env.EEDSH_CONFIG_DIR = this.previousEnv.configDir
    if (this.previousEnv.dshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = this.previousEnv.dshHome
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
