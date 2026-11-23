import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ConfigProvenance } from '@eedsh/config'
import { type EedshConfig, type ProfilePlan, validateConfigValue } from '@eedsh/plan'
import { Cause, Deferred, Effect, Exit, Layer } from 'effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { beforeAll, describe, expect, it } from 'vitest'
import { readmeExample } from '../../../test/support/readme'
import { ConfigError, type LoadedConfig } from '../src/config'
import { DshFailure } from '../src/internal/effect/errors'
import { type CliServices, Output } from '../src/internal/effect/services'
import { WatchCloseError } from '../src/watch'
import { delay, waitFor } from './support/async'
import { devDshInstallation, installTestBridge } from './support/bridge'
import {
  type CliOverrides,
  captureOutput,
  fakeBundleResolver,
  fakeConfigLoader,
  fakeDshDiscovery,
  forkCli,
  interruptCli,
  realFileSystem,
  runCli,
} from './support/cli'
import {
  fakeChildProcessSpawner,
  fakePackageManager,
  fakePreflight,
  fakeSyncLock,
  fakeWatcher,
  memoryFileSystem,
} from './support/fakes'
import { planOf } from './support/plan'
import { bundle, generated, insert, layer, override } from './support/plan-parts'
import { fakeSpawner } from './support/process'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const fixture = (name: string) => join(root, 'packages/cli/test/fixtures', name, 'config.ts')
// The CLI resolves DSH_HOME, so expectations must use the same platform path.
const homeRoot = resolve('/home')
const homePath = (...parts: string[]) => join(homeRoot, ...parts)
const generatedPath = (profile: string) =>
  homePath('profiles', profile, '.eedsh', 'generated', 'package.json')
const generatedManifest = generatedPath('cli-fixture')

/** Wrap one validated config for the injected loader seam. */
function loaded(config: EedshConfig, provenance?: ConfigProvenance) {
  return { config, provenance, configDir: join(root, 'packages/cli/test/fixtures') }
}

/** Wrap validated plans in a config for the injected loader seam. */
function configWith(...plans: ProfilePlan[]): EedshConfig {
  return {
    profiles: Object.fromEntries(plans.map((plan) => [plan.profile.name, Result.succeed(plan)])),
  }
}

/** Whether an invocation settled because its fiber was interrupted. */
function interrupted(exit: Exit.Exit<number, never>): boolean {
  return Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
}

function hasAnsi(text: string): boolean {
  return new RegExp(`${String.fromCharCode(27)}[[][0-9;]*m`).test(text)
}

const tempRoot = join(root, 'packages/cli/.tmp')

async function tempDir(prefix: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  return mkdtemp(join(tempRoot, prefix))
}

function watchConfigSource(row: string): string {
  return `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('cli-watch', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
      .layer('cli', (layer) => {
        layer.insert({ id: '${row}', name: '@scope/${row}' })
      })
  })
  .build()
`
}

interface HarnessOptions {
  files?: Record<string, string>
  basePatches?: Record<string, unknown>[]
  preflight?: { fail?: boolean; warnings?: string[] }
  packages?: { fail?: boolean; beforeInstall?: (count: number) => Effect.Effect<void> }
  realPreflight?: boolean
  lockHeld?: boolean
  lockContendedPaths?: readonly string[]
  discoveryFails?: boolean
}

/** The environment every harness invocation reads unless a test overrides it. */
const harnessEnv = { DSH_HOME: '/home', XDG_CONFIG_HOME: '/home/xdg' }

/** `check` inspects real project files, so its runs use the live filesystem. */
const realFiles = { extra: [realFileSystem] }

/** The installation anchor every harness invocation reads, without touching the machine. */
const harnessAnchor: NonNullable<CliOverrides['anchor']> = {
  read: () => Effect.succeed(undefined),
  write: () => Effect.succeed({ ok: true } as const),
}

/** Widen one test layer that provides a single CLI service to the full service type. */
function asCliServiceLayer<A, E, R>(provided: Layer.Layer<A, E, R>): Layer.Layer<CliServices> {
  return provided as Layer.Layer<CliServices>
}

function harness(options: HarnessOptions = {}) {
  const fs = memoryFileSystem(options.files)
  const packages = fakePackageManager(options.packages)
  const resolver = fakeBundleResolver({ patches: options.basePatches ?? [] })
  const preflight = fakePreflight(options.preflight)
  const lock = fakeSyncLock(
    options.lockContendedPaths === undefined
      ? { held: options.lockHeld ?? false }
      : { held: options.lockHeld ?? false, contendedPaths: options.lockContendedPaths },
  )
  const out: string[] = []
  const err: string[] = []
  let constructions = 0
  let finalizers = 0
  // The composed layer is built once per invocation and released when that
  // invocation ends. The counting output service stands in for it: a run that
  // acquires the layer must release it exactly once.
  const countingOutput = asCliServiceLayer(
    Layer.effect(
      Output,
      Effect.acquireRelease(
        Effect.sync(() => {
          constructions += 1
          return captureOutput(out, err)
        }),
        () =>
          Effect.sync(() => {
            finalizers += 1
          }),
      ),
    ),
  )
  const discovery =
    options.discoveryFails === true
      ? fakeDshDiscovery(devDshInstallation(), {
          discover: () =>
            Effect.succeed(
              Result.fail(
                new DshFailure({
                  code: 'dsh.not_found',
                  message: 'cannot resolve a DSH installation for this invocation',
                }),
              ),
            ),
        })
      : fakeDshDiscovery(devDshInstallation())
  const base: CliOverrides = {
    environment: { env: harnessEnv, cwd: root },
    discovery,
    bundleResolver: resolver,
    packageManager: packages.shape,
    syncLock: lock.shape,
    anchor: harnessAnchor,
    fileSystem: fs.fs,
    childProcessSpawner: fakeChildProcessSpawner().spawner,
    ...(options.realPreflight === true ? {} : { preflight: preflight.shape }),
    extra: [countingOutput],
  }
  const layered = (overrides: CliOverrides): CliOverrides => ({
    ...base,
    ...overrides,
    extra: [...(overrides.extra ?? []), ...(base.extra ?? [])],
  })
  const run = (argv: readonly string[], overrides: CliOverrides = {}) =>
    runCli(argv, layered(overrides))
  const fork = (argv: readonly string[], overrides: CliOverrides = {}) =>
    forkCli(argv, layered(overrides))
  return {
    fs,
    packages,
    preflight,
    lock,
    out,
    err,
    run,
    fork,
    constructions: () => constructions,
    finalizers: () => finalizers,
  }
}

beforeAll(async () => {
  if (!existsSync(join(root, 'packages/config/lib/index.js'))) {
    await execFileAsync('pnpm', ['--filter', '@eedsh/config', 'build'], {
      cwd: root,
      shell: process.platform === 'win32',
    })
  }
  await installTestBridge()
}, 120_000)

describe('eedsh sync', () => {
  it('loads a TypeScript config and publishes the profile', async () => {
    const h = harness()
    const code = await h.run(['sync', '--config', fixture('basic')])
    expect(code).toBe(0)
    expect(h.fs.files.has(generatedManifest)).toBe(true)
    expect(h.packages.installs).toEqual([homePath('profiles', 'cli-fixture')])
    expect(h.out.join('\n')).toContain('cli-fixture')
    expect(h.err.join('\n')).not.toContain('eedsh:')
  })

  it('reports the native validation message for an invalid config and exits 1', async () => {
    const h = harness()
    const code = await h.run(['sync', '--config', fixture('invalid')])
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('"@eedsh/runtime" is owned by the materializer')
    expect(errors).toMatch(/at \["bundles"\]\[0\]\["name"\]/)
    expect(errors).not.toContain('profile.name:')
    expect(errors).not.toMatch(/\(\d+ more\)/)
    expect(h.fs.files.size).toBe(0)
  })

  it('prints every native schema error line without reformatting', async () => {
    const h = harness()
    const decoded = validateConfigValue({
      profiles: { 'bad/name': { bundles: [] } },
    })
    if (Result.isSuccess(decoded)) throw new Error('expected an invalid config')
    const failure = decoded.failure
    if (!Schema.isSchemaError(failure)) throw new Error('expected a schema error')
    const loadConfig = (): Effect.Effect<never, Schema.SchemaError> =>
      Effect.fail(new Schema.SchemaError(failure.issue))
    const code = await h.run(['sync', '--config', fixture('basic')], {
      configLoader: fakeConfigLoader(loadConfig),
    })
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('eedsh: profile key "bad/name" is not usable as a profile directory')
    expect(errors).toMatch(/eedsh: {3}at \["profiles"\]\["bad\/name"\]/)
    expect(errors).not.toContain('profile.name:')
    expect(errors).not.toMatch(/\(\d+ more\)/)
    expect(h.fs.files.size).toBe(0)
  })

  it('reports a missing config file with exit 1', async () => {
    const h = harness()
    const code = await h.run(['sync', '--config', join(root, 'nope/config.ts')])
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('eedsh:')
  })
})

