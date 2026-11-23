/**
 * Load the composition capabilities from the selected DSH installation. The
 * value carries the exact selected version; the caller caches it for the
 * invocation and resolves recorded descriptors against it.
 * @module @eedsh/cli/dsh-bridge
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { type DshBridge, REQUIRED_DSH_CAPABILITIES } from '@eedsh/config'
import * as Result from 'effect/Result'
import type { DiscoveredDshInstallation } from './dsh-discovery'
import { DshFailure } from './internal/effect/errors'

const APP_BOOT_PACKAGE = '@deepseek-ai/dsh-app-boot'

function failure(input: {
  code: ConstructorParameters<typeof DshFailure>[0]['code']
  message: string
  path?: string
  version?: string
  capability?: string
  cause?: unknown
}): DshFailure {
  return new DshFailure({
    code: input.code,
    message: input.message,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.capability === undefined ? {} : { capability: input.capability }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  })
}

/**
 * Import one module path, turning a path-conversion failure or a rejected
 * import into a `Result` failure.
 * @param path - absolute module path.
 * @returns the imported namespace, or the failure cause.
 */
async function importModule(
  path: string,
): Promise<Result.Result<Record<string, unknown>, unknown>> {
  const url = Result.try({
    try: () => pathToFileURL(path).href,
    catch: (cause) => cause,
  })
  if (Result.isFailure(url)) return Result.fail(url.failure)
  return import(url.success).then(
    (module: Record<string, unknown>) => Result.succeed(module),
    (cause: unknown) => Result.fail(cause),
  )
}

/**
 * Resolve, import, and validate the bridge for one installation. The value is
 * returned to the caller's resolver cache; nothing global is installed.
 * @param installation - the selected DSH installation.
 * @returns the bridge value, or a tagged failure.
 */
export async function loadDshBridge(
  installation: DiscoveredDshInstallation,
): Promise<Result.Result<DshBridge, DshFailure>> {
  const resolved = Result.try({
    try: () => createRequire(installation.installAnchor).resolve(APP_BOOT_PACKAGE),
    catch: (cause) => cause,
  })
  if (Result.isFailure(resolved)) {
    return Result.fail(
      failure({
        code: 'dsh.bridge_unavailable',
        path: installation.installAnchor,
        version: installation.version,
        message: `DSH ${installation.version} cannot provide ${APP_BOOT_PACKAGE} from ${installation.installAnchor}; reinstall dsh or select another installation with --dsh`,
        cause: resolved.failure,
      }),
    )
  }
  const appBootPath = resolved.success

  const imported = await importModule(appBootPath)
  if (Result.isFailure(imported)) {
    return Result.fail(
      failure({
        code: 'dsh.bridge_load_failed',
        path: appBootPath,
        version: installation.version,
        message: `cannot load ${APP_BOOT_PACKAGE} from DSH ${installation.version} at ${appBootPath}`,
        cause: imported.failure,
      }),
    )
  }
  const module = imported.success

  for (const capability of REQUIRED_DSH_CAPABILITIES) {
    if (typeof module[capability] !== 'function') {
      return Result.fail(
        failure({
          code: 'dsh.capability_missing',
          capability,
          version: installation.version,
          path: appBootPath,
          message: `DSH ${installation.version} does not provide the "${capability}" capability`,
        }),
      )
    }
  }

  const bridge: DshBridge = {
    version: installation.version,
    installation: {
      installAnchor: installation.installAnchor,
      packageDir: installation.packageDir,
      binPath: installation.binPath,
    },
    resolveProfileDir: module.resolveProfileDir as DshBridge['resolveProfileDir'],
    resolveBundleDir: module.resolveBundleDir as DshBridge['resolveBundleDir'],
    readProfileManifest: module.readProfileManifest as DshBridge['readProfileManifest'],
    bundlePatchFiles: module.bundlePatchFiles as DshBridge['bundlePatchFiles'],
    loadOverlayPatches: module.loadOverlayPatches as DshBridge['loadOverlayPatches'],
    composeEntries: module.composeEntries as DshBridge['composeEntries'],
  }
  return Result.succeed(bridge)
}
