/**
 * The `sync --watch` file watcher. It watches the config directory (not
 * transitive imports outside it) and debounces bursts of editor writes.
 * @module @eedsh/cli/watch
 */
import { watch } from 'chokidar'

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