describe('explicit config paths', () => {
  const rejected = [
    { dir: 'javascript-mjs', name: 'config.mjs' },
    { dir: 'javascript-js', name: 'config.js' },
  ] as const

  for (const { dir, name } of rejected) {
    it(`rejects an explicit ${name} config before evaluation`, async () => {
      const h = harness()
      const path = join(root, 'packages/cli/test/fixtures', dir, name)
      const code = await h.run(['sync', '--config', path])
      expect(code).toBe(1)
      const errors = h.err.join('\n')
      expect(errors).toContain('config.unsupported_extension')
      expect(errors).toContain('config.ts')
      expect(h.fs.files.size).toBe(0)
    })
  }
})

describe('XDG config resolution', () => {
  const source = `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('xdg-profile', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
  })
  .build()
`

  async function xdgHome(): Promise<string> {
    const home = await tempDir('xdg-home-')
    await mkdir(join(home, 'eedsh'), { recursive: true })
    return home
  }

  async function writeXdgConfig(home: string): Promise<string> {
    const path = join(home, 'eedsh', 'config.ts')
    await writeFile(path, source)
    return path
  }

  it('loads config.ts from XDG_CONFIG_HOME instead of the working directory', async () => {
    const home = await xdgHome()
    const configPath = await writeXdgConfig(home)
    const h = harness({ files: { [configPath]: source } })
    const cwd = await tempDir('xdg-cwd-')
    await writeFile(join(cwd, 'eedsh.config.ts'), source)

    const code = await h.run(['sync'], {
      environment: { env: { ...harnessEnv, XDG_CONFIG_HOME: home }, cwd },
    })
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile xdg-profile')
    expect(h.fs.files.has(generatedPath('xdg-profile'))).toBe(true)
    expect(configPath.endsWith(join('eedsh', 'config.ts'))).toBe(true)
  })

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset or relative', async () => {
    for (const value of [undefined, 'relative/dir']) {
      const home = await tempDir('xdg-fallback-home-')
      await mkdir(join(home, '.config', 'eedsh'), { recursive: true })
      const fallbackConfig = join(home, '.config', 'eedsh', 'config.ts')
      await writeFile(fallbackConfig, source)
      const h = harness({ files: { [fallbackConfig]: source } })
      const code = await h.run(['sync'], {
        environment: { env: { ...harnessEnv, HOME: home, XDG_CONFIG_HOME: value }, cwd: root },
      })
      expect(code).toBe(0)
      expect(h.out.join('\n')).toContain('profile xdg-profile')
      expect(h.fs.files.has(generatedPath('xdg-profile'))).toBe(true)
    }
  })

  it('does not discover a working-directory config', async () => {
    const h = harness()
    const home = await xdgHome()
    const cwd = await tempDir('xdg-cwd-')
    await writeFile(join(cwd, 'eedsh.config.ts'), source)

    const code = await h.run(['sync'], {
      environment: { env: { ...harnessEnv, XDG_CONFIG_HOME: home }, cwd },
    })
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain(join(home, 'eedsh', 'config.ts'))
    expect(errors).toContain('eedsh init')
    expect(errors).toContain('--config')
    expect(h.fs.files.size).toBe(0)
  })

  it('names the missing XDG config and both ways to provide one', async () => {
    const h = harness()
    const home = await xdgHome()
    const cwd = await tempDir('xdg-empty-cwd-')
    const code = await h.run(['sync'], {
      environment: { env: { ...harnessEnv, XDG_CONFIG_HOME: home }, cwd },
    })
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain(join(home, 'eedsh', 'config.ts'))
    expect(errors).toContain('eedsh init')
    expect(errors).toContain('--config <path>')
    expect(h.fs.files.size).toBe(0)
  })

  it('rejects an explicit .mts config before evaluation', async () => {
    const h = harness()
    const dir = await tempDir('xdg-mts-')
    const configPath = join(dir, 'config.mts')
    await writeFile(configPath, source)
    const code = await h.run(['sync', '--config', configPath])
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('config.unsupported_extension')
    expect(errors).toContain('config.ts')
    expect(h.fs.files.size).toBe(0)
  })
})

describe('config evaluation', () => {
  it('evaluates non-erasable TypeScript syntax', async () => {
    const h = harness()
    const code = await h.run(['sync', '--config', fixture('enum')])
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile enum-basic')
    expect(h.fs.files.has(generatedPath('enum-basic'))).toBe(true)
  })

  it('evaluates a config in a CommonJS project', async () => {
    const h = harness()
    const code = await h.run(['sync', '--config', fixture('cjs-project')])
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile cli-cjs')
    expect(h.fs.files.has(generatedPath('cli-cjs'))).toBe(true)
  })

  it('reports a syntax error as config.import_failed', async () => {
    const dir = await tempDir('syntax-')
    const configPath = join(dir, 'config.ts')
    await writeFile(configPath, 'export default {\n')

    const h = harness()
    const code = await h.run(['sync', '--config', configPath])
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('config.import_failed')
    expect(h.fs.files.size).toBe(0)
  })

  it('reports a preserved resolution failure instead of config.import_failed', async () => {
    const dir = await tempDir('preset-resolution-')
    const configPath = join(dir, 'config.ts')
    await writeFile(
      configPath,
      `import { bundle } from '@eedsh/config'

export default bundle('@deepseek-ai/dsh-base').preset('missing').toJSON()
`,
    )
    const h = harness()
    const code = await h.run(['sync', '--config', configPath])
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('resolution.preset_not_found')
    expect(errors).toContain('"missing"')
    expect(errors).not.toContain('config.import_failed')
    expect(h.fs.files.size).toBe(0)
  })

  it('reports a preserved preset-definition failure with its ids', async () => {
    const dir = await tempDir('preset-child-')
    const configPath = join(dir, 'config.ts')
    await writeFile(
      configPath,
      `import { definePreset } from '@eedsh/config'

definePreset('ptc-fresh').children((children) => {
  children.child('missing')
})

export default { dsh: '0.2.1-rc.2', profiles: { work: { bundles: [] } } }
`,
    )
    const h = harness()
    const code = await h.run(['sync', '--config', configPath])
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('preset.child_not_found')
    expect(errors).toContain('"ptc-fresh"')
    expect(errors).toContain('"preset-ptc-fresh"')
    expect(errors).toContain('"missing"')
    expect(errors).not.toContain('config.import_failed')
    expect(h.fs.files.size).toBe(0)
  })

  it('applies an edited config in watch mode', async () => {
    const dir = await tempDir('watch-')
    const configPath = join(dir, 'config.ts')
    await writeFile(configPath, watchConfigSource('row-a'))

    const h = harness()
    const watcher = fakeWatcher()
    const running = h.fork(['sync', '--config', configPath, '--watch'], {
      watcher: watcher.shape,
    })
    const patches = () =>
      [...h.fs.files.entries()]
        .filter(([path]) => path.includes(join('.eedsh', 'generated', 'patches')))
        .map(([, content]) => content)

    expect(await waitFor(() => patches().some((patch) => patch.includes('row-a')))).toBe(true)
    await delay(20)
    await writeFile(configPath, watchConfigSource('row-b'))
    watcher.notify()

    expect(await waitFor(() => patches().some((patch) => patch.includes('row-b')))).toBe(true)
    const exit = await interruptCli(running)
    expect(interrupted(exit)).toBe(true)
  })
})

