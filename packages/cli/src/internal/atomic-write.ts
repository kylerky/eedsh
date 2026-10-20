/**
 * Atomic file replacement: write a same-directory temporary file, then rename
 * it over the target. Windows may briefly refuse the rename while another
 * process holds the target, so retryable errors are retried.
 * @module @eedsh/cli/internal/atomic-write
 */
import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const RETRYABLE = new Set(['EACCES', 'EBUSY', 'EPERM'])
const RETRY_LIMIT = 5
const RETRY_DELAY_MS = 50

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= RETRY_LIMIT || code === undefined || !RETRYABLE.has(code)) throw error
      await delay(RETRY_DELAY_MS)
    }
  }
}

/**
 * Replace a file atomically.
 * @param path - absolute target path.
 * @param content - UTF-8 content.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(temp, content, 'utf8')
  try {
    await renameWithRetry(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
