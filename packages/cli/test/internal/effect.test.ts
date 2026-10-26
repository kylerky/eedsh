import { bundle, insert, type ProfilePlan, layer as planLayer } from '@eedsh/config'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Effect, Layer } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { writeFileAtomic } from '../../src/internal/atomic-write'
import {
  DshInstallation,
  PackageManager,
  type PackageManagerShape,
  Preflight,
  type PreflightShape,
  SyncLock,
} from '../../src/internal/effect/services'
import { materialize } from '../../src/materialize/program'
import {
  fakeDsh,
  fakePackageManager,
  fakePreflight,
  fakeSyncLock,
  memoryFileSystem,
} from '../support/fakes'
import { planOf } from '../support/plan'

const profileDir = '/profiles/work'
const runtimeSpec = 'link:/repo/packages/runtime'
const generatedSpec = 'link:./.eedsh/generated'
const manifestPath = `${profileDir}/package.json`
const lockfilePath = `${profileDir}/pnpm-lock.yaml`
const lockPath = `${profileDir}/.eedsh/sync.lock`
const generatedManifestPath = `${profileDir}/.eedsh/generated/package.json`

function fixturePlan(): ProfilePlan {
  return planOf({
    name: 'work',
    dsh: '0.2.1-rc.2',
    bundles: [bundle('@deepseek-ai/dsh-base')],
    layers: [
      planLayer('base', [insert({ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' })]),
    ],
    packages: { '@scope/plugin': '1.0.0' },
  })
}

interface HarnessOptions {
  files?: Record<string, string>
  plan?: ProfilePlan
  packages?: PackageManagerShape
  preflight?: PreflightShape
  lock?: ReturnType<typeof fakeSyncLock>
}

function harness(options: HarnessOptions = {}) {
  const fs = memoryFileSystem(options.files)
  const packages = options.packages ?? fakePackageManager().shape
  const preflight = options.preflight ?? fakePreflight().shape
  const dsh = fakeDsh().shape
  const lock = options.lock ?? fakeSyncLock()
  const layer = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fs.fs),
    Layer.succeed(PackageManager, packages),
    Layer.succeed(DshInstallation, dsh),
    Layer.succeed(Preflight, preflight),
    Layer.succeed(SyncLock, lock.shape),
  )
  const program = materialize({
    plan: options.plan ?? fixturePlan(),
    profileDir,
    eedshVersion: '0.0.0',
    runtimeSpec,
    generatedSpec,
    strict: false,
    explain: false,
  }).pipe(Effect.provide(layer))
  return { fs, lock, program }
}

async function failureOf(effect: Effect.Effect<unknown, unknown>): Promise<any> {
  const result = await Effect.runPromise(Effect.result(effect))
  if (Result.isSuccess(result)) throw new Error('expected the effect to fail')
  return result.failure
}

describe('Effect materialization', () => {
  it('publishes the generated bundle and reconciles the manifest', async () => {
    const packages = fakePackageManager()
    const preflight = fakePreflight({ warnings: ['warning one'] })
    const test = harness({ packages: packages.shape, preflight: preflight.shape })
    const result = await Effect.runPromise(test.program)

    expect(result.changed).toBe(true)
    expect(result.generationId).toMatch(/^[0-9a-f]{64}$/)
    expect(result.warnings).toEqual(['warning one'])
    expect(result.createdProfile).toBe(true)
    expect(packages.installs).toEqual([profileDir])
    expect(preflight.calls).toHaveLength(1)

    const manifest = JSON.parse(test.fs.files.get(manifestPath) ?? '{}')
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@eedsh/runtime',
      '@eedsh/generated',
    ])
    expect(manifest.dependencies).toMatchObject({
      '@scope/plugin': '1.0.0',
      '@eedsh/runtime': runtimeSpec,
      '@eedsh/generated': generatedSpec,
    })

    const generated = JSON.parse(test.fs.files.get(generatedManifestPath) ?? '{}')
    expect(generated.eedsh.generationId).toBe(result.generationId)
    expect(generated.dsh.bundle.patch).toHaveLength(1)
    expect(test.fs.files.has(`${profileDir}/.eedsh/plan.json`)).toBe(true)
    expect(test.fs.files.has(`${profileDir}/cordis.patch.yml`)).toBe(true)
    expect(test.fs.files.has(lockPath)).toBe(false)
    expect(test.fs.renameOrder.at(-1)).toBe(generatedManifestPath)
    expect(test.lock.acquires).toEqual([lockPath])
    expect(test.lock.releases).toEqual([lockPath])
    expect(test.lock.isHeld()).toBe(false)
  })

  it('is a no-op for an unchanged plan', async () => {
    const packages = fakePackageManager()
    const test = harness({ packages: packages.shape })
    await Effect.runPromise(test.program)
    const published = new Map(test.fs.files)
    const second = await Effect.runPromise(test.program)
    expect(second.changed).toBe(false)
    expect(new Map(test.fs.files)).toEqual(published)
    expect(packages.installs).toEqual([profileDir])
  })

  it('publishes changed layers without reinstalling unchanged dependencies', async () => {
    const packages = fakePackageManager()
    const first = harness({ packages: packages.shape })
    const firstRun = await Effect.runPromise(first.program)
    const publishedManifest = first.fs.files.get(manifestPath)

    const changedPlan = planOf({
      name: 'work',
      dsh: '0.2.1-rc.2',
      bundles: [bundle('@deepseek-ai/dsh-base')],
      layers: [
        planLayer('base', [
          insert({
            id: 'timer',
            name: '@deepseek-ai/cordis-plugin-timer',
            config: { interval: 1000 },
          }),
        ]),
      ],
      packages: { '@scope/plugin': '1.0.0' },
    })
    const second = harness({
      files: Object.fromEntries(first.fs.files),
      packages: packages.shape,
      plan: changedPlan,
    })
    const secondRun = await Effect.runPromise(second.program)

    expect(secondRun.changed).toBe(true)
    expect(secondRun.generationId).not.toBe(firstRun.generationId)
    expect(packages.installs).toEqual([profileDir])
    expect(second.fs.files.get(manifestPath)).toBe(publishedManifest)

    const generated = JSON.parse(second.fs.files.get(generatedManifestPath) ?? '{}')
    expect(generated.eedsh.generationId).toBe(secondRun.generationId)
  })

  it('fails with a tagged preflight failure and restores manifest and lockfile', async () => {
    const initialManifest = '{"name":"existing","dsh":{"profile":{"bundles":[]}}}\n'
    const initialLock = 'lockfile-version: 9\n'
    const test = harness({
      files: { [manifestPath]: initialManifest, [lockfilePath]: initialLock },
      preflight: fakePreflight({ fail: true }).shape,
    })
    const error = await failureOf(test.program)
    expect(error._tag).toBe('PreflightFailure')
    expect(test.fs.files.get(manifestPath)).toBe(initialManifest)
    expect(test.fs.files.get(lockfilePath)).toBe(initialLock)
    expect(test.fs.files.has(generatedManifestPath)).toBe(false)
    expect(test.fs.files.has(lockPath)).toBe(false)
    expect(test.lock.acquires).toEqual([lockPath])
    expect(test.lock.releases).toEqual([lockPath])
    expect(test.lock.isHeld()).toBe(false)
  })

  it('restores manifest and lockfile after a package failure', async () => {
    const initialManifest = '{"name":"existing"}\n'
    const initialLock = 'lockfile-version: 9\n'
    const test = harness({
      files: { [manifestPath]: initialManifest, [lockfilePath]: initialLock },
      packages: fakePackageManager({ fail: true }).shape,
    })
    const error = await failureOf(test.program)
    expect(error._tag).toBe('PackageInstallFailure')
    expect(test.fs.files.get(manifestPath)).toBe(initialManifest)
    expect(test.fs.files.get(lockfilePath)).toBe(initialLock)
    expect(test.fs.files.has(generatedManifestPath)).toBe(false)
    expect(test.fs.files.has(lockPath)).toBe(false)
    expect(test.lock.acquires).toEqual([lockPath])
    expect(test.lock.releases).toEqual([lockPath])
    expect(test.lock.isHeld()).toBe(false)
  })

  it('maps a malformed profile manifest to a platform parse error', async () => {
    const test = harness({ files: { [manifestPath]: '{' } })
    const error = await failureOf(test.program)
    expect(PlatformError.isPlatformError(error)).toBe(true)
    expect(error.reason.method).toBe('parseJson')
    expect(error.reason.pathOrDescriptor).toBe(manifestPath)
  })

  it('removes a lockfile it had to create when restoring', async () => {
    const test = harness({ preflight: fakePreflight({ fail: true }).shape })
    await failureOf(test.program)
    expect(test.fs.files.has(lockfilePath)).toBe(false)
    expect(test.fs.files.has(manifestPath)).toBe(false)
  })

  it('refuses to enter the transaction while the lock is held', async () => {
    const lock = fakeSyncLock({ held: true })
    const test = harness({ lock })
    const error = await failureOf(test.program)
    expect(error._tag).toBe('SyncLocked')
    expect(error.lockPath).toBe(lockPath)
    expect(test.fs.files.has(manifestPath)).toBe(false)
    expect(lock.acquires).toEqual([lockPath])
    expect(lock.releases).toEqual([])
  })
})
describe('atomic write', () => {
  it('replaces a file without leaving temporary files', async () => {
    const { mkdir, mkdtemp, readdir, readFile, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true })
    const dir = await mkdtemp(join(process.cwd(), '.tmp', 'atomic-'))
    const target = join(dir, 'file.json')
    await writeFile(target, 'old')
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* writeFileAtomic(fs, target, 'new')
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    )
    expect(await readFile(target, 'utf8')).toBe('new')
    expect(await readdir(dir)).toEqual(['file.json'])
  })
})
