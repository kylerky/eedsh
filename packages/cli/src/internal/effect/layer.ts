/**
 * Live service layers. Package installation runs through the core
 * `ChildProcess` API, and file access and terminal services come from
 * `@effect/platform-node`'s aggregate layer at the CLI bootstrap.
 * @module @eedsh/cli/internal/effect/layer
 */
import { Effect, Layer, Stream } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { pnpmInvocation } from '../../command-runner'
import { resolveBundleLayers } from '../../dsh'
import type { DiscoveredDshInstallation } from '../../dsh-discovery'
import { posixSyncLock } from '../lock-posix'
import { win32SyncLock } from '../lock-win32'
import { PackageInstallFailure } from './errors'
import {
  DshInstallation,
  type DshInstallationShape,
  PackageManager,
  type PackageManagerShape,
  SyncLock,
  type SyncLockShape,
} from './services'

/**
 * Install profile dependencies with pnpm inside the profile directory. pnpm is
 * DSH's own package manager, so the profile layout stays what `dsh plugin`
 * and boot expect. stderr is collected for the diagnostic; a non-zero exit
 * fails the installation.
 */
function installWithPnpm(
  profileDir: string,
): Effect.Effect<
  void,
  PackageInstallFailure | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const invocation = pnpmInvocation(['install'])
      const handle = yield* ChildProcess.make(invocation.command, [...invocation.args], {
        cwd: profileDir,
      })
      const [stderr, exitCode] = yield* Effect.all(
        [handle.stderr.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: 'unbounded' },
      )
      if (Number(exitCode) !== 0) {
        return yield* Effect.fail(
          new PackageInstallFailure({
            profileDir,
            cause: new Error(`pnpm install exited with code ${String(exitCode)}: ${stderr.trim()}`),
          }),
        )
      }
    }),
  )
}

/** pnpm-backed package installation. */
export const pnpmPackageManagerLayer: Layer.Layer<
  PackageManagerShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  PackageManager,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const shape: PackageManagerShape = {
      install: (profileDir) =>
        Effect.provideService(
          installWithPnpm(profileDir),
          ChildProcessSpawner.ChildProcessSpawner,
          spawner,
        ).pipe(
          Effect.catch((cause) =>
            Effect.fail(
              cause instanceof PackageInstallFailure
                ? cause
                : new PackageInstallFailure({ profileDir, cause }),
            ),
          ),
        ),
    }
    return shape
  }),
)

/** The discovered DSH installation as a service. */
export function dshInstallationLayerFor(
  installation: DiscoveredDshInstallation,
): Layer.Layer<DshInstallationShape> {
  const shape: DshInstallationShape = {
    version: installation.version,
    installAnchor: installation.installAnchor,
    binPath: installation.binPath,
    resolveBundlePatches: (packageName, profileDir) =>
      Effect.fromResult(resolveBundleLayers(packageName, profileDir, installation.installAnchor)),
  }
  return Layer.succeed(DshInstallation, shape)
}

/** Injectable platform implementations for tests and alternate hosts. */
export interface SyncLockPlatforms {
  readonly posix?: SyncLockShape
  readonly win32?: SyncLockShape
}

/**
 * Platform-selected kernel sync lock. Linux and macOS use their native flock,
 * Windows uses its named semaphore, and every other platform fails closed
 * before materialization.
 * @param platform - platform to select for; defaults to the running platform.
 * @param platforms - implementation overrides for tests.
 * @returns the sync lock layer.
 */
export function syncLockLayer(
  platform: NodeJS.Platform = process.platform,
  platforms: SyncLockPlatforms = {},
): Layer.Layer<SyncLockShape> {
  if (platform === 'linux' || platform === 'darwin') {
    return Layer.succeed(SyncLock, platforms.posix ?? posixSyncLock)
  }
  if (platform === 'win32') {
    return Layer.succeed(SyncLock, platforms.win32 ?? win32SyncLock)
  }
  return Layer.succeed(SyncLock, unsupportedSyncLock(platform))
}

function unsupportedSyncLock(platform: NodeJS.Platform): SyncLockShape {
  return {
    acquire: (lockPath) =>
      Effect.fail(
        PlatformError.systemError({
          _tag: 'Unknown',
          module: 'SyncLock',
          method: 'syncLock',
          pathOrDescriptor: lockPath,
          description: `kernel-backed profile locking is not supported on ${platform}`,
        }),
      ),
  }
}

/** Every live service the pipeline needs except preflight. */
export function liveServiceLayerFor(
  installation: DiscoveredDshInstallation,
): Layer.Layer<
  PackageManagerShape | DshInstallationShape | SyncLockShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Layer.mergeAll(
    pnpmPackageManagerLayer,
    dshInstallationLayerFor(installation),
    syncLockLayer(),
  )
}
