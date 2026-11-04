import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type WatchSession, watchConfigDirectory } from '../src/watch'
import { delay, waitFor } from './support/async'

const root = process.cwd()
const tempRoot = join(root, 'packages/cli/.tmp')
const sessions: WatchSession[] = []

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})

describe('config directory watcher', () => {
  it('ignores node_modules and watches the config project', async () => {
    await mkdir(tempRoot, { recursive: true })
    const dir = await mkdtemp(join(tempRoot, 'watch-ignore-'))
    await writeFile(join(dir, 'config.ts'), 'export default 1\n')
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })

    let changes = 0
    const session = await watchConfigDirectory({
      dir,
      onChange: () => {
        changes += 1
      },
      debounceMs: 20,
    })
    sessions.push(session)

    // A native watcher can deliver delayed notifications for the files created
    // before it started; wait for that initial burst to settle.
    await delay(300)
    const settled = changes

    await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'export default 2\n')
    await delay(500)
    expect(changes).toBe(settled)

    await writeFile(join(dir, 'config.ts'), 'export default 2\n')
    expect(await waitFor(() => changes > settled)).toBe(true)
  })
})
