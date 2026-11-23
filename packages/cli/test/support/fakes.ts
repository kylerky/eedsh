import { Deferred, Effect, Queue, Sink, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as PlatformError from 'effect/PlatformError'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { SyncLocked } from '../../src/internal/effect/errors'
import type {
  PackageManagerShape,
  PreflightShape,
  SyncLockShape,
  WatcherShape,
} from '../../src/internal/effect/services'
import type { PathEvent } from '../../src/watch'

/** A stat result carrying only the type these tests inspect. */
function fileInfo(type: FileSystem.File.Type): FileSystem.File.Info {
  return { type } as FileSystem.File.Info
}

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
export function memoryFileSystem(
  initial: Record<string, string> = {},
  options: { directories?: readonly string[] } = {},
) {
  const files = new Map(Object.entries(initial))
  const directories = new Set(options.directories ?? [])
  const writeOrder: string[] = []
  const renameOrder: string[] = []
  const createdDirectories: string[] = []
  let writes = 0
  const fs = FileSystem.makeNoop({
    exists: (path) => Effect.succeed(files.has(path) || directories.has(path)),
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
    stat: (path) => {
      if (files.has(path)) return Effect.succeed(fileInfo('File'))
      if (directories.has(path)) return Effect.succeed(fileInfo('Directory'))
      // A path with content below it is a directory even when it was never
      // created through this fake, so a test can seed a bare file map.
      const nested =
        [...files.keys()].some((file) => file.startsWith(`${path}/`)) ||
        [...directories].some((directory) => directory.startsWith(`${path}/`))
      return nested ? Effect.succeed(fileInfo('Directory')) : Effect.fail(notFound('stat', path))
    },
    makeDirectory: (path) => {
      if (!directories.has(path)) createdDirectories.push(path)
      directories.add(path)
      return Effect.void
    },
    remove: (path) => {
      files.delete(path)
      directories.delete(path)
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
  return {
    fs,
    files,
    directories,
    writeOrder,
    renameOrder,
    createdDirectories,
    writeCount: () => writes,
  }
}

/** Sync lock that records acquisition and release, with simulated holders. */
export function fakeSyncLock(options: { held?: boolean; contendedPaths?: readonly string[] } = {}) {
  const heldPaths = new Set<string>()
  const acquires: string[] = []
  const releases: string[] = []
  const contended = options.held ?? false
  const external = new Set(options.contendedPaths ?? [])
  const shape: SyncLockShape = {
    acquire: (lockPath) =>
      Effect.suspend(() => {
        acquires.push(lockPath)
        if (contended || external.has(lockPath) || heldPaths.has(lockPath)) {
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
 * exits with a fixed code, without starting a process. A per-invocation
 * override lets a test answer a probe and a metadata command differently, and
 * a spawn error models a launcher that cannot start.
 */
export function fakeChildProcessSpawner(
  options: {
    exitCode?: number
    stdout?: string
    stderr?: string
    /** Fail the spawn itself instead of returning a handle. */
    spawnError?: PlatformError.PlatformError
    /** Answer one invocation differently from the defaults. */
    resultFor?: (
      command: string,
      args: ReadonlyArray<string>,
    ) => { stdout?: string; stderr?: string; exitCode?: number } | undefined
  } = {},
) {
  const calls: {
    command: string
    args: ReadonlyArray<string>
    cwd: string | undefined
    env: Record<string, string | undefined> | undefined
  }[] = []
  const spawner = ChildProcessSpawner.make((command) => {
    const standard = ChildProcess.isStandardCommand(command)
    if (standard) {
      calls.push({
        command: command.command,
        args: command.args,
        cwd: command.options?.cwd,
        env: command.options?.env,
      })
    }
    if (standard && options.spawnError !== undefined) return Effect.fail(options.spawnError)
    const override = standard ? options.resultFor?.(command.command, command.args) : undefined
    const stdoutText = override?.stdout ?? options.stdout
    const stderrText = override?.stderr ?? options.stderr
    const stdout =
      stdoutText === undefined ? Stream.empty : Stream.make(new TextEncoder().encode(stdoutText))
    const stderr =
      stderrText === undefined ? Stream.empty : Stream.make(new TextEncoder().encode(stderrText))
    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242),
      exitCode: Effect.succeed(
        ChildProcessSpawner.ExitCode(override?.exitCode ?? options.exitCode ?? 0),
      ),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout,
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

/** A fixed stream or a controllable queue-backed subscription for {@link fakeWatcher}. */
export interface FakeWatcherOptions {
  /** A fixed stream returned by every subscription instead of the queue. */
  readonly stream?: Stream.Stream<PathEvent>
  /** Hold a subscription's readiness until this deferred completes. */
  readonly ready?: Deferred.Deferred<void>
  /** Fail the subscription before it is ready, as a watcher start failure. */
  readonly fail?: unknown
  /** Called with the directory once a subscription is ready. */
  readonly onAcquire?: (dir: string) => void
  /** Called with the directory when a subscription's scope closes. */
  readonly onClose?: (dir: string) => void
}

/** A controllable watcher service plus the observations a test asserts on. */
export interface FakeWatcher {
  readonly shape: WatcherShape
  readonly watchCalls: string[]
  readonly closes: string[]
  /** Offer one path event to the queue-backed subscription. */
  emit(event: PathEvent): void
  /** Offer one change event, for tests that only care about a batch. */
  notify(): void
}

/**
 * A watcher whose subscription is a queue: `emit` offers an event on demand,
 * `ready` delays acquisition, and `closes` records every released scope.
 */
export function fakeWatcher(options: FakeWatcherOptions = {}): FakeWatcher {
  const watchCalls: string[] = []
  const closes: string[] = []
  const queue = Effect.runSync(Queue.unbounded<PathEvent>())
  const shape: WatcherShape = {
    watch: (dir) =>
      Effect.gen(function* () {
        watchCalls.push(dir)
        if (options.fail !== undefined) {
          return yield* Effect.fail(
            PlatformError.systemError({
              _tag: 'Unknown',
              module: 'Watcher',
              method: 'watch',
              description:
                options.fail instanceof Error ? options.fail.message : String(options.fail),
              cause: options.fail,
            }),
          )
        }
        if (options.ready !== undefined) yield* Deferred.await(options.ready)
        const events = options.stream ?? Stream.fromQueue(queue)
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            options.onAcquire?.(dir)
          }),
          () =>
            Effect.sync(() => {
              closes.push(dir)
              options.onClose?.(dir)
            }),
        )
        return events
      }),
  }
  return {
    shape,
    watchCalls,
    closes,
    emit: (event) => {
      Queue.offerUnsafe(queue, event)
    },
    notify: () => {
      Queue.offerUnsafe(queue, { kind: 'change', path: 'config.ts' })
    },
  }
}
