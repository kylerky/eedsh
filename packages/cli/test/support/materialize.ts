import type { ConfigProvenance } from '@eedsh/config'
import type { ProfilePlan } from '@eedsh/plan'
import { Cause, Effect, Exit, Layer } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import {
  DshInstallation,
  PackageManager,
  Preflight,
  SyncLock,
} from '../../src/internal/effect/services'
import { type MaterializeOptions, materialize } from '../../src/materialize/program'
import { fakeDsh, fakePackageManager, fakePreflight, fakeSyncLock, memoryFileSystem } from './fakes'
import { planOf } from './plan'
import { bundle, generated, insert, layer } from './plan-parts'

/** Absolute profile directory every materialization test publishes into. */
export const PROFILE_DIR = '/home/profiles/work'
/** The profile manifest path. */
export const MANIFEST_PATH = `${PROFILE_DIR}/package.json`
/** The generated package manifest path (the generation record). */
export const RECORD_PATH = `${PROFILE_DIR}/.eedsh/generated/package.json`
/** The stable plan mirror path. */
export const MIRROR_PATH = `${PROFILE_DIR}/.eedsh/plan.json`
/** The dependency specification for the runtime bundle. */
export const RUNTIME_SPEC = 'link:/repo/packages/runtime'
/** The dependency specification for the generated bundle. */
export const GENERATED_SPEC = 'link:./.eedsh/generated'
/** The base bundle the fixture plan selects. */
export const BUNDLE = '@deepseek-ai/dsh-base'

/** The fixture plan: one layer, one managed package, runtime plus generated. */
export function basePlan(): ProfilePlan {
  return planOf({
    name: 'work',
    bundles: [bundle(BUNDLE), generated()],
    layers: [layer('cli', [insert({ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' })])],
    packages: { '@scope/plugin': '1.0.0' },
  })
}

/** The managed bundle order for {@link basePlan}. */
export function managedBundles(): string[] {
  return [BUNDLE, '@eedsh/runtime', '@eedsh/generated']
}

/**
 * A profile manifest that already contains eedsh's managed bundles and
 * packages, so the profile counts as materialized before.
 * @param bundles - the bundle list; defaults to the managed order.
 * @returns the manifest text.
 */
export function managedManifest(bundles: readonly string[] = managedBundles()): string {
  return `${JSON.stringify(
    {
      name: 'dsh-profile-work',
      private: true,
      dsh: { profile: { bundles: [...bundles] } },
      dependencies: {
        '@scope/plugin': '1.0.0',
        '@eedsh/runtime': RUNTIME_SPEC,
        '@eedsh/generated': GENERATED_SPEC,
      },
    },
    null,
    2,
  )}\n`
}

/** Options for {@link harness}. */
export interface HarnessOptions {
  files?: Record<string, string>
  directories?: readonly string[]
  plan?: ProfilePlan
  installFail?: boolean
  preflightFail?: boolean
  provenance?: ConfigProvenance
  configDir?: string
}

/**
 * Materialize against an in-memory profile with fake services.
 * @param options - initial files, directories, and fake-service behavior.
 * @returns the file system, the fakes, and run helpers.
 */
export function harness(options: HarnessOptions = {}) {
  const fs = memoryFileSystem(options.files, {
    ...(options.directories === undefined ? {} : { directories: options.directories }),
  })
  const packages = fakePackageManager({
    ...(options.installFail === undefined ? {} : { fail: options.installFail }),
  })
  const dsh = fakeDsh()
  const preflight = fakePreflight({
    ...(options.preflightFail === undefined ? {} : { fail: options.preflightFail }),
  })
  const lock = fakeSyncLock()
  const layer = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fs.fs),
    Layer.succeed(PackageManager, packages.shape),
    Layer.succeed(DshInstallation, dsh.shape),
    Layer.succeed(Preflight, preflight.shape),
    Layer.succeed(SyncLock, lock.shape),
  )
  function optionsFor(overrides: Partial<MaterializeOptions>): MaterializeOptions {
    return {
      plan: options.plan ?? basePlan(),
      profileDir: PROFILE_DIR,
      eedshVersion: '0.0.0',
      runtimeSpec: RUNTIME_SPEC,
      generatedSpec: GENERATED_SPEC,
      strict: false,
      explain: false,
      ...(options.provenance === undefined ? {} : { provenance: options.provenance }),
      ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
      ...overrides,
    }
  }
  return {
    fs,
    packages,
    dsh,
    preflight,
    lock,
    optionsFor,
    run: (overrides: Partial<MaterializeOptions> = {}) =>
      Effect.runPromise(materialize(optionsFor(overrides)).pipe(Effect.provide(layer))),
    runExit: (overrides: Partial<MaterializeOptions> = {}) =>
      Effect.runPromiseExit(materialize(optionsFor(overrides)).pipe(Effect.provide(layer))),
  }
}

/**
 * Unwrap the failure of a materialization exit.
 * @param exit - the exit to inspect.
 * @returns the squashed failure value.
 */
export function failureOf(exit: Exit.Exit<unknown, unknown>): unknown {
  if (Exit.isSuccess(exit)) throw new Error('expected the materialization to fail')
  return Cause.squash(exit.cause)
}
