import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { type AtomicWriteIo, writeFileAtomic } from '../../src/internal/atomic-write'

const tempRoot = join(process.cwd(), '.tmp')
const dirs: string[] = []

async function tempTarget(): Promise<{ dir: string; target: string }> {
  await mkdir(tempRoot, { recursive: true })
  const dir = await mkdtemp(join(tempRoot, 'atomic-write-'))
  dirs.push(dir)
  return { dir, target: join(dir, 'profile.json') }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function failureOf(effect: Effect.Effect<unknown, unknown>): Promise<any> {
  const result = await Effect.runPromise(Effect.either(effect))
  if (result._tag === 'Right') throw new Error('expected the effect to fail')
  return result.left
}

describe('writeFileAtomic', () => {
  it('replaces the target and leaves only the target behind', async () => {
    const { dir, target } = await tempTarget()
    await writeFile(target, 'old', 'utf8')

    await Effect.runPromise(writeFileAtomic(target, 'new'))

    expect(await readFile(target, 'utf8')).toBe('new')
    expect(await readdir(dir)).toEqual(['profile.json'])
  })

  it('removes a partial temporary file and keeps the target when the write fails', async () => {
    const { dir, target } = await tempTarget()
    await writeFile(target, 'old', 'utf8')
    let tempPath: string | undefined
    const io: AtomicWriteIo = {
      writeFile: async (path, content) => {
        tempPath = path
        await writeFile(path, content.slice(0, 3), 'utf8')
        throw new Error('disk full')
      },
      rename: async () => {
        throw new Error('rename must not run after a failed write')
      },
      remove: (path) => rm(path, { force: true }),
    }

    const failure = await failureOf(writeFileAtomic(target, 'new', io))

    expect(failure).toMatchObject({
      _tag: 'FileSystemFailure',
      operation: 'writeFileAtomic',
      path: target,
    })
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readdir(dir)).toEqual(['profile.json'])
    expect(tempPath).toBeDefined()
    expect(existsSync(tempPath as string)).toBe(false)
  })

  it('removes the temporary file and keeps the target when the rename fails', async () => {
    const { dir, target } = await tempTarget()
    await writeFile(target, 'old', 'utf8')
    const io: AtomicWriteIo = {
      writeFile: (path, content) => writeFile(path, content, 'utf8'),
      rename: async () => {
        throw new Error('rename failed')
      },
      remove: (path) => rm(path, { force: true }),
    }

    const failure = await failureOf(writeFileAtomic(target, 'new', io))

    expect(failure).toMatchObject({
      _tag: 'FileSystemFailure',
      operation: 'writeFileAtomic',
      path: target,
    })
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readdir(dir)).toEqual(['profile.json'])
  })

  it('passes an AbortSignal to the write', async () => {
    const { target } = await tempTarget()
    const signals: AbortSignal[] = []
    const io: AtomicWriteIo = {
      writeFile: async (_path, _content, signal) => {
        signals.push(signal)
      },
      rename: async () => undefined,
      remove: async () => undefined,
    }

    await Effect.runPromise(writeFileAtomic(target, 'new', io))

    expect(signals).toHaveLength(1)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })
})
