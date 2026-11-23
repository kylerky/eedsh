/**
 * The `sync --watch` file watcher. It watches the config directory (not
 * transitive imports outside it) and debounces bursts of editor writes. The
 * stop request is the invocation's interruption seam until watch mode becomes a
 * `Stream`.
 * @module @eedsh/cli/watch
 */
import { watch } from 'chokidar'
import { Effect } from 'effect'

/** A live watch registration. */
export interface WatchSession {
  close(): Promise<void>
}

/** Inputs for {@link watchConfigDirectory}. */
export interface WatchConfigDirectoryInput {
  /** Directory to watch. */
  dir: string
  /** Called after a debounced batch of changes. */
  onChange: () => void
  /** Debounce window in milliseconds. */
  debounceMs?: number
}

const IGNORED_SEGMENTS = new Set(['node_modules', '.eedsh', '.git'])

/**
 * Watch a config directory for additions, edits, and removals.
 * @param input - directory, change callback, and debounce window.
 * @returns a session that closes the watcher.
 */
export async function watchConfigDirectory(
  input: WatchConfigDirectoryInput,
): Promise<WatchSession> {
  const watcher = watch(input.dir, {
    ignoreInitial: true,
    ignored: (path: string) => path.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment)),
  })

  let timer: NodeJS.Timeout | undefined
  const notify = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      input.onChange()
    }, input.debounceMs ?? 150)
  }
  watcher.on('add', notify)
  watcher.on('change', notify)
  watcher.on('unlink', notify)

  await new Promise<void>((resolve, reject) => {
    watcher.once('ready', () => resolve())
    watcher.once('error', reject)
  })

  return {
    close: async () => {
      if (timer !== undefined) clearTimeout(timer)
      await watcher.close()
    },
  }
}

/**
 * A stop request from an injected `AbortSignal`, SIGINT, or SIGTERM.
 * @param signal - an explicit abort signal, when the caller has one.
 * @returns an effect that completes when the session should stop.
 */
export function stopSignal(signal: AbortSignal | undefined): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (signal !== undefined) {
      if (signal.aborted) {
        resume(Effect.void)
        return
      }
      const onAbort = () => resume(Effect.void)
      signal.addEventListener('abort', onAbort, { once: true })
      return Effect.sync(() => signal.removeEventListener('abort', onAbort))
    }
    const onSignal = () => resume(Effect.void)
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    return Effect.sync(() => {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    })
  })
}
