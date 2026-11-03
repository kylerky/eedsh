import { Effect, Exit, Layer, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as PlatformError from 'effect/PlatformError'
import { describe, expect, it } from 'vitest'
import { PackageInstallFailure, PreflightFailure } from '../../src/internal/effect/errors'
import {
  PackageManager,
  type PackageManagerShape,
  Preflight,
  type PreflightShape,
} from '../../src/internal/effect/services'
import { buildGeneratedBundle } from '../../src/materialize/generated-bundle'
import { reconcileManifest } from '../../src/materialize/manifest'
import { publishProfile } from '../../src/materialize/publish'
import { memoryFileSystem } from '../support/fakes'
import { planOf } from '../support/plan'
import { bundle, generated, insert, layer } from '../support/plan-parts'

const PROFILE_DIR = '/home/profiles/work'
const MANIFEST_PATH = `${PROFILE_DIR}/package.json`
const LOCKFILE_PATH = `${PROFILE_DIR}/pnpm-lock.yaml`
const MIRROR_PATH = `${PROFILE_DIR}/.eedsh/plan.json`
const PROVENANCE_PATH = `${PROFILE_DIR}/.eedsh/provenance.json`
const GENERATED_MANIFEST_PATH = `${PROFILE_DIR}/.eedsh/generated/package.json`

const CONFIG_DIR = '/repo/config'
const PROVENANCE = {
  profiles: {
    work: [
      {
        label: 'cli',
        sites: [{ file: `${CONFIG_DIR}/config.ts`, line: 3, column: 5 }],
      },
    ],
  },
}

const RUNTIME_SPEC = 'link:/repo/packages/runtime'
const GENERATED_SPEC = 'link:./.eedsh/generated'
const BUNDLE = '@deepseek-ai/dsh-base'

const INITIAL_MANIFEST = `${JSON.stringify({ name: 'initial', private: true })}\n`
const INITIAL_LOCK = 'lockfileVersion: 9\n'
const INITIAL_MIRROR = '{"legacy":true}\n'
const INITIAL_PROVENANCE = '{"legacy":true}\n'

function fixture() {
  const plan = planOf({
    name: 'work',
    bundles: [bundle(BUNDLE), generated()],
    layers: [layer('cli', [insert({ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' })])],
  })
  const reconciled = reconcileManifest({
    profileName: 'work',
    plan,
    manifest: Option.none(),
    previous: Option.none(),
    runtimeSpec: RUNTIME_SPEC,
    generatedSpec: GENERATED_SPEC,
  })
  const bundleValue = buildGeneratedBundle({
    plan,
    managedBundles: reconciled.managedBundles,
    packages: reconciled.managedPackages,
    eedshVersion: '0.0.0',
    dshVersion: '0.2.1-rc.2',
  })
  return { plan, reconciled, bundleValue }
}

interface StepState {
  /** The mirror content at the step; the snapshot may already hold a mirror. */
  readonly mirror: string | undefined
  readonly commit: boolean
  readonly plan: boolean
}

interface PublishOptions {
  files?: Record<string, string>
  install?: 'ok' | 'fail'
  preflight?: 'ok' | 'fail'
  /** Fail the first rename to this path. */
  failRenameTo?: string
  onStep?: (step: 'install' | 'preflight', state: StepState) => void
}

function initialFiles(): Record<string, string> {
  return {
    [MANIFEST_PATH]: INITIAL_MANIFEST,
    [LOCKFILE_PATH]: INITIAL_LOCK,
    [MIRROR_PATH]: INITIAL_MIRROR,
    [PROVENANCE_PATH]: INITIAL_PROVENANCE,
  }
}

async function publish(options: PublishOptions = {}) {
  const fs = memoryFileSystem(options.files ?? initialFiles())
  const { plan, reconciled, bundleValue } = fixture()
  // The atomic writer retries a retryable platform error five times, so fail
  // the first six renames to make the write itself fail; the restore that
  // follows then succeeds.
  const attemptsLeft = new Map<string, number>()
  const failingFs: FileSystem.FileSystem = {
    ...fs.fs,
    rename: (from, to) => {
      if (options.failRenameTo === to) {
        const left = attemptsLeft.get(to) ?? 6
        if (left > 0) {
          attemptsLeft.set(to, left - 1)
          return Effect.fail(
            PlatformError.systemError({
              _tag: 'PermissionDenied',
              module: 'FileSystem',
              method: 'rename',
              pathOrDescriptor: to,
            }),
          )
        }
      }
      return fs.fs.rename(from, to)
    },
  }
  const state = (): StepState => ({
    mirror: fs.files.get(MIRROR_PATH),
    commit: fs.files.has(GENERATED_MANIFEST_PATH),
    plan: fs.files.has(`${PROFILE_DIR}/.eedsh/generated/${bundleValue.authoritativePlanPath}`),
  })
  const packages: PackageManagerShape = {
    install: () => {
      options.onStep?.('install', state())
      return options.install === 'fail'
        ? Effect.fail(new PackageInstallFailure({ profileDir: PROFILE_DIR, cause: 'boom' }))
        : Effect.void
    },
  }
  const preflight: PreflightShape = {
    check: () => {
      options.onStep?.('preflight', state())
      return options.preflight === 'fail'
        ? Effect.fail(new PreflightFailure({ message: 'unmatched target', warnings: [] }))
        : Effect.succeed({ warnings: [] })
    },
  }
  const layer = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, failingFs),
    Layer.succeed(PackageManager, packages),
    Layer.succeed(Preflight, preflight),
  )
  const exit = await Effect.runPromiseExit(
    publishProfile({
      plan,
      profileDir: PROFILE_DIR,
      manifest: reconciled.manifest,
      generated: bundleValue,
      previousManifest: Option.some({ name: 'initial', private: true }),
      strict: false,
      explain: false,
      notices: [],
      provenance: PROVENANCE,
      configDir: CONFIG_DIR,
    }).pipe(Effect.provide(layer)),
  )
  return { fs, exit, bundleValue }
}

function expectInitialBytes(fs: ReturnType<typeof memoryFileSystem>): void {
  expect(fs.files.get(MANIFEST_PATH)).toBe(INITIAL_MANIFEST)
  expect(fs.files.get(LOCKFILE_PATH)).toBe(INITIAL_LOCK)
  expect(fs.files.get(MIRROR_PATH)).toBe(INITIAL_MIRROR)
  expect(fs.files.get(PROVENANCE_PATH)).toBe(INITIAL_PROVENANCE)
}

describe('publication ordering', () => {
  it('writes the mirror after preflight and before the commit', async () => {
    const steps: { step: string; state: StepState }[] = []
    const { fs, exit, bundleValue } = await publish({
      onStep: (step, state) => steps.push({ step, state }),
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(steps).toEqual([
      { step: 'install', state: { mirror: INITIAL_MIRROR, commit: false, plan: true } },
      { step: 'preflight', state: { mirror: INITIAL_MIRROR, commit: false, plan: true } },
    ])
    expect(fs.files.get(MIRROR_PATH)).toBe(bundleValue.planContent)
    expect(fs.files.has(GENERATED_MANIFEST_PATH)).toBe(true)
  })

  it('writes the provenance sidecar for the committed generation', async () => {
    const { fs, exit, bundleValue } = await publish()
    expect(Exit.isSuccess(exit)).toBe(true)
    const content = fs.files.get(PROVENANCE_PATH)
    expect(content).toBeDefined()
    expect(JSON.parse(content ?? '{}')).toEqual({
      format: 'eedsh/provenance',
      version: 1,
      generationId: bundleValue.generationId,
      groups: [
        {
          position: 1,
          label: 'cli',
          patches: [{ file: 'config.ts', line: 3, column: 5 }],
        },
      ],
    })
  })

  it('leaves no mirror when nothing was published before', async () => {
    const { fs, exit } = await publish({ files: {} })
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(fs.files.has(MIRROR_PATH)).toBe(true)
  })
})

describe('publication restoration', () => {
  it('restores manifest, lockfile, and mirror after an install failure', async () => {
    const { fs, exit } = await publish({ install: 'fail' })
    expect(Exit.isSuccess(exit)).toBe(false)
    expectInitialBytes(fs)
    expect(fs.files.has(GENERATED_MANIFEST_PATH)).toBe(false)
  })

  it('restores manifest, lockfile, and mirror after a preflight failure', async () => {
    const { fs, exit } = await publish({ preflight: 'fail' })
    expect(Exit.isSuccess(exit)).toBe(false)
    expectInitialBytes(fs)
    expect(fs.files.has(GENERATED_MANIFEST_PATH)).toBe(false)
  })

  it('restores manifest, lockfile, and mirror after a mirror write failure', async () => {
    const { fs, exit } = await publish({ failRenameTo: MIRROR_PATH })
    expect(Exit.isSuccess(exit)).toBe(false)
    expectInitialBytes(fs)
    expect(fs.files.has(GENERATED_MANIFEST_PATH)).toBe(false)
  })

  it('restores manifest, lockfile, mirror, and sidecar after a commit write failure', async () => {
    const { fs, exit } = await publish({ failRenameTo: GENERATED_MANIFEST_PATH })
    expect(Exit.isSuccess(exit)).toBe(false)
    expectInitialBytes(fs)
    expect(fs.files.get(PROVENANCE_PATH)).toBe(INITIAL_PROVENANCE)
    expect(fs.files.has(GENERATED_MANIFEST_PATH)).toBe(false)
  })
})
