import { Effect } from 'effect'
import { FileSystemFailure, SyncLocked } from '../../src/internal/effect/errors'
import type {
  DshInstallationShape,
  FileSystemShape,
  PackageManagerShape,
  PreflightShape,
  SyncLockShape,
} from '../../src/internal/effect/services'

/** In-memory file system matching the materializer's FileSystem service. */
export function memoryFileSystem(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const writeOrder: string[] = []
  const shape: FileSystemShape = {
    exists: (path) => Effect.succeed(files.has(path)),
    readFile: (path) => {
      const value = files.get(path)
      return value === undefined
        ? Effect.fail(new FileSystemFailure({ operation: 'readFile', path, cause: 'ENOENT' }))
        : Effect.succeed(value)
    },
    writeFileAtomic: (path, content) => {
      writeOrder.push(path)
      files.set(path, content)
      return Effect.void
    },
    ensureDir: () => Effect.void,
    remove: (path) => {
      files.delete(path)
      return Effect.void
    },
    rename: (from, to) => {
      const value = files.get(from)
      if (value === undefined) {
        return Effect.fail(
          new FileSystemFailure({ operation: 'rename', path: from, cause: 'ENOENT' }),
        )
      }
      files.delete(from)
      files.set(to, value)
      return Effect.void
    },
  }
  return { shape, files, writeOrder }
}

/** Sync lock that records acquisition and release, with a simulated holder. */
export function fakeSyncLock(options: { held?: boolean } = {}) {
  const heldPaths = new Set<string>()
  const acquires: string[] = []
  const releases: string[] = []
  const contended = options.held ?? false
  const shape: SyncLockShape = {
    acquire: (lockPath) =>
      Effect.suspend(() => {
        acquires.push(lockPath)
        if (contended || heldPaths.has(lockPath)) {
          return Effect.fail(new SyncLocked({ lockPath }))
        }
        heldPaths.add(lockPath)
        let released = false
        return Effect.succeed({
          release: Effect.sync(() => {
            if (released) return
            released = true
            heldPaths.delete(lockPath)
            releases.push(lockPath)
          }),
        })
      }),
  }
  return {
    shape,
    acquires,
    releases,
    isHeld: (lockPath?: string) =>
      lockPath === undefined ? heldPaths.size > 0 : heldPaths.has(lockPath),
  }
}

/** Package manager that records installs and optionally fails or waits. */
export function fakePackageManager(
  options: {
    fail?: boolean
    /** Run before a successful install; used to gate an installation. */
    beforeInstall?: (count: number) => Effect.Effect<void>
  } = {},
) {
  const installs: string[] = []
  const shape: PackageManagerShape = {
    install: (dir) => {
      installs.push(dir)
      if (options.fail) {
        return Effect.fail({
          _tag: 'PackageInstallFailure',
          profileDir: dir,
          cause: 'boom',
        }) as never
      }
      return options.beforeInstall?.(installs.length) ?? Effect.void
    },
  }
  return { shape, installs }
}

/** DSH installation with a fixed bundle layer. */
export function fakeDsh(options: { patches?: Record<string, unknown>[]; version?: string } = {}) {
  const calls: { packageName: string; profileDir: string }[] = []
  const shape: DshInstallationShape = {
    version: options.version ?? '0.2.1-rc.2',
    installAnchor: '/dsh/package.json',
    binPath: '/dsh/lib/bin.js',
    resolveBundlePatches: (packageName, profileDir) => {
      calls.push({ packageName, profileDir })
      return Effect.succeed(options.patches ?? [])
    },
  }
  return { shape, calls }
}

/** Preflight that succeeds with optional warnings or fails with a tagged error. */
export function fakePreflight(options: { fail?: boolean; warnings?: string[] } = {}) {
  const calls: unknown[] = []
  const shape: PreflightShape = {
    check: (input) => {
      calls.push(input)
      if (options.fail) {
        return Effect.fail({
          _tag: 'PreflightFailure',
          message: 'unmatched target',
          warnings: ['patch: entry "missing-row" not found'],
        } as never)
      }
      return Effect.succeed({ warnings: options.warnings ?? [] })
    },
  }
  return { shape, calls }
}
