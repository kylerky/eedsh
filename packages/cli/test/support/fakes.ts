import { Effect, Sink, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as PlatformError from 'effect/PlatformError'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { SyncLocked } from '../../src/internal/effect/errors'
import type {
  DshInstallationShape,
  PackageManagerShape,
  PreflightShape,
  SyncLockShape,
} from '../../src/internal/effect/services'

function notFound(method: string, path: string): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: 'NotFound',
    module: 'FileSystem',
    method,
    pathOrDescriptor: path,
  })
}

/**
 * In-memory core FileSystem. Only the operations a test exercises need to be
 * functional; the rest keep the no-op defaults.
 */
export function memoryFileSystem(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const writeOrder: string[] = []
  const renameOrder: string[] = []
  let writes = 0
  const fs = FileSystem.makeNoop({
    exists: (path) => Effect.succeed(files.has(path)),
    readFileString: (path) => {
      const value = files.get(path)
      return value === undefined
        ? Effect.fail(notFound('readFileString', path))
        : Effect.succeed(value)
    },
    writeFileString: (path, content) => {
      writes += 1
      writeOrder.push(path)
      files.set(path, content)
      return Effect.void
    },
    makeDirectory: () => Effect.void,
    remove: (path) => {
      files.delete(path)
      return Effect.void
    },
    rename: (from, to) => {
      const value = files.get(from)
      if (value === undefined) return Effect.fail(notFound('rename', from))
      renameOrder.push(to)
      files.delete(from)
      files.set(to, value)
      return Effect.void
    },
  })
  return { fs, files, writeOrder, renameOrder, writeCount: () => writes }
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

/**
 * Child-process spawner that records the commands it is asked to run and
 * exits with a fixed code, without starting a process.
 */
export function fakeChildProcessSpawner(options: { exitCode?: number; stderr?: string } = {}) {
  const calls: { command: string; args: ReadonlyArray<string>; cwd: string | undefined }[] = []
  const spawner = ChildProcessSpawner.make((command) => {
    if (ChildProcess.isStandardCommand(command)) {
      calls.push({ command: command.command, args: command.args, cwd: command.options?.cwd })
    }
    const stderr =
      options.stderr === undefined
        ? Stream.empty
        : Stream.make(new TextEncoder().encode(options.stderr))
    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    })
    return Effect.succeed(handle)
  })
  return { spawner, calls }
}
