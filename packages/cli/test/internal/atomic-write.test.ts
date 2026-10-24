import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from '../../src/internal/atomic-write'

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
  const result = await Effect.runPromise(Effect.result(effect))
  if (Result.isSuccess(result)) throw new Error('expected the effect to fail')
  return result.failure
}

function platformFailure(method: string, path: string, cause: unknown): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: 'Unknown',
    module: 'FileSystem',
    method,
    pathOrDescriptor: path,
    cause,
  })
}

function realFileSystem(): Effect.Effect<FileSystem.FileSystem> {
  return Effect.gen(function* () {
    return yield* FileSystem.FileSystem
  }).pipe(Effect.provide(NodeFileSystem.layer))
}

describe('writeFileAtomic', () => {
  it('replaces the target and leaves only the target behind', async () => {
    const { dir, target } = await tempTarget()
    await writeFile(target, 'old', 'utf8')
    const fs = await Effect.runPromise(realFileSystem())

    await Effect.runPromise(writeFileAtomic(fs, target, 'new'))

    expect(await readFile(target, 'utf8')).toBe('new')
    expect(await readdir(dir)).toEqual(['profile.json'])
  })

  it('removes a partial temporary file and keeps the target when the write fails', async () => {
    const { dir, target } = await tempTarget()
    await writeFile(target, 'old', 'utf8')
    let tempPath: string | undefined
    const fs = FileSystem.makeNoop({
      writeFileString: (path, content) =>
        Effect.tryPromise({
          try: async () => {
            tempPath = path
            await writeFile(path, content.slice(0, 3), 'utf8')
            throw new Error('disk full')
          },
          catch: (cause) => platformFailure('writeFileString', path, cause),
        }),
      rename: () => Effect.die('rename must not run after a failed write'),
      remove: (path) =>
        Effect.tryPromise({
          try: () => rm(path, { force: true }),
          catch: (cause) => platformFailure('remove', path, cause),
        }),
    })

    const failure = await failureOf(writeFileAtomic(fs, target, 'new'))

    expect(PlatformError.isPlatformError(failure)).toBe(true)
    expect(failure.reason.method).toBe('writeFileString')
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readdir(dir)).toEqual(['profile.json'])
    expect(tempPath).toBeDefined()
    expect(existsSync(tempPath as string)).toBe(false)
  })

  it('removes the temporary file and keeps the target when the rename fails', async () => {
    const { dir, target } = await tempTarget()
    await writeFile(target, 'old', 'utf8')
    const fs = FileSystem.makeNoop({
      writeFileString: (path, content) => Effect.promise(() => writeFile(path, content, 'utf8')),
      rename: (from, to) =>
        Effect.fail(platformFailure('rename', from, new Error(`cannot rename ${from} to ${to}`))),
      remove: (path) => Effect.promise(() => rm(path, { force: true })),
    })

    const failure = await failureOf(writeFileAtomic(fs, target, 'new'))

    expect(PlatformError.isPlatformError(failure)).toBe(true)
    expect(failure.reason.method).toBe('rename')
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readdir(dir)).toEqual(['profile.json'])
  })
})