describe('config export forms', () => {
  async function writeConfig(source: string): Promise<string> {
    const dir = await tempDir('config-export-')
    const configPath = join(dir, 'config.ts')
    await writeFile(configPath, source)
    return configPath
  }

  const successResult = `
import * as Result from 'effect/Result'
export default Result.succeed({
  profiles: {
    'result-export': { bundles: [] },
  },
})
`

  const plainConfig = `
export default {
  profiles: {
    'plain-export': { bundles: [] },
  },
}
`

  const failureResult = `
import { defineConfig } from '@eedsh/config'
export default defineConfig()
  .profile('bad/name', () => undefined)
  .build()
`

  const forgedSuccess = `
import * as Result from 'effect/Result'
export default Result.succeed({
  profiles: {
    'bad/name': { bundles: [] },
  },
})
`

  const lonePlan = `
export default {
  format: 'eedsh/profile-plan',
  version: 1,
  profile: { name: 'legacy-plan' },
  bundles: [],
  layers: [],
  packages: {},
}
`

  const authoringThrow = `
import { validateConfigValue } from '@eedsh/plan'
import * as Result from 'effect/Result'
const result = validateConfigValue({
  profiles: { 'bad/name': { bundles: [] } },
})
if (Result.isFailure(result)) throw result.failure
export default {}
`

  it('unwraps a successful config Result export', async () => {
    const h = harness()
    const configPath = await writeConfig(successResult)
    const code = await h.run(['sync', '--config', configPath])
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile result-export')
    expect(h.fs.files.has(generatedPath('result-export'))).toBe(true)
  })

  it('accepts a plain config export', async () => {
    const h = harness()
    const configPath = await writeConfig(plainConfig)
    const code = await h.run(['sync', '--config', configPath])
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile plain-export')
    expect(h.fs.files.has(generatedPath('plain-export'))).toBe(true)
  })

  it('reports a failed Result export with the native schema message', async () => {
    const h = harness()
    const configPath = await writeConfig(failureResult)
    const code = await h.run(['sync', '--config', configPath])
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('not usable as a profile directory')
    expect(errors).not.toContain('config.import_failed')
    expect(h.fs.files.size).toBe(0)
  })

  it('rejects a lone plan export', async () => {
    const h = harness()
    const configPath = await writeConfig(lonePlan)
    const code = await h.run(['sync', '--config', configPath])
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('at ["profiles"]')
    expect(h.fs.files.size).toBe(0)
  })

  it('revalidates a forged successful Result export', async () => {
    const h = harness()
    const configPath = await writeConfig(forgedSuccess)
    const code = await h.run(['sync', '--config', configPath])
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('not usable as a profile directory')
    expect(errors).not.toContain('config.import_failed')
    expect(h.fs.files.size).toBe(0)
  })

  it('surfaces a schema failure raised during module evaluation', async () => {
    const h = harness()
    const configPath = await writeConfig(authoringThrow)
    const code = await h.run(['sync', '--config', configPath])
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('not usable as a profile directory')
    expect(errors).not.toContain('config.import_failed')
    expect(h.fs.files.size).toBe(0)
  })
})

describe('multi-profile configs', () => {
  async function writeConfig(source: string): Promise<string> {
    const dir = await tempDir('multi-profile-')
    const configPath = join(dir, 'config.ts')
    await writeFile(configPath, source)
    return configPath
  }

  const defaultsSource = `
import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .defaultProfile('home')
  .profile('work', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base').generated()
  })
  .profile('home', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base')
  })
  .build()
`

  const soleSource = `
import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('solo', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base').generated()
  })
  .build()
`

  const invalidSiblingSource = `
import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .defaultProfile('work')
  .profile('work', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base')
  })
  .profile('home', (profile) => {
    profile.bundle('@eedsh/runtime')
  })
  .build()
`

  it('uses the declared default profile for run', async () => {
    const h = harness()
    const configPath = await writeConfig(defaultsSource)
    const { calls, spawn } = fakeSpawner({ exitCode: 0 })
    const code = await h.run(['run', '--config', configPath, '--no-sync'], {
      spawner: spawn,
      ...realFiles,
    })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args.slice(1)).toEqual(['--profile', 'home'])
  })

  it('syncs the sole profile when no default is declared', async () => {
    const h = harness()
    const configPath = await writeConfig(soleSource)
    expect(await h.run(['sync', '--config', configPath])).toBe(0)
    expect(h.out.join('\n')).toContain('profile solo')
    expect(h.fs.files.has(generatedPath('solo'))).toBe(true)
  })

  it('syncs a valid profile when a sibling profile is invalid', async () => {
    const h = harness()
    const configPath = await writeConfig(invalidSiblingSource)
    expect(await h.run(['sync', '--config', configPath])).toBe(1)
    expect(h.out.join('\n')).toContain('profile work')
    expect(h.fs.files.has(generatedPath('work'))).toBe(true)
    expect(h.err.join('\n')).toContain('owned by the materializer')
  })
})

