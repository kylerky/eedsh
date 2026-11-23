import { join } from 'node:path'
import { Effect, Layer, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { describe, expect, it } from 'vitest'
import { readPackageManifest } from '../../src/installation-anchor'
import { findTsconfigPath, TSCONFIG_FILENAME } from '../../src/internal/tsconfig'
import { memoryFileSystem } from '../support/fakes'

const work = join('/virtual', 'work')
const nested = join(work, 'src', 'config')
const tsconfigPath = join(work, TSCONFIG_FILENAME)

function run<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
  fs: FileSystem.FileSystem,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, fs))))
}

describe('FileSystem-backed readers', () => {
  it('finds the nearest tsconfig through the provided filesystem only', async () => {
    const { fs } = memoryFileSystem({ [tsconfigPath]: '{}\n' }, { directories: [nested] })
    const configPath = join(nested, 'config.ts')
    const found = await run(findTsconfigPath(configPath), fs)
    expect(found).toEqual(Option.some(tsconfigPath))
  })

  it('does not fall back to the process filesystem', async () => {
    // The repository has a real tsconfig above this (virtual) path; a reader
    // that touched the process filesystem would find it.
    const { fs } = memoryFileSystem({}, { directories: [nested] })
    const found = await run(findTsconfigPath(join(nested, 'config.ts')), fs)
    expect(found).toEqual(Option.none())
  })

  it('reads a package manifest through the provided filesystem', async () => {
    const manifestPath = join(work, 'package.json')
    const { fs } = memoryFileSystem({
      [manifestPath]: JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1' }),
    })
    const manifest = await run(readPackageManifest(manifestPath), fs)
    expect(manifest).toMatchObject({ name: '@deepseek-ai/dsh', version: '0.2.1' })
  })

  it('treats an unreadable manifest as absent', async () => {
    const { fs } = memoryFileSystem()
    const manifest = await run(readPackageManifest(join(work, 'package.json')), fs)
    expect(manifest).toBeUndefined()
  })
})
