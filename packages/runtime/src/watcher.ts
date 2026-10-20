/**
 * The generated-layer watcher. It watches the published generated bundle
 * manifest (the generation record), deduplicates generation ids, and asks DSH's
 * HMR service to reconcile the profile. It never evaluates TypeScript and it
 * never claims a hot reload for a change DSH reports as restart-required.
 * @module @eedsh/runtime/watcher
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Path parts of the generated bundle manifest, relative to a profile. */
export const GENERATED_MANIFEST_PARTS = ['.eedsh', 'generated', 'package.json'] as const

/**
 * Resolve the generation record path for a profile.
 * @param profileDir - absolute profile directory.
 * @returns the absolute generated package manifest path.
 */
export function generatedManifestPath(profileDir: string): string {
  return join(profileDir, ...GENERATED_MANIFEST_PARTS)
}

/** A changed module that loads only after a restart. */
export interface PendingModule {
  url: string
  reason: string
}

/** What a profile reconciliation reports. */
export interface ReconcileOutcome {
  warnings?: readonly string[]
  pending?: readonly PendingModule[]
  restartReason?: string
}

/** The slice of DSH's HMR service this watcher uses. */
export interface HmrLike {
  /** Watch one configuration path through the HMR queue; returns a disposer. */
  watchConfig(filename: string, refresh: () => Promise<void>): Promise<() => Promise<void>>
  /** Recompose the running profile from its complete patch stack. */
  reconcileProfile(): Promise<ReconcileOutcome>
}

/** Logging sink used by the watcher. */
export interface WatcherLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Inputs for {@link registerGeneratedLayerWatcher}. */
export interface RegisterWatcherInput {
  /** Present only in a profile launched by dsh. */
  profileContext?: { dir: string } | undefined
  /** The active HMR service; absent when the composition has none. */
  hmr?: HmrLike | undefined
  logger: WatcherLogger
  /** Test seam for reading the generation record. */
  readFile?: ((path: string) => Promise<string>) | undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The watcher body, factored so it can be tested without a Cordis context. */
export interface GenerationWatcher {
  /** Read the baseline generation at registration. */
  initialize(): Promise<void>
  /** Handle one watch event. */
  refresh(): Promise<void>
  /** The last generation id this watcher reconciled. */
  lastGenerationId(): string | undefined
}

/**
 * Create the generation watcher around a manifest path.
 * @param options - manifest path, HMR service, logger, and read seam.
 * @returns the watcher body.
 */
export function createGenerationWatcher(options: {
  manifestPath: string
  hmr: HmrLike
  logger: WatcherLogger
  readFile?: ((path: string) => Promise<string>) | undefined
}): GenerationWatcher {
  const read = options.readFile ?? ((path: string) => readFile(path, 'utf8'))
  let last: string | undefined

  async function readGenerationId(): Promise<string | undefined> {
    let text: string
    try {
      text = await read(options.manifestPath)
    } catch (error) {
      options.logger.warn(
        `cannot read generated manifest ${options.manifestPath}: ${errorMessage(error)}`,
      )
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      options.logger.error(
        `malformed generation record at ${options.manifestPath}: ${errorMessage(error)}`,
      )
      return undefined
    }
    const metadata = isObject(parsed) ? parsed.eedsh : undefined
    const id = isObject(metadata) ? metadata.generationId : undefined
    if (typeof id !== 'string' || id.length === 0) {
      options.logger.error(
        `malformed generation record at ${options.manifestPath}: missing eedsh.generationId`,
      )
      return undefined
    }
    return id
  }

  async function initialize(): Promise<void> {
    const id = await readGenerationId()
    if (id === undefined) return
    last = id
    options.logger.info(`observing generation ${id}`)
  }

  async function refresh(): Promise<void> {
    const id = await readGenerationId()
    if (id === undefined) return
    if (last === undefined) {
      last = id
      options.logger.info(`observing generation ${id}`)
      return
    }
    if (id === last) return
    try {
      const outcome = await options.hmr.reconcileProfile()
      last = id
      for (const warning of outcome.warnings ?? []) options.logger.warn(warning)
      const restart = outcome.restartReason ?? outcome.pending?.[0]?.reason
      if (restart !== undefined) {
        options.logger.warn(
          `generation ${id} requires a restart (${restart}); the running composition was not hot-reloaded`,
        )
        return
      }
      options.logger.info(`generation ${id} applied`)
    } catch (error) {
      options.logger.error(`generation ${id} failed to reconcile: ${errorMessage(error)}`)
    }
  }

  return { initialize, refresh, lastGenerationId: () => last }
}

/**
 * Register the generated-layer watcher. Without profile context or an active
 * HMR service nothing is registered, so HMR-disabled compositions keep running
 * their current tree until the next process start.
 * @param input - profile context, HMR service, logger, and read seam.
 * @returns the watcher disposer, or undefined when registration is skipped.
 */
export async function registerGeneratedLayerWatcher(
  input: RegisterWatcherInput,
): Promise<(() => Promise<void>) | undefined> {
  const profileContext = input.profileContext
  const hmr = input.hmr
  if (profileContext === undefined || hmr === undefined) return undefined

  const manifestPath = generatedManifestPath(profileContext.dir)
  const watcher = createGenerationWatcher({
    manifestPath,
    hmr,
    logger: input.logger,
    ...(input.readFile === undefined ? {} : { readFile: input.readFile }),
  })
  await watcher.initialize()
  const dispose = await hmr.watchConfig(manifestPath, () => watcher.refresh())
  input.logger.info(`watching generated layer ${manifestPath}`)
  return dispose
}
