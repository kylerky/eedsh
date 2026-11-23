/**
 * The config-directory watcher as a scoped Effect that yields a `Stream` of
 * path events. Acquiring the watch effect starts chokidar and waits for its
 * initial scan, so watch mode can run its first sync against a watcher that is
 * already ready; closing the scope closes the watcher. Interruption is the one
 * stop request.
 * @module @eedsh/cli/watch
 */
import { type FSWatcher, watch } from 'chokidar'
import { Data, Effect, Queue, Stream } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import type * as Scope from 'effect/Scope'
import type { PathEvent } from './internal/effect/services'
import { messageOf } from './internal/error-message'

export type { PathEvent }

/**
 * A watcher failure that happened while closing the subscription. The scope
 * closes during interruption, so the failure cannot become a typed error; it
 * stays a defect carrying the close cause for the process to report once.
 */
export class WatchCloseError extends Data.TaggedError('WatchCloseError')<{
  readonly cause: unknown
}> {
  override get message(): string {
    return messageOf(this.cause)
  }
}

const IGNORED_SEGMENTS = new Set(['node_modules', '.eedsh', '.git'])

function watchStartFailure(dir: string, cause: unknown): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: 'Unknown',
    module: 'Watcher',
    method: 'watch',
    pathOrDescriptor: dir,
    description: messageOf(cause),
    cause,
  })
}

/**
 * Create the chokidar watcher and wire its callbacks into the queue. Events
 * observed during the initial scan are queued; the stream is handed out only
 * after `ready`, so a consumer never sees one before the scan completes.
 */
function createWatcher(dir: string, queue: Queue.Queue<PathEvent>): FSWatcher {
  const watcher = watch(dir, {
    ignoreInitial: true,
    ignored: (path: string) => path.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment)),
  })
  const emit = (kind: PathEvent['kind']) => (path: string) => {
    Queue.offerUnsafe(queue, { kind, path })
  }
  watcher.on('add', emit('add'))
  watcher.on('change', emit('change'))
  watcher.on('unlink', emit('unlink'))
  return watcher
}

/** Resolve once chokidar finished its initial scan. */
function waitForReady(watcher: FSWatcher): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    watcher.once('ready', () => resolve())
    watcher.once('error', (cause: unknown) => reject(cause))
  })
}

/** Close the watcher; a close failure is a defect reported by watch mode. */
function closeWatcher(watcher: FSWatcher): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => watcher.close(),
    catch: (cause) => new WatchCloseError({ cause }),
  }).pipe(Effect.orDie)
}

/**
 * Create the watcher, wait until it is ready, and register its close in the
 * current scope. A failed start releases the watcher that was already created.
 */
function openWatcher(
  dir: string,
  queue: Queue.Queue<PathEvent>,
): Effect.Effect<FSWatcher, PlatformError.PlatformError, Scope.Scope> {
  return Effect.gen(function* () {
    const watcher = yield* Effect.acquireRelease(
      Effect.sync(() => createWatcher(dir, queue)),
      (opened) => closeWatcher(opened),
    )
    yield* Effect.tryPromise({
      try: () => waitForReady(watcher),
      catch: (cause) => watchStartFailure(dir, cause),
    })
    return watcher
  })
}

/**
 * Subscribe to a config directory. The effect completes once the watcher is
 * ready, with a stream that carries every observed add, change, and unlink; the
 * surrounding scope owns the subscription and closes it exactly once.
 * @param dir - directory to watch.
 * @returns the scoped event stream.
 */
export function watchConfigDirectory(
  dir: string,
): Effect.Effect<Stream.Stream<PathEvent>, PlatformError.PlatformError, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<PathEvent>()
    yield* openWatcher(dir, queue)
    return Stream.fromQueue(queue)
  })
}
