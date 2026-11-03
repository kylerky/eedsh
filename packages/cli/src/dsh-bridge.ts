/**
 * Load the composition capabilities from the selected DSH installation and
 * install the global bridge the authoring package reads. The bridge carries
 * the exact selected version, so dshVersion() and every query agree.
 * @module @eedsh/cli/dsh-bridge
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { type DshBridge, installDshBridge, REQUIRED_DSH_CAPABILITIES } from '@eedsh/config'
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
 * Resolve, import, validate, and install the bridge for one installation.
 * @param installation - the selected DSH installation.
 * @returns the installed bridge, or a tagged failure.
 */
export async function loadDshBridge(
  installation: DiscoveredDshInstallation,
): Promise<Result.Result<DshBridge, DshFailure>> {
  let appBootPath: string
  try {
    const require = createRequire(installation.installAnchor)
    appBootPath = require.resolve(APP_BOOT_PACKAGE)
  } catch (cause) {
    return Result.fail(
      failure({
        code: 'dsh.bridge_unavailable',
        path: installation.installAnchor,
        version: installation.version,
        message: `DSH ${installation.version} cannot provide ${APP_BOOT_PACKAGE} from ${installation.installAnchor}; reinstall dsh or select another installation with --dsh`,
        cause,
      }),
    )
  }

  let module: Record<string, unknown>
  try {
    module = (await import(pathToFileURL(appBootPath).href)) as Record<string, unknown>
  } catch (cause) {
    return Result.fail(
      failure({
        code: 'dsh.bridge_load_failed',
        path: appBootPath,
        version: installation.version,
        message: `cannot load ${APP_BOOT_PACKAGE} from DSH ${installation.version} at ${appBootPath}`,
        cause,
      }),
    )
  }

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
  installDshBridge(bridge)
  return Result.succeed(bridge)
}