describe('profile selection and all-profile sync', () => {
  async function writeConfig(source: string): Promise<string> {
    const dir = await tempDir('profile-select-')
    const configPath = join(dir, 'config.ts')
    await writeFile(configPath, source)
    return configPath
  }

  const withDefault = `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .defaultProfile('work')
  .profile('work', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base').generated()
  })
  .profile('home', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base').generated()
  })
  .build()
`

  const withoutDefault = `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('work', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base').generated()
  })
  .profile('home', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base').generated()
  })
  .build()
`

  const invalidHome = `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .defaultProfile('work')
  .profile('work', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base').generated()
  })
  .profile('home', (profile) => {
    profile.bundle('@eedsh/runtime')
  })
  .build()
`

  const strictWork = `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
      .layer('work', (layer) => {
        layer.override('missing-row', { interval: 1 })
      })
  })
  .profile('home', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base').generated()
  })
  .build()
`

  it('narrows sync to the named profile without falling back to the default', async () => {
    const h = harness()
    const configPath = await writeConfig(withDefault)
    const code = await h.run(['sync', '--config', configPath, '--profile', 'home'])
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile home')
    expect(h.fs.files.has(generatedPath('home'))).toBe(true)
    expect(h.fs.files.has(generatedPath('work'))).toBe(false)
  })

  it('reports an unknown --profile as a usage error listing the names', async () => {
    const h = harness()
    const configPath = await writeConfig(withDefault)
    const code = await h.run(['sync', '--config', configPath, '--profile', 'missing'])
    expect(code).toBe(2)
    const errors = h.err.join('\n')
    expect(errors).toContain('missing')
    expect(errors).toContain('work')
    expect(errors).toContain('home')
    expect(h.fs.files.size).toBe(0)
  })

  it('publishes every profile on a bare sync', async () => {
    const h = harness()
    const configPath = await writeConfig(withDefault)
    const code = await h.run(['sync', '--config', configPath])
    expect(code).toBe(0)
    expect(h.fs.files.has(generatedPath('work'))).toBe(true)
    expect(h.fs.files.has(generatedPath('home'))).toBe(true)
    expect(h.out.join('\n')).toContain('profile work')
    expect(h.out.join('\n')).toContain('profile home')
  })

  it('reports an ambiguous one-profile selection as a usage error', async () => {
    const h = harness()
    const configPath = await writeConfig(withoutDefault)
    const { calls, spawn } = fakeSpawner()
    const code = await h.run(['run', '--config', configPath, '--no-sync'], {
      spawner: spawn,
      ...realFiles,
    })
    expect(code).toBe(2)
    const errors = h.err.join('\n')
    expect(errors).toContain('work')
    expect(errors).toContain('home')
    expect(calls).toHaveLength(0)
  })

  it('boots the profile named by --profile on run', async () => {
    const h = harness()
    const configPath = await writeConfig(withDefault)
    const { calls, spawn } = fakeSpawner({ exitCode: 7 })
    const code = await h.run(
      ['run', '--config', configPath, '--profile', 'home', '--no-sync', '--', '--port', '7777'],
      { spawner: spawn },
    )
    expect(code).toBe(7)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args.slice(1)).toEqual(['--profile', 'home', '--port', '7777'])
  })

  it('rejects --profile on check as a usage error', async () => {
    const h = harness()
    const { calls, spawn } = fakeSpawner()
    const code = await h.run(['check', '--profile', 'work', '--config', fixture('basic')], {
      spawner: spawn,
      ...realFiles,
    })
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('keeps syncing valid profiles after an invalid sibling', async () => {
    const h = harness()
    const configPath = await writeConfig(invalidHome)
    const code = await h.run(['sync', '--config', configPath])
    expect(code).toBe(1)
    expect(h.fs.files.has(generatedPath('work'))).toBe(true)
    const errors = h.err.join('\n')
    expect(errors).toContain('home')
    expect(errors).toContain('owned by the materializer')
  })

  it('keeps syncing valid profiles after a locked sibling', async () => {
    const h = harness({ lockContendedPaths: [homePath('profiles', 'work', '.eedsh', 'sync.lock')] })
    const configPath = await writeConfig(withDefault)
    const code = await h.run(['sync', '--config', configPath])
    expect(code).toBe(1)
    expect(h.fs.files.has(generatedPath('home'))).toBe(true)
    expect(h.fs.files.has(generatedPath('work'))).toBe(false)
    expect(h.err.join('\n')).toContain('another sync is running')
  })

  it('keeps syncing valid profiles after a strict failure in a sibling', async () => {
    const basePatches = [{ insert: [{ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' }] }]
    const h = harness({ basePatches, realPreflight: true })
    const configPath = await writeConfig(strictWork)
    const code = await h.run(['sync', '--strict', '--config', configPath])
    expect(code).toBe(1)
    expect(h.fs.files.has(generatedPath('home'))).toBe(true)
    expect(h.fs.files.has(generatedPath('work'))).toBe(false)
    expect(h.err.join('\n')).toContain('missing-row')
  })

  it('reports ambiguous doctor selection as a usage error', async () => {
    const h = harness()
    const configPath = await writeConfig(withoutDefault)
    const code = await h.run(['doctor', '--config', configPath])
    expect(code).toBe(2)
    const errors = h.err.join('\n')
    expect(errors).toContain('work')
    expect(errors).toContain('home')
  })
})

describe('eedsh arguments', () => {
  it('returns exit 2 for usage errors without ANSI escapes', async () => {
    const h = harness()
    expect(await h.run(['bogus'])).toBe(2)
    expect(await h.run(['sync', '--bogus'])).toBe(2)
    expect(await h.run(['sync', '--config'])).toBe(2)
    const text = `${h.out.join('\n')}\n${h.err.join('\n')}`
    expect(text).toContain('--config')
    expect(hasAnsi(text)).toBe(false)
    expect(h.fs.files.size).toBe(0)
  })

  it('prints no-argument help and command help without ANSI escapes', async () => {
    const noArgs = harness()
    expect(await noArgs.run([])).toBe(0)
    const noArgsText = noArgs.out.join('\n')
    expect(noArgsText).toContain('eedsh')
    expect(noArgsText).toContain('init')
    expect(noArgsText).toContain('sync')
    expect(noArgsText).toContain('run')
    expect(noArgsText).toContain('check')
    expect(hasAnsi(noArgsText)).toBe(false)

    const help = harness()
    expect(await help.run(['--help'])).toBe(0)
    expect(help.out.join('\n')).toContain('sync')
    expect(hasAnsi(help.out.join('\n'))).toBe(false)

    const checkHelp = harness()
    expect(await checkHelp.run(['check', '--help'])).toBe(0)
    const checkText = checkHelp.out.join('\n')
    expect(checkText).toContain('check')
    expect(checkText).toContain('--config')
    expect(hasAnsi(checkText)).toBe(false)
  })

  it('prints the version without ANSI escapes', async () => {
    const h = harness()
    expect(await h.run(['--version'])).toBe(0)
    expect(h.out.join('\n')).toMatch(/\d+\.\d+\.\d+/)
    expect(hasAnsi(h.out.join('\n'))).toBe(false)
  })

  it('rejects --explain on run and check before spawning', async () => {
    const runHarness = harness()
    const runSpawn = fakeSpawner()
    const runCode = await runHarness.run(['run', '--explain', '--config', fixture('basic')], {
      spawner: runSpawn.spawn,
    })
    expect(runCode).toBe(2)
    expect(runSpawn.calls).toHaveLength(0)
    expect(runHarness.packages.installs).toEqual([])
    expect(runHarness.fs.files.size).toBe(0)

    const checkHarness = harness()
    const checkSpawn = fakeSpawner()
    const checkCode = await checkHarness.run(['check', '--explain', '--config', fixture('basic')], {
      spawner: checkSpawn.spawn,
    })
    expect(checkCode).toBe(2)
    expect(checkSpawn.calls).toHaveLength(0)
    expect(checkHarness.fs.files.size).toBe(0)
  })

  it('rejects -- passthrough on sync', async () => {
    const h = harness()
    const code = await h.run(['sync', '--', '--strict'])
    expect(code).toBe(2)
    expect(h.err.join('\n')).toContain('--')
    expect(h.fs.files.size).toBe(0)
  })
})

describe('strict mode', () => {
  const basePatches = [{ insert: [{ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' }] }]

  it('reports raw warnings and a hint but publishes without strict mode', async () => {
    const h = harness({ basePatches, realPreflight: true })
    const code = await h.run(['sync', '--config', fixture('unmatched')])
    expect(code).toBe(0)
    const errors = h.err.join('\n')
    expect(errors).toContain('missing-row')
    expect(errors).not.toContain('generated #1')
    expect(errors).toContain('--explain')
    expect(h.fs.files.has(generatedPath('cli-unmatched'))).toBe(true)
  })

  it('attributes warnings with --explain and omits the hint', async () => {
    const h = harness({ basePatches, realPreflight: true })
    const code = await h.run(['sync', '--explain', '--config', fixture('unmatched')])
    expect(code).toBe(0)
    const errors = h.err.join('\n')
    expect(errors).toContain('generated #1 "cli" (config.ts:')
    expect(errors).toContain('[missing-row]:')
    expect(errors).toContain('missing-row')
    expect(errors).not.toContain('--explain')
    expect(h.fs.files.has(generatedPath('cli-unmatched'))).toBe(true)
  })

  it('keeps strict failures raw and prints the hint', async () => {
    const h = harness({ basePatches, realPreflight: true })
    const code = await h.run(['sync', '--strict', '--config', fixture('unmatched')])
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('missing-row')
    expect(errors).not.toContain('generated #1')
    expect(errors).toContain('--explain')
    expect(h.fs.files.has(generatedPath('cli-unmatched'))).toBe(false)
  })

  it('attributes strict failures with --strict --explain and omits the hint', async () => {
    const h = harness({ basePatches, realPreflight: true })
    const code = await h.run(['sync', '--strict', '--explain', '--config', fixture('unmatched')])
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('generated #1 "cli" (config.ts:')
    expect(errors).toContain('[missing-row]:')
    expect(errors).toContain('missing-row')
    expect(errors).not.toContain('--explain')
    expect(h.fs.files.has(generatedPath('cli-unmatched'))).toBe(false)
  })

  it('syncs a plain plan without provenance using positional attribution', async () => {
    const h = harness({ basePatches, realPreflight: true })
    const plan = planOf({
      name: 'cli-unmatched',
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [{ patches: [override('missing-row', { interval: 1 })] }],
    })
    const code = await h.run(['sync', '--explain', '--config', fixture('unmatched')], {
      configLoader: fakeConfigLoader(() => Effect.succeed(loaded(configWith(plan)))),
    })
    expect(code).toBe(0)
    const errors = h.err.join('\n')
    expect(errors).toContain('generated #1 [missing-row]:')
    expect(errors).not.toContain('(config.ts:')
    expect(h.fs.files.has(generatedPath('cli-unmatched'))).toBe(true)
  })

  it('warns on an empty generated layer and fails strict without committing', async () => {
    const dir = await tempDir('empty-layer-')
    const configPath = join(dir, 'config.ts')
    await writeFile(
      configPath,
      `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('cli-empty', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base').generated().layer('empty')
  })
  .build()
`,
    )
    const manifest = generatedPath('cli-empty')
    const warned = harness({ basePatches, realPreflight: true })
    expect(await warned.run(['sync', '--config', configPath])).toBe(0)
    const warnings = warned.err.join('\n')
    expect(warnings).toContain('generated #1 "empty": contains no patches')
    expect(warnings).toContain('--explain')
    expect(warned.fs.files.has(manifest)).toBe(true)

    const strict = harness({ basePatches, realPreflight: true })
    expect(await strict.run(['sync', '--strict', '--config', configPath])).toBe(1)
    expect(strict.err.join('\n')).toContain('contains no patches')
    expect(strict.fs.files.has(manifest)).toBe(false)
  })

  it('publishes with --explain when there are no warnings', async () => {
    const h = harness({ basePatches, realPreflight: true })
    const code = await h.run(['sync', '--explain', '--config', fixture('basic')])
    expect(code).toBe(0)
    expect(h.err.join('\n')).not.toContain('warning:')
    expect(h.err.join('\n')).not.toContain('--explain')
    expect(h.fs.files.has(generatedPath('cli-fixture'))).toBe(true)
  })
})

describe('generation record diagnostics', () => {
  const profileDir = homePath('profiles', 'cli-fixture')
  const recordPath = join(profileDir, '.eedsh', 'generated', 'package.json')
  const manifestPath = join(profileDir, 'package.json')
  const adopted = '@edsh/adapted-ptc'

  function managedManifest(
    bundles: string[] = ['@deepseek-ai/dsh-base', '@eedsh/runtime', '@eedsh/generated'],
  ): string {
    return `${JSON.stringify(
      {
        name: 'dsh-profile-cli-fixture',
        private: true,
        dsh: { profile: { bundles } },
        dependencies: {
          '@eedsh/runtime': 'link:/repo/runtime',
          '@eedsh/generated': 'link:./.eedsh/generated',
        },
      },
      null,
      2,
    )}\n`
  }

  it('fails an eedsh-managed profile with a corrupt record and names the recovery', async () => {
    const manifest = managedManifest()
    const h = harness({ files: { [manifestPath]: manifest, [recordPath]: '{ not json' } })
    const code = await h.run(['sync', '--config', fixture('basic')])
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain(recordPath)
    expect(errors).toContain('--adopt-ownership')
    expect(errors).not.toContain('--explain')
    expect(h.fs.files.get(manifestPath)).toBe(manifest)
    expect(h.packages.installs).toEqual([])
  })

  it('does not suggest adoption for a newer record version', async () => {
    const h = harness({
      files: {
        [manifestPath]: managedManifest(),
        [recordPath]: JSON.stringify({
          name: '@eedsh/generated',
          eedsh: { format: 'eedsh/generation', version: 2 },
        }),
      },
    })
    const code = await h.run(['sync', '--config', fixture('basic')])
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('upgrade eedsh')
    expect(errors).not.toContain('--adopt-ownership')
  })

  it('documents --adopt-ownership in sync help', async () => {
    const h = harness()
    expect(await h.run(['sync', '--help'])).toBe(0)
    expect(h.out.join('\n')).toContain('--adopt-ownership')
  })

  it('prints an ownership notice without adding the --explain hint', async () => {
    const h = harness({
      files: {
        [manifestPath]: managedManifest([
          '@deepseek-ai/dsh-base',
          '@eedsh/runtime',
          '@eedsh/generated',
          adopted,
        ]),
        [recordPath]: '{ not json',
      },
    })
    const code = await h.run(['sync', '--config', fixture('basic'), '--adopt-ownership'])
    expect(code).toBe(0)
    const errors = h.err.join('\n')
    expect(errors).toContain('eedsh: notice:')
    expect(errors).toContain(adopted)
    expect(errors).not.toContain('--explain')
  })
})

/** Add the lockfile and installed packages a clean doctor run expects. */
function addPublishedRuntimeState(h: ReturnType<typeof harness>): void {
  const profileDir = homePath('profiles', 'cli-fixture')
  const record = JSON.parse(
    h.fs.files.get(join(profileDir, '.eedsh', 'generated', 'package.json')) ?? '{}',
  ) as { eedsh?: { packages?: Record<string, string> } }
  const packages = record.eedsh?.packages ?? {}
  const entries = Object.entries(packages)
    .map(([name, spec]) => `      '${name}':\n        specifier: ${spec}`)
    .join('\n')
  h.fs.files.set(
    join(profileDir, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n${entries}\n`,
  )
  for (const name of Object.keys(packages)) {
    h.fs.files.set(
      join(profileDir, 'node_modules', ...name.split('/'), 'package.json'),
      `${JSON.stringify({ name, version: '0.0.0' })}\n`,
    )
  }
}

async function syncedProfile() {
  const h = harness()
  expect(await h.run(['sync', '--config', fixture('basic')])).toBe(0)
  addPublishedRuntimeState(h)
  return h
}

describe('eedsh doctor', () => {
  const profileDir = homePath('profiles', 'cli-fixture')
  const profileName = 'cli-fixture'

  it('inspects --profile without evaluating a config', async () => {
    const h = await syncedProfile()
    const code = await h.run(['doctor', '--profile', profileName], {
      configLoader: fakeConfigLoader(() =>
        Effect.die(new Error('doctor --profile must not evaluate the config')),
      ),
    })
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('clean: 0 errors, 0 warnings')
  })

  it('takes the profile name from the config', async () => {
    const h = await syncedProfile()
    const code = await h.run(['doctor', '--config', fixture('basic')])
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('clean: 0 errors, 0 warnings')
  })

  it('rejects --profile together with --config as a usage error', async () => {
    const h = harness()
    const code = await h.run(['doctor', '--profile', profileName, '--config', fixture('basic')])
    expect(code).toBe(2)
    expect(h.err.join('\n')).toContain('--profile')
  })

  it('rejects an unusable profile name as a usage error', async () => {
    const h = harness()
    expect(await h.run(['doctor', '--profile', '../escape'])).toBe(2)
    expect(await h.run(['doctor', '--profile', 'node_modules'])).toBe(2)
  })

  it('reports a missing profile with exit 1', async () => {
    const h = harness()
    const code = await h.run(['doctor', '--profile', 'missing'])
    expect(code).toBe(1)
    expect(h.out.join('\n')).toContain('does not exist')
  })

  it('exits 1 when a finding is an error', async () => {
    const h = await syncedProfile()
    h.fs.files.delete(join(profileDir, '.eedsh', 'generated', 'package.json'))
    const code = await h.run(['doctor', '--profile', profileName])
    expect(code).toBe(1)
    expect(h.out.join('\n')).toContain('error: record:')
  })

  it('exits 0 with warnings and 1 with --strict', async () => {
    const h = await syncedProfile()
    h.fs.files.delete(join(profileDir, 'cordis.yml'))
    expect(await h.run(['doctor', '--profile', profileName])).toBe(0)
    expect(h.out.join('\n')).toContain('warning: scaffolding:')
    const strict = await h.run(['doctor', '--profile', profileName, '--strict'])
    expect(strict).toBe(1)
  })

  it('rejects --explain as a usage error', async () => {
    const h = await syncedProfile()
    const code = await h.run(['doctor', '--profile', profileName, '--explain'])
    expect(code).toBe(2)
  })
})

describe('dependency section notices', () => {
  const manifestPath = homePath('profiles', 'cli-fixture', 'package.json')

  it('prints a cleanup notice and still reinstalls the profile', async () => {
    const h = harness()
    expect(await h.run(['sync', '--config', fixture('basic')])).toBe(0)
    const installs = h.packages.installs.length
    const manifest = JSON.parse(h.fs.files.get(manifestPath) ?? '{}') as {
      devDependencies?: Record<string, string>
    }
    manifest.devDependencies = { '@eedsh/generated': '^1.0.0' }
    h.fs.files.set(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    expect(await h.run(['sync', '--config', fixture('basic')])).toBe(0)
    expect(h.err.join('\n')).toContain(
      'eedsh: notice: removed @eedsh/generated from devDependencies',
    )
    expect(h.packages.installs.length).toBe(installs + 1)
    const written = JSON.parse(h.fs.files.get(manifestPath) ?? '{}') as {
      devDependencies?: Record<string, string>
    }
    expect(written.devDependencies).toEqual({})
  })
})

describe('tagged failures', () => {
  it('maps a preflight failure to a diagnostic and exit 1', async () => {
    const h = harness({ preflight: { fail: true } })
    const code = await h.run(['sync', '--config', fixture('basic')])
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('unmatched target')
  })

  it('reports a typed failure exactly once', async () => {
    const h = harness({ preflight: { fail: true } })
    const code = await h.run(['sync', '--config', fixture('basic')])
    expect(code).toBe(1)
    expect(h.err.join('\n').match(/unmatched target/g)).toHaveLength(1)
  })

  it('maps a held sync lock to a diagnostic naming the path and no PID', async () => {
    const h = harness({ lockHeld: true })
    const code = await h.run(['sync', '--config', fixture('basic')])
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('another sync is running')
    expect(errors).toContain(homePath('profiles', 'cli-fixture', '.eedsh', 'sync.lock'))
    expect(errors).not.toMatch(/pid/i)
  })

  it('maps a package failure to a diagnostic and exit 1', async () => {
    const h = harness({ packages: { fail: true } })
    const code = await h.run(['sync', '--config', fixture('basic')])
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('package install')
  })

  it('reports an unexpected command failure and exits 1', async () => {
    const h = harness()
    // The CLI does not build the service layer, so an unexpected failure is
    // modelled through a capability that violates its contract; the sync command
    // reports it once and exits 1 instead of letting it escape as a defect.
    const code = await h.run(['sync', '--config', fixture('basic')], {
      configLoader: fakeConfigLoader(() =>
        Effect.fail(new Error('service layer unavailable') as never),
      ),
    })
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('eedsh: service layer unavailable')
    expect(errors.match(/service layer unavailable/g)).toHaveLength(1)
  })
})

describe('sync provisioning flags', () => {
  it('rejects --rebuild together with --no-build as a usage error', async () => {
    const h = harness()
    const code = await h.run(['sync', '--rebuild', '--no-build', '--config', fixture('basic')])
    expect(code).toBe(2)
    const errors = h.err.join('\n')
    expect(errors).toContain('--rebuild')
    expect(errors).toContain('--no-build')
  })
})

describe('eedsh sync --watch', () => {
  it('reruns on change, retains the last generation on failure, and reuses services', async () => {
    const h = harness()
    const planA = planOf({
      name: 'cli-fixture',
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [insert({ id: 'row-a', name: '@scope/row-a' })])],
    })
    const planB = planOf({
      name: 'cli-fixture',
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [insert({ id: 'row-b', name: '@scope/row-b' })])],
    })

    const watcher = fakeWatcher()
    let call = 0
    const loadConfig = (): Effect.Effect<LoadedConfig, ConfigError> => {
      call += 1
      if (call === 2) {
        return Effect.fail(new ConfigError('config.import_failed', 'config compile failed'))
      }
      return Effect.succeed(loaded(configWith(call === 1 ? planA : planB)))
    }
    const running = h.fork(['sync', '--config', fixture('basic'), '--watch'], {
      configLoader: fakeConfigLoader(loadConfig),
      watcher: watcher.shape,
    })

    expect(await waitFor(() => h.fs.files.has(generatedManifest))).toBe(true)
    const first = h.fs.files.get(generatedManifest)
    const constructions = h.constructions()

    watcher.notify()
    expect(await waitFor(() => h.err.join('\n').includes('config compile failed'))).toBe(true)
    expect(h.fs.files.get(generatedManifest)).toBe(first)

    watcher.notify()
    expect(await waitFor(() => h.fs.files.get(generatedManifest) !== first)).toBe(true)
    expect(h.constructions()).toBe(constructions)

    const exit = await interruptCli(running)
    expect(interrupted(exit)).toBe(true)
    expect(watcher.closes).toHaveLength(1)
  })

  it('releases the layer and reports when the watcher cannot start', async () => {
    const h = harness()
    const watcher = fakeWatcher({ fail: new Error('watcher failed') })
    const code = await h.run(['sync', '--config', fixture('basic'), '--watch'], {
      watcher: watcher.shape,
    })
    expect(code).toBe(1)
    expect(h.packages.installs).toEqual([])
    expect(h.fs.files.size).toBe(0)
    expect(h.finalizers()).toBe(1)
    expect(h.err.join('\n')).toContain('watcher failed')
  })

  it('releases the layer and skips the watcher when discovery fails', async () => {
    const h = harness({ discoveryFails: true })
    const watcher = fakeWatcher()
    const code = await h.run(['sync', '--config', fixture('basic'), '--watch'], {
      watcher: watcher.shape,
    })
    expect(code).toBe(1)
    expect(watcher.watchCalls).toHaveLength(0)
    expect(h.packages.installs).toEqual([])
    expect(h.fs.files.size).toBe(0)
    expect(h.finalizers()).toBe(1)
    expect(h.err.join('\n')).toContain('dsh.not_found')
    expect(h.err.join('\n')).toContain('cannot resolve a DSH installation')
  })

  it('starts the initial sync only after the watcher is ready', async () => {
    const h = harness()
    const ready = Effect.runSync(Deferred.make<void>())
    const watcher = fakeWatcher({ ready })
    const running = h.fork(['sync', '--config', fixture('basic'), '--watch'], {
      watcher: watcher.shape,
    })

    expect(await waitFor(() => watcher.watchCalls.length === 1)).toBe(true)
    const installsBeforeReady = h.packages.installs.length
    expect(installsBeforeReady).toBe(0)
    expect(h.fs.files.size).toBe(0)
    await Effect.runPromise(Deferred.succeed(ready, undefined))
    expect(await waitFor(() => h.fs.files.has(generatedManifest))).toBe(true)

    const exit = await interruptCli(running)
    expect(interrupted(exit)).toBe(true)
  })

  it('runs exactly one follow-up sync when a change arrives during the initial sync', async () => {
    const gate = Effect.runSync(Deferred.make<void>())
    const h = harness({
      packages: { beforeInstall: (count) => (count === 1 ? Deferred.await(gate) : Effect.void) },
    })
    const watcher = fakeWatcher()
    const running = h.fork(['sync', '--config', fixture('basic'), '--watch'], {
      watcher: watcher.shape,
    })
    const runs = () =>
      h.out.filter(
        (line) => line.startsWith('eedsh: published') || line.startsWith('eedsh: unchanged'),
      ).length

    expect(await waitFor(() => h.packages.installs.length === 1)).toBe(true)
    watcher.notify()
    await Effect.runPromise(Deferred.succeed(gate, undefined))
    expect(await waitFor(() => runs() === 2)).toBe(true)
    await delay(100)
    expect(runs()).toBe(2)

    const exit = await interruptCli(running)
    expect(interrupted(exit)).toBe(true)
  })

  it('coalesces a burst of changes during a sync into one follow-up sync', async () => {
    const gate = Effect.runSync(Deferred.make<void>())
    const h = harness({
      packages: { beforeInstall: (count) => (count === 1 ? Deferred.await(gate) : Effect.void) },
    })
    const watcher = fakeWatcher()
    const running = h.fork(['sync', '--config', fixture('basic'), '--watch'], {
      watcher: watcher.shape,
    })
    const runs = () =>
      h.out.filter(
        (line) => line.startsWith('eedsh: published') || line.startsWith('eedsh: unchanged'),
      ).length

    expect(await waitFor(() => h.packages.installs.length === 1)).toBe(true)
    watcher.notify()
    watcher.notify()
    watcher.notify()
    await Effect.runPromise(Deferred.succeed(gate, undefined))
    expect(await waitFor(() => runs() === 2)).toBe(true)
    await delay(100)
    expect(runs()).toBe(2)

    const exit = await interruptCli(running)
    expect(interrupted(exit)).toBe(true)
  })

  it('interrupts an in-flight rerun and releases the lock, watcher, and layer', async () => {
    const gate = Effect.runSync(Deferred.make<void>())
    const h = harness({
      packages: { beforeInstall: (count) => (count === 2 ? Deferred.await(gate) : Effect.void) },
    })
    const planA = planOf({
      name: 'cli-fixture',
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [insert({ id: 'row-a', name: '@scope/row-a' })])],
    })
    const planB = planOf({
      name: 'cli-fixture',
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [insert({ id: 'row-b', name: '@scope/row-b' })])],
      packages: { '@scope/plugin': '1.0.0' },
    })
    const watcher = fakeWatcher()
    let calls = 0
    const loadConfig = (): Effect.Effect<LoadedConfig> => {
      calls += 1
      return Effect.succeed(loaded(configWith(calls === 1 ? planA : planB)))
    }
    const running = h.fork(['sync', '--config', fixture('basic'), '--watch'], {
      configLoader: fakeConfigLoader(loadConfig),
      watcher: watcher.shape,
    })

    await waitFor(() => h.fs.files.has(generatedManifest))
    watcher.notify()
    const started = await waitFor(() => h.packages.installs.length === 2)

    const exit = await interruptCli(running)
    const lockHeldAtStop = h.lock.isHeld()
    const releasesAtStop = [...h.lock.releases]
    const watcherClosesAtStop = watcher.closes.length
    const layerFinalizersAtStop = h.finalizers()
    await Effect.runPromise(Deferred.succeed(gate, undefined))

    expect(interrupted(exit)).toBe(true)
    expect(started).toBe(true)
    expect(lockHeldAtStop).toBe(false)
    expect(releasesAtStop).toContain(homePath('profiles', 'cli-fixture', '.eedsh', 'sync.lock'))
    expect(watcherClosesAtStop).toBe(1)
    expect(layerFinalizersAtStop).toBe(1)
  })

  it('surfaces a close failure on the interrupted exit', async () => {
    const h = harness()
    const watcher = fakeWatcher({
      onClose: () => {
        throw new WatchCloseError({ cause: new Error('close failed') })
      },
    })
    const running = h.fork(['sync', '--config', fixture('basic'), '--watch'], {
      watcher: watcher.shape,
    })

    expect(await waitFor(() => h.fs.files.has(generatedManifest))).toBe(true)
    // `main` observes the interrupted Exit carrying the close defect; `bin`
    // reports it as a warning and keeps the stop successful (EXIT_OK).
    const exit = await interruptCli(running)
    const defect = Exit.isFailure(exit) ? Cause.findDefect(exit.cause) : undefined

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(defect !== undefined && Result.isSuccess(defect)).toBe(true)
    if (defect !== undefined && Result.isSuccess(defect)) {
      expect(defect.success).toBeInstanceOf(WatchCloseError)
    }
    expect(watcher.closes).toHaveLength(1)
    expect(h.finalizers()).toBe(1)
  })
})

describe('multi-profile sync --watch', () => {
  const manifestPath = (name: string) => generatedPath(name)

  function twoProfiles(workRow: string, homeRow: string): string {
    return `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .defaultProfile('work')
  .profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
      .layer('cli', (layer) => {
        layer.insert({ id: '${workRow}', name: '@scope/${workRow}' })
      })
  })
  .profile('home', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
      .layer('cli', (layer) => {
        layer.insert({ id: '${homeRow}', name: '@scope/${homeRow}' })
      })
  })
  .build()
`
  }

  function singleProfile(row: string): string {
    return `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
      .layer('cli', (layer) => {
        layer.insert({ id: '${row}', name: '@scope/${row}' })
      })
  })
  .build()
`
  }

  function invalidHome(workRow: string): string {
    return `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .defaultProfile('work')
  .profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
      .layer('cli', (layer) => {
        layer.insert({ id: '${workRow}', name: '@scope/${workRow}' })
      })
  })
  .profile('home', (profile) => {
    profile.bundle('@eedsh/runtime')
  })
  .build()
`
  }

  function strictWorkSource(homeRow: string): string {
    return `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .defaultProfile('work')
  .profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
      .layer('cli', (layer) => {
        layer.override('missing-row', { interval: 1 })
      })
  })
  .profile('home', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
      .layer('cli', (layer) => {
        layer.insert({ id: '${homeRow}', name: '@scope/${homeRow}' })
      })
  })
  .build()
`
  }

  async function watchConfig(source: string): Promise<string> {
    const dir = await tempDir('multi-watch-')
    const configPath = join(dir, 'config.ts')
    await writeFile(configPath, source)
    return configPath
  }

  const generatedPatches = (h: ReturnType<typeof harness>) =>
    [...h.fs.files.entries()]
      .filter(([path]) => path.includes(join('.eedsh', 'generated', 'patches')))
      .map(([, content]) => content)

  it('publishes every profile on a bare watch and on reruns', async () => {
    const h = harness()
    const configPath = await watchConfig(twoProfiles('work-a', 'home-a'))
    const watcher = fakeWatcher()
    const running = h.fork(['sync', '--config', configPath, '--watch'], {
      watcher: watcher.shape,
    })

    expect(
      await waitFor(
        () => h.fs.files.has(manifestPath('work')) && h.fs.files.has(manifestPath('home')),
      ),
    ).toBe(true)

    await writeFile(configPath, twoProfiles('work-b', 'home-b'))
    watcher.notify()
    expect(await waitFor(() => generatedPatches(h).some((patch) => patch.includes('home-b')))).toBe(
      true,
    )

    const exit = await interruptCli(running)
    expect(interrupted(exit)).toBe(true)
  })

  it('narrows watch to --profile', async () => {
    const h = harness()
    const configPath = await watchConfig(twoProfiles('work-a', 'home-a'))
    const watcher = fakeWatcher()
    const running = h.fork(['sync', '--config', configPath, '--watch', '--profile', 'home'], {
      watcher: watcher.shape,
    })

    expect(await waitFor(() => h.fs.files.has(manifestPath('home')))).toBe(true)
    await delay(100)
    expect(h.fs.files.has(manifestPath('work'))).toBe(false)

    const exit = await interruptCli(running)
    expect(interrupted(exit)).toBe(true)
  })

  it('picks up a profile added while watching', async () => {
    const h = harness()
    const configPath = await watchConfig(singleProfile('work-a'))
    const watcher = fakeWatcher()
    const running = h.fork(['sync', '--config', configPath, '--watch'], {
      watcher: watcher.shape,
    })

    expect(await waitFor(() => h.fs.files.has(manifestPath('work')))).toBe(true)

    await writeFile(configPath, twoProfiles('work-a', 'home-added'))
    watcher.notify()
    expect(
      await waitFor(
        () =>
          h.fs.files.has(manifestPath('home')) &&
          generatedPatches(h).some((patch) => patch.includes('home-added')),
      ),
    ).toBe(true)

    const exit = await interruptCli(running)
    expect(interrupted(exit)).toBe(true)
  })

  it('stops syncing a profile removed from the config and keeps its state', async () => {
    const h = harness()
    const configPath = await watchConfig(twoProfiles('work-a', 'home-a'))
    const watcher = fakeWatcher()
    const running = h.fork(['sync', '--config', configPath, '--watch'], {
      watcher: watcher.shape,
    })

    expect(
      await waitFor(
        () => h.fs.files.has(manifestPath('work')) && h.fs.files.has(manifestPath('home')),
      ),
    ).toBe(true)
    const homeManifest = h.fs.files.get(manifestPath('home'))

    await writeFile(configPath, singleProfile('work-b'))
    watcher.notify()
    expect(await waitFor(() => generatedPatches(h).some((patch) => patch.includes('work-b')))).toBe(
      true,
    )
    expect(h.fs.files.get(manifestPath('home'))).toBe(homeManifest)

    const exit = await interruptCli(running)
    expect(interrupted(exit)).toBe(true)
  })

  it('reports an invalid profile and still syncs its valid siblings', async () => {
    const h = harness()
    const configPath = await watchConfig(invalidHome('work-a'))
    const watcher = fakeWatcher()
    const running = h.fork(['sync', '--config', configPath, '--watch'], {
      watcher: watcher.shape,
    })

    expect(await waitFor(() => h.fs.files.has(manifestPath('work')))).toBe(true)
    expect(await waitFor(() => h.err.join('\n').includes('owned by the materializer'))).toBe(true)
    expect(h.err.join('\n')).toContain('home')
    expect(h.fs.files.has(manifestPath('home'))).toBe(false)

    await writeFile(configPath, twoProfiles('work-a', 'home-b'))
    watcher.notify()
    expect(await waitFor(() => h.fs.files.has(manifestPath('home')))).toBe(true)

    const exit = await interruptCli(running)
    expect(interrupted(exit)).toBe(true)
  })

  it('continues after the selected profile disappears', async () => {
    const h = harness()
    const configPath = await watchConfig(twoProfiles('work-a', 'home-a'))
    const watcher = fakeWatcher()
    const running = h.fork(['sync', '--config', configPath, '--watch', '--profile', 'home'], {
      watcher: watcher.shape,
    })

    expect(await waitFor(() => h.fs.files.has(manifestPath('home')))).toBe(true)

    await delay(20)
    await writeFile(configPath, singleProfile('work-b'))
    watcher.notify()
    expect(
      await waitFor(
        () =>
          h.err.join('\n').includes('"home" is not declared') && h.err.join('\n').includes('work'),
      ),
    ).toBe(true)

    await delay(20)
    await writeFile(configPath, twoProfiles('work-a', 'home-b'))
    watcher.notify()
    expect(await waitFor(() => generatedPatches(h).some((patch) => patch.includes('home-b')))).toBe(
      true,
    )

    const exit = await interruptCli(running)
    expect(interrupted(exit)).toBe(true)
  })

  it('keeps the session active after a materialization failure', async () => {
    const basePatches = [{ insert: [{ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' }] }]
    const h = harness({ basePatches, realPreflight: true })
    const configPath = await watchConfig(twoProfiles('work-a', 'home-a'))
    const watcher = fakeWatcher()
    const running = h.fork(['sync', '--strict', '--config', configPath, '--watch'], {
      watcher: watcher.shape,
    })

    expect(
      await waitFor(
        () => h.fs.files.has(manifestPath('work')) && h.fs.files.has(manifestPath('home')),
      ),
    ).toBe(true)

    await delay(20)
    await writeFile(configPath, strictWorkSource('home-b'))
    watcher.notify()
    expect(await waitFor(() => h.err.join('\n').includes('missing-row'))).toBe(true)
    expect(h.err.join('\n')).toContain('work')
    expect(await waitFor(() => generatedPatches(h).some((patch) => patch.includes('home-b')))).toBe(
      true,
    )

    await delay(20)
    await writeFile(configPath, twoProfiles('work-b', 'home-b'))
    watcher.notify()
    expect(await waitFor(() => generatedPatches(h).some((patch) => patch.includes('work-b')))).toBe(
      true,
    )

    const exit = await interruptCli(running)
    expect(interrupted(exit)).toBe(true)
  })
})
describe('eedsh check', () => {
  const configPath = fixture('basic')

  it('prints the resolved invocation and runs the compiler without materializing', async () => {
    const h = harness()
    const { calls, spawn } = fakeSpawner({ listing: `${configPath}\n` })
    const code = await h.run(['check', '--config', configPath, '--', '--pretty', 'false'], {
      configLoader: fakeConfigLoader(() =>
        Effect.die(new Error('eedsh check must not evaluate the config')),
      ),
      spawner: spawn,
      ...realFiles,
    })
    expect(code).toBe(0)
    const text = h.out.join('\n')
    expect(text).toMatch(/TypeScript \d+\.\d+\.\d+/)
    expect(text).toContain(join(root, 'tsconfig.json'))
    expect(text).toContain('--noEmit')
    expect(text).toContain('--pretty false')

    expect(calls).toHaveLength(2)
    expect(calls[0]?.args).toContain('--listFilesOnly')
    const check = calls[1]
    expect(check?.command).toBe(process.execPath)
    expect(check?.args[0]).toMatch(/typescript[\\/]bin[\\/]tsc$/)
    expect(check?.args).toContain('--noEmit')
    expect(check?.args).toContain('-p')
    expect(check?.args.slice(-2)).toEqual(['--pretty', 'false'])
    expect(check?.options.stdio).toBe('inherit')
    expect(h.fs.files.size).toBe(0)
    expect(h.packages.installs).toEqual([])
  })

  it('returns the compiler exit code and reports failure', async () => {
    const h = harness()
    const { spawn } = fakeSpawner({
      exitCode: 2,
      stderr: 'error TS2322',
      listing: `${configPath}\n`,
    })
    const code = await h.run(['check', '--config', configPath], { spawner: spawn, ...realFiles })
    expect(code).toBe(2)
    const errors = h.err.join('\n')
    expect(errors).toContain('check failed')
    expect(errors).not.toContain('check.')
    expect(h.fs.files.size).toBe(0)
  })

  it('forwards a failed file listing without a check failure code', async () => {
    const h = harness()
    const { spawn } = fakeSpawner({ listingExit: 2, stderr: 'listing failed', listing: '' })
    const code = await h.run(['check', '--config', configPath], { spawner: spawn, ...realFiles })
    expect(code).toBe(2)
    const errors = h.err.join('\n')
    expect(errors).toContain('cannot list the project files')
    expect(errors).not.toContain('check.')
    expect(h.fs.files.size).toBe(0)
  })
})

describe('eedsh check failures', () => {
  async function externalProject(configSource: string, tsconfig?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'eedsh-check-'))
    const configPath = join(dir, 'config.ts')
    await writeFile(configPath, configSource)
    if (tsconfig !== undefined) await writeFile(join(dir, 'tsconfig.json'), tsconfig)
    return configPath
  }

  it('fails with config.not_found for a missing config', async () => {
    const h = harness()
    const { calls, spawn } = fakeSpawner()
    const code = await h.run(['check', '--config', join(root, 'nope/config.ts')], {
      spawner: spawn,
      ...realFiles,
    })
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('config.not_found')
    expect(calls).toHaveLength(0)
  })

  it('fails with check.tsconfig_missing when no tsconfig is found', async () => {
    const configPath = await externalProject('export default {}\n')
    const h = harness()
    const { calls, spawn } = fakeSpawner()
    const code = await h.run(['check', '--config', configPath], { spawner: spawn, ...realFiles })
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('check.tsconfig_missing')
    expect(h.err.join('\n')).toContain('tsconfig.json')
    expect(calls).toHaveLength(0)
  })

  it('fails with check.typescript_missing when the project has no TypeScript', async () => {
    const configPath = await externalProject('export default {}\n', '{}\n')
    const h = harness()
    const { calls, spawn } = fakeSpawner()
    const code = await h.run(['check', '--config', configPath], { spawner: spawn, ...realFiles })
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('check.typescript_missing')
    expect(h.err.join('\n')).toContain('install')
    expect(calls).toHaveLength(0)
  })

  it('fails with check.config_not_in_project when the tsconfig excludes the config', async () => {
    const h = harness()
    const { calls, spawn } = fakeSpawner({ listing: '/home/project/src/index.ts\n' })
    const code = await h.run(['check', '--config', fixture('basic')], {
      spawner: spawn,
      ...realFiles,
    })
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('check.config_not_in_project')
    expect(h.err.join('\n')).toContain(join(root, 'tsconfig.json'))
    expect(calls).toHaveLength(1)
  })
})

describe('documentation', () => {
  it('keeps the Quick start example a minimal valid plan', async () => {
    const example = await readmeExample('Quick start')
    const plan = example.plan('work')
    expect(plan.profile.name).toBe('work')
    expect(plan.bundles).toEqual([
      { kind: 'bundle', name: '@deepseek-ai/dsh-base' },
      { kind: 'bundle', name: '@deepseek-ai/dsh-web-app' },
      { kind: 'generated' },
    ])
    expect(plan.layers).toHaveLength(1)
    expect(plan.layers[0]?.patches).toHaveLength(2)
  })

  it('keeps the Example configuration a full valid plan', async () => {
    const example = await readmeExample('Example configuration')
    const plan = example.plan('work')
    expect(plan.profile.name).toBe('work')
    expect(plan.packages).toEqual({ '@scope/my-plugin': 'link:../packages/my-plugin' })
    expect(plan.bundles).toEqual([
      { kind: 'bundle', name: '@deepseek-ai/dsh-base' },
      { kind: 'bundle', name: '@deepseek-ai/dsh-web-app' },
      { kind: 'generated' },
    ])
    expect(plan.layers).toHaveLength(2)
    expect(plan.layers[0]?.patches).toHaveLength(2)
    expect(plan.layers[1]?.patches).toHaveLength(2)
    expect(plan.layers.some((item) => 'id' in item)).toBe(false)
  })
})

describe('eedsh run', () => {
  it('forwards dsh arguments through an injected spawn', async () => {
    const h = harness()
    const { calls, spawn } = fakeSpawner({ exitCode: 7 })
    const code = await h.run(
      ['run', '--config', fixture('basic'), '--no-sync', '--', '--port', '7777'],
      { spawner: spawn },
    )
    expect(code).toBe(7)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe(process.execPath)
    expect(calls[0]?.args[0]).toMatch(/dsh[\\/]lib[\\/]bin\.js$/)
    expect(calls[0]?.args.slice(1)).toEqual(['--profile', 'cli-fixture', '--port', '7777'])
    expect(calls[0]?.options.stdio).toBe('inherit')
    expect(h.packages.installs).toEqual([])
  })
})
