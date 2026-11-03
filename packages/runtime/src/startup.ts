/**
 * Runtime startup hooks. Every profile boot that provides profile context
 * records or refreshes the machine-local installation anchor from the running
 * DSH package, independently of HMR. The generated-layer watcher is mounted
 * only inside the existing HMR service scope. Both effects are best effort: a
 * missing context or a failed write is reported and never fails the profile.
 * @module @eedsh/runtime/startup
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { InstallationAnchor } from './installation-anchor'
import { writeInstallationAnchorFile } from './installation-anchor'
import { type HmrLike, registerGeneratedLayerWatcher, type WatcherLogger } from './watcher'

/** The slice of DSH's profile context the runtime reads. */
interface ProfileContextLike {
  readonly dir?: unknown
  readonly home?: unknown
  readonly installAnchor?: unknown
}

/** The service scope the watcher effect runs in. */
export interface RuntimeScopeLike extends RuntimeContextLike {
  /** Register a scoped effect that is disposed with the scope. */
  effect?: (run: () => Promise<() => Promise<void>>, label: string) => unknown
}

/** The slice of a Cordis context this module uses. */
export interface RuntimeContextLike {
  get(name: string): unknown
  inject(names: readonly string[], callback: (scope: RuntimeScopeLike) => void): unknown
}

/** Replaceable seams for the recorder; tests use them instead of the real fs. */
export interface ActivationOptions {
  /** Logging sink; defaults to the console with an `[eedsh]` prefix. */
  logger?: WatcherLogger
  /** Read seam for the running installation manifest. */
  readFile?: (path: string) => Promise<string>
  /** Atomic write seam for the anchor record. */
  writeAnchor?: (home: string, anchor: InstallationAnchor) => Promise<void>
  /** Recording-time seam for tests. */
  now?: () => Date
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The console logger used by the plugin. Diagnostics are prefixed with
 * `[eedsh]` and go to the process console.
 * @returns the logger.
 */
export function runtimeLogger(): WatcherLogger {
  return {
    info: (message) => console.info(`[eedsh] ${message}`),
    warn: (message) => console.warn(`[eedsh] ${message}`),
    error: (message) => console.error(`[eedsh] ${message}`),
  }
}

/**
 * Record the running installation anchor from one profile context. The
 * manifest must name `@deepseek-ai/dsh` and declare a version; the record is
 * written atomically below the context's DSH home.
 * @param profileContext - the boot's profile context, when present.
 * @param options - logger and file seams.
 * @returns whether a valid anchor was written.
 */
export async function recordInstallationAnchor(
  profileContext: ProfileContextLike | undefined,
  options: ActivationOptions = {},
): Promise<boolean> {
  const logger = options.logger ?? runtimeLogger()
  if (profileContext === undefined) return false
  const home = profileContext.home
  const installAnchor = profileContext.installAnchor
  if (
    typeof home !== 'string' ||
    home.length === 0 ||
    typeof installAnchor !== 'string' ||
    installAnchor.length === 0
  ) {
    logger.warn(
      'profile context has no home or installAnchor; not recording the DSH installation anchor',
    )
    return false
  }
  if (!isAbsolute(home) || !isAbsolute(installAnchor)) {
    logger.warn(
      'profile context home or installAnchor is not absolute; not recording the DSH installation anchor',
    )
    return false
  }
  const read = options.readFile ?? ((path: string) => readFile(path, 'utf8'))
  let manifest: unknown
  try {
    manifest = JSON.parse(await read(installAnchor))
  } catch (error) {
    logger.warn(
      `cannot read the running DSH installation at ${installAnchor}: ${errorMessage(error)}`,
    )
    return false
  }
  if (!isObject(manifest) || manifest.name !== '@deepseek-ai/dsh') {
    logger.warn(
      `the running installation at ${installAnchor} is not an @deepseek-ai/dsh package; ` +
        'not recording the DSH installation anchor',
    )
    return false
  }
  const version = manifest.version
  if (typeof version !== 'string' || version.length === 0) {
    logger.warn(
      `the running DSH installation at ${installAnchor} declares no version; ` +
        'not recording the DSH installation anchor',
    )
    return false
  }
  const anchor: InstallationAnchor = {
    format: 1,
    installAnchor,
    version,
    recordedBy: 'runtime',
    recordedAt: (options.now?.() ?? new Date()).toISOString(),
  }
  const write = options.writeAnchor ?? writeInstallationAnchorFile
  try {
    await write(home, anchor)
    return true
  } catch (error) {
    logger.warn(`cannot record the DSH installation anchor below ${home}: ${errorMessage(error)}`)
    return false
  }
}

function watchGeneratedLayer(scope: RuntimeScopeLike, logger: WatcherLogger): void {
  const profileContext = scope.get('profileContext') as
    | { dir: string; installAnchor?: string }
    | undefined
  const hmr = scope.get('hmr') as HmrLike | undefined
  if (profileContext === undefined || hmr === undefined) return
  const run = async (): Promise<() => Promise<void>> => {
    const dispose = await registerGeneratedLayerWatcher({ profileContext, hmr, logger })
    return dispose ?? (() => Promise.resolve())
  }
  if (typeof scope.effect === 'function') {
    scope.effect(run, 'eedsh.generated-layer-watcher')
    return
  }
  void run().catch((error) => {
    logger.error(`generated-layer watcher failed: ${errorMessage(error)}`)
  })
}

/**
 * Activate the runtime for one plugin application: record the installation
 * anchor from profile context, then mount the generated-layer watcher when the
 * HMR service is available. Recording runs whether or not HMR is present.
 * @param ctx - the Cordis context or a test double.
 * @param options - logger and file seams.
 * @returns whether a valid anchor was written.
 */
export function activateRuntime(
  ctx: RuntimeContextLike,
  options: ActivationOptions = {},
): Promise<boolean> {
  const logger = options.logger ?? runtimeLogger()
  let recording: Promise<boolean>
  try {
    const profileContext = ctx.get('profileContext') as ProfileContextLike | undefined
    recording = recordInstallationAnchor(profileContext, { ...options, logger })
  } catch (error) {
    logger.warn(`cannot read the profile context: ${errorMessage(error)}`)
    recording = Promise.resolve(false)
  }
  ctx.inject(['hmr'], (scope) => watchGeneratedLayer(scope, logger))
  return recording
}
