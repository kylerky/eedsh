import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  bundle,
  defineProfile,
  generated,
  insert,
  layer,
  PLAN_FORMAT,
  PLAN_VERSION,
  type ProfilePlan,
  ProfilePlanSchema,
  validatePlan,
} from '@eedsh/config'
import { Deferred, Effect, Layer } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { beforeAll, describe, expect, it } from 'vitest'
import { runEedsh } from '../src/cli'
import { DshResolveFailure } from '../src/internal/effect/errors'
import {
  DshInstallation,
  PackageManager,
  Preflight,
  SyncLock,
} from '../src/internal/effect/services'
import { preflightLayer } from '../src/preflight'
import type { ReadableLike, SpawnedProcessLike, SpawnLike, SpawnOptionsLike } from '../src/spawn'
import {
  fakeDsh,
  fakePackageManager,
  fakePreflight,
  fakeSyncLock,
  memoryFileSystem,
} from './support/fakes'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const fixture = (name: string) => join(root, 'packages/cli/test/fixtures', name, 'eedsh.config.ts')
const generatedManifest = '/home/profiles/cli-fixture/.eedsh/generated/package.json'

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(50)
  }
  return predicate()
}

function hasAnsi(text: string): boolean {
  return new RegExp(`${String.fromCharCode(27)}[[][0-9;]*m`).test(text)
}

const tempRoot = join(root, 'packages/cli/.tmp')

async function tempDir(prefix: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  return mkdtemp(join(tempRoot, prefix))
}

class FakeStream implements ReadableLike {
  private readonly listeners: ((chunk: unknown) => void)[] = []

  on(_event: 'data', listener: (chunk: unknown) => void): this {
    this.listeners.push(listener)
    return this
  }

  push(value: string): void {
    for (const listener of this.listeners) listener(value)
  }
}

class FakeChild implements SpawnedProcessLike {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  private exitHandler?: (code: number | null, signal: string | null) => void
  private closeHandler?: (code: number | null, signal: string | null) => void
  private errorHandler?: (error: Error) => void

  on(event: 'exit', callback: (code: number | null, signal: string | null) => void): unknown
  on(event: 'close', callback: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', callback: (error: Error) => void): unknown
  on(
    event: 'exit' | 'close' | 'error',
    callback: ((code: number | null, signal: string | null) => void) | ((error: Error) => void),
  ): unknown {
    if (event === 'exit') {
      this.exitHandler = callback as (code: number | null, signal: string | null) => void
    } else if (event === 'close') {
      this.closeHandler = callback as (code: number | null, signal: string | null) => void
    } else {
      this.errorHandler = callback as (error: Error) => void
    }
    return this
  }

  finish(code: number | null, stdout = '', stderr = ''): void {
    this.stdout.push(stdout)
    this.stderr.push(stderr)
    this.closeHandler?.(code, null)
    this.exitHandler?.(code, null)
  }

  fail(error: Error): void {
    this.errorHandler?.(error)
  }

  kill(): boolean {
    return true
  }
}

interface FakeSpawnOptions {
  exitCode?: number
  stdout?: string
  stderr?: string
  listing?: string
  listingExit?: number
}

function fakeSpawner(options: FakeSpawnOptions = {}) {
  const calls: { command: string; args: string[]; options: SpawnOptionsLike }[] = []
  const spawn: SpawnLike = (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions })
    const child = new FakeChild()
    if (args.includes('--listFilesOnly')) {
      const listing = options.listing ?? ''
      const exitCode = options.listingExit ?? 0
      queueMicrotask(() => child.finish(exitCode, listing))
    } else {
      const exitCode = options.exitCode ?? 0
      const stdout = options.stdout ?? ''
      const stderr = options.stderr ?? ''
      queueMicrotask(() => child.finish(exitCode, stdout, stderr))
    }
    return child
  }
  return { calls, spawn }
}

function watchConfigSource(row: string): string {
  return `import { bundle, defineProfile, generated, insert, layer } from '@eedsh/config'

export default defineProfile({
  name: 'cli-watch',
  dsh: '0.2.1-rc.2',
  bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
  layers: [layer('cli', [insert({ id: '${row}', name: '@scope/${row}' })])],
})
`
}

interface HarnessOptions {
  files?: Record<string, string>
  basePatches?: Record<string, unknown>[]
  preflight?: { fail?: boolean; warnings?: string[] }
  packages?: { fail?: boolean; beforeInstall?: (count: number) => Effect.Effect<void> }
  realPreflight?: boolean
  lockHeld?: boolean
  failLayer?: boolean
}

function harness(options: HarnessOptions = {}) {
  const fs = memoryFileSystem(options.files)
  const packages = fakePackageManager(options.packages)
  const dsh = fakeDsh({ patches: options.basePatches ?? [] })
  const preflight = fakePreflight(options.preflight)
  const lock = fakeSyncLock({ held: options.lockHeld ?? false })
  const dshLayer = options.failLayer
    ? Layer.effect(
        DshInstallation,
        Effect.fail(
          new DshResolveFailure({
            packageName: '@deepseek-ai/dsh',
            cause: new Error('missing DSH installation'),
          }),
        ),
      )
    : Layer.succeed(DshInstallation, dsh.shape)
  let constructions = 0
  let finalizers = 0
  const fileSystemLayer = Layer.effect(
    FileSystem.FileSystem,
    Effect.acquireRelease(
      Effect.sync(() => {
        constructions += 1
        return fs.fs
      }),
      () =>
        Effect.sync(() => {
          finalizers += 1
        }),
    ),
  )
  const services = () =>
    Layer.mergeAll(
      fileSystemLayer,
      Layer.effect(
        PackageManager,
        Effect.sync(() => {
          constructions += 1
          return packages.shape
        }),
      ),
      dshLayer,
      options.realPreflight
        ? preflightLayer.pipe(Layer.provide(dshLayer))
        : Layer.succeed(Preflight, preflight.shape),
      Layer.succeed(SyncLock, lock.shape),
    )
  const out: string[] = []
  const err: string[] = []
  const runOptions = {
    env: { DSH_HOME: '/home' },
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
    services,
  }
  return {
    options: runOptions,
    fs,
    packages,
    dsh,
    preflight,
    lock,
    out,
    err,
    constructions: () => constructions,
    finalizers: () => finalizers,
    text: () => ({ out: out.join('\n'), err: err.join('\n') }),
  }
}

beforeAll(async () => {
  if (!existsSync(join(root, 'packages/config/lib/index.js'))) {
    await execFileAsync('pnpm', ['--filter', '@eedsh/config', 'build'], { cwd: root })
  }
}, 120_000)

describe('eedsh sync', () => {
  it('loads a TypeScript config and publishes the profile', async () => {
    const h = harness()
    const code = await runEedsh(['sync', '--config', fixture('basic')], h.options)
    expect(code).toBe(0)
    expect(h.fs.files.has(generatedManifest)).toBe(true)
    expect(h.packages.installs).toEqual(['/home/profiles/cli-fixture'])
    expect(h.out.join('\n')).toContain('cli-fixture')
    expect(h.err.join('\n')).not.toContain('eedsh:')
  })

  it('discovers eedsh.config.ts in the working directory', async () => {
    const h = harness()
    const code = await runEedsh(['sync'], {
      ...h.options,
      cwd: join(root, 'packages/cli/test/fixtures/basic'),
    })
    expect(code).toBe(0)
    expect(h.fs.files.has(generatedManifest)).toBe(true)
  })

  it('reports the native validation message for an invalid config and exits 1', async () => {
    const h = harness()
    const code = await runEedsh(['sync', '--config', fixture('invalid')], h.options)
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('profile name "" is not usable as a profile directory')
    expect(errors).toMatch(/at \["profile"\]/)
    expect(errors).not.toContain('profile.name:')
    expect(errors).not.toMatch(/\(\d+ more\)/)
    expect(h.fs.files.size).toBe(0)
  })

  it('prints every native schema error line without reformatting', async () => {
    const h = harness()
    const decoded = Schema.decodeUnknownResult(ProfilePlanSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })({
      format: PLAN_FORMAT,
      version: PLAN_VERSION,
      profile: { name: '' },
      dsh: 'latest',
      bundles: [],
      layers: [],
      packages: {},
    })
    if (Result.isSuccess(decoded)) expect.unreachable('expected an invalid plan')
    const loadConfig = async (): Promise<ProfilePlan> => {
      throw new Schema.SchemaError(decoded.failure.issue)
    }
    const code = await runEedsh(['sync', '--config', fixture('basic')], {
      ...h.options,
      loadConfig,
    })
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('eedsh: profile name "" is not usable as a profile directory')
    expect(errors).toContain('eedsh: "latest" is not an exact version')
    expect(errors).toMatch(/eedsh: {3}at \["profile"\]/)
    expect(errors).toMatch(/eedsh: {3}at \["dsh"\]/)
    expect(errors).not.toContain('profile.name:')
    expect(errors).not.toMatch(/\(\d+ more\)/)
    expect(h.fs.files.size).toBe(0)
  })

  it('reports a missing config file with exit 1', async () => {
    const h = harness()
    const code = await runEedsh(['sync', '--config', join(root, 'nope/eedsh.config.ts')], h.options)
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('eedsh:')
  })
})

describe('config discovery', () => {
  const rejected = [
    { dir: 'javascript-mjs', name: 'eedsh.config.mjs' },
    { dir: 'javascript-js', name: 'eedsh.config.js' },
  ] as const

  it('selects eedsh.config.ts ahead of eedsh.config.mts', async () => {
    const h = harness()
    const code = await runEedsh(['sync'], {
      ...h.options,
      cwd: join(root, 'packages/cli/test/fixtures/discovery'),
    })
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile discovery-ts')
    expect(h.fs.files.has('/home/profiles/discovery-ts/.eedsh/generated/package.json')).toBe(true)
    expect(h.fs.files.has('/home/profiles/discovery-mts/.eedsh/generated/package.json')).toBe(false)
  })

  it('loads an explicit eedsh.config.mts path', async () => {
    const h = harness()
    const path = join(root, 'packages/cli/test/fixtures/mts/eedsh.config.mts')
    const code = await runEedsh(['sync', '--config', path], h.options)
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile cli-mts')
  })

  for (const { dir, name } of rejected) {
    it(`rejects a discovered ${name} config with a stable code`, async () => {
      const h = harness()
      const code = await runEedsh(['sync'], {
        ...h.options,
        cwd: join(root, 'packages/cli/test/fixtures', dir),
      })
      expect(code).toBe(1)
      const errors = h.err.join('\n')
      expect(errors).toContain('config.unsupported_extension')
      expect(errors).toContain('eedsh.config.ts')
      expect(errors).toContain('eedsh.config.mts')
      expect(h.fs.files.size).toBe(0)
    })

    it(`rejects an explicit ${name} config before evaluation`, async () => {
      const h = harness()
      const path = join(root, 'packages/cli/test/fixtures', dir, name)
      const code = await runEedsh(['sync', '--config', path], h.options)
      expect(code).toBe(1)
      const errors = h.err.join('\n')
      expect(errors).toContain('config.unsupported_extension')
      expect(errors).toContain('eedsh.config.ts')
      expect(errors).toContain('eedsh.config.mts')
      expect(h.fs.files.size).toBe(0)
    })
  }
})

describe('config evaluation', () => {
  it('evaluates non-erasable TypeScript syntax', async () => {
    const h = harness()
    const code = await runEedsh(['sync', '--config', fixture('enum')], h.options)
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile enum-basic')
    expect(h.fs.files.has('/home/profiles/enum-basic/.eedsh/generated/package.json')).toBe(true)
  })

  it('evaluates a config in a CommonJS project', async () => {
    const h = harness()
    const code = await runEedsh(['sync', '--config', fixture('cjs-project')], h.options)
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile cli-cjs')
    expect(h.fs.files.has('/home/profiles/cli-cjs/.eedsh/generated/package.json')).toBe(true)
  })

  it('reports a syntax error as config.import_failed', async () => {
    const dir = await tempDir('syntax-')
    const configPath = join(dir, 'eedsh.config.ts')
    await writeFile(configPath, 'export default {\n')

    const h = harness()
    const code = await runEedsh(['sync', '--config', configPath], h.options)
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('config.import_failed')
    expect(h.fs.files.size).toBe(0)
  })

  it('applies an edited config in watch mode', async () => {
    const dir = await tempDir('watch-')
    const configPath = join(dir, 'eedsh.config.ts')
    await writeFile(configPath, watchConfigSource('row-a'))

    const h = harness()
    let onChange: (() => void) | undefined
    const watch = async (_dir: string, callback: () => void) => {
      onChange = callback
      return {
        close: async () => {},
      }
    }
    const controller = new AbortController()
    const running = runEedsh(['sync', '--config', configPath, '--watch'], {
      ...h.options,
      watch,
      signal: controller.signal,
    })
    const patches = () =>
      [...h.fs.files.entries()]
        .filter(([path]) => path.includes('/.eedsh/generated/patches/'))
        .map(([, content]) => content)

    expect(await waitFor(() => patches().some((patch) => patch.includes('row-a')))).toBe(true)
    await delay(20)
    await writeFile(configPath, watchConfigSource('row-b'))
    onChange?.()

    expect(await waitFor(() => patches().some((patch) => patch.includes('row-b')))).toBe(true)
    controller.abort()
    expect(await running).toBe(0)
  })
})

describe('eedsh arguments', () => {
  it('returns exit 2 for usage errors without ANSI escapes', async () => {
    const h = harness()
    expect(await runEedsh(['bogus'], h.options)).toBe(2)
    expect(await runEedsh(['sync', '--bogus'], h.options)).toBe(2)
    expect(await runEedsh(['sync', '--config'], h.options)).toBe(2)
    const text = `${h.out.join('\n')}\n${h.err.join('\n')}`
    expect(text).toContain('--config')
    expect(hasAnsi(text)).toBe(false)
    expect(h.fs.files.size).toBe(0)
  })

  it('prints no-argument help and command help without ANSI escapes', async () => {
    const noArgs = harness()
    expect(await runEedsh([], noArgs.options)).toBe(0)
    const noArgsText = noArgs.out.join('\n')
    expect(noArgsText).toContain('eedsh')
    expect(noArgsText).toContain('sync')
    expect(noArgsText).toContain('run')
    expect(noArgsText).toContain('check')
    expect(hasAnsi(noArgsText)).toBe(false)

    const help = harness()
    expect(await runEedsh(['--help'], help.options)).toBe(0)
    expect(help.out.join('\n')).toContain('sync')
    expect(hasAnsi(help.out.join('\n'))).toBe(false)

    const checkHelp = harness()
    expect(await runEedsh(['check', '--help'], checkHelp.options)).toBe(0)
    const checkText = checkHelp.out.join('\n')
    expect(checkText).toContain('check')
    expect(checkText).toContain('--config')
    expect(hasAnsi(checkText)).toBe(false)
  })

  it('prints the version without ANSI escapes', async () => {
    const h = harness()
    expect(await runEedsh(['--version'], h.options)).toBe(0)
    expect(h.out.join('\n')).toMatch(/\d+\.\d+\.\d+/)
    expect(hasAnsi(h.out.join('\n'))).toBe(false)
  })

  it('rejects --explain on run and check before spawning', async () => {
    const runHarness = harness()
    const runSpawn = fakeSpawner()
    const runCode = await runEedsh(['run', '--explain', '--config', fixture('basic')], {
      ...runHarness.options,
      spawn: runSpawn.spawn,
    })
    expect(runCode).toBe(2)
    expect(runSpawn.calls).toHaveLength(0)
    expect(runHarness.packages.installs).toEqual([])
    expect(runHarness.fs.files.size).toBe(0)

    const checkHarness = harness()
    const checkSpawn = fakeSpawner()
    const checkCode = await runEedsh(['check', '--explain', '--config', fixture('basic')], {
      ...checkHarness.options,
      spawn: checkSpawn.spawn,
    })
    expect(checkCode).toBe(2)
    expect(checkSpawn.calls).toHaveLength(0)
    expect(checkHarness.fs.files.size).toBe(0)
  })

  it('rejects -- passthrough on sync', async () => {
    const h = harness()
    const code = await runEedsh(['sync', '--', '--strict'], h.options)
    expect(code).toBe(2)
    expect(h.err.join('\n')).toContain('--')
    expect(h.fs.files.size).toBe(0)
  })
})

describe('strict mode', () => {
  const basePatches = [{ insert: [{ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' }] }]

  it('reports raw warnings and a hint but publishes without strict mode', async () => {
    const h = harness({ basePatches, realPreflight: true })
    const code = await runEedsh(['sync', '--config', fixture('unmatched')], h.options)
    expect(code).toBe(0)
    const errors = h.err.join('\n')
    expect(errors).toContain('missing-row')
    expect(errors).not.toContain('generated:cli:')
    expect(errors).toContain('--explain')
    expect(h.fs.files.has('/home/profiles/cli-unmatched/.eedsh/generated/package.json')).toBe(true)
  })

  it('attributes warnings with --explain and omits the hint', async () => {
    const h = harness({ basePatches, realPreflight: true })
    const code = await runEedsh(['sync', '--explain', '--config', fixture('unmatched')], h.options)
    expect(code).toBe(0)
    const errors = h.err.join('\n')
    expect(errors).toContain('generated:cli:')
    expect(errors).toContain('missing-row')
    expect(errors).not.toContain('--explain')
    expect(h.fs.files.has('/home/profiles/cli-unmatched/.eedsh/generated/package.json')).toBe(true)
  })

  it('keeps strict failures raw and prints the hint', async () => {
    const h = harness({ basePatches, realPreflight: true })
    const code = await runEedsh(['sync', '--strict', '--config', fixture('unmatched')], h.options)
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('missing-row')
    expect(errors).not.toContain('generated:cli:')
    expect(errors).toContain('--explain')
    expect(h.fs.files.has('/home/profiles/cli-unmatched/.eedsh/generated/package.json')).toBe(false)
  })

  it('attributes strict failures with --strict --explain and omits the hint', async () => {
    const h = harness({ basePatches, realPreflight: true })
    const code = await runEedsh(
      ['sync', '--strict', '--explain', '--config', fixture('unmatched')],
      h.options,
    )
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('generated:cli:')
    expect(errors).toContain('missing-row')
    expect(errors).not.toContain('--explain')
    expect(h.fs.files.has('/home/profiles/cli-unmatched/.eedsh/generated/package.json')).toBe(false)
  })

  it('publishes with --explain when there are no warnings', async () => {
    const h = harness({ basePatches, realPreflight: true })
    const code = await runEedsh(['sync', '--explain', '--config', fixture('basic')], h.options)
    expect(code).toBe(0)
    expect(h.err.join('\n')).not.toContain('warning:')
    expect(h.err.join('\n')).not.toContain('--explain')
    expect(h.fs.files.has('/home/profiles/cli-fixture/.eedsh/generated/package.json')).toBe(true)
  })
})

describe('tagged failures', () => {
  it('maps a preflight failure to a diagnostic and exit 1', async () => {
    const h = harness({ preflight: { fail: true } })
    const code = await runEedsh(['sync', '--config', fixture('basic')], h.options)
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('unmatched target')
  })

  it('maps a held sync lock to a diagnostic naming the path and no PID', async () => {
    const h = harness({ lockHeld: true })
    const code = await runEedsh(['sync', '--config', fixture('basic')], h.options)
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('another sync is running')
    expect(errors).toContain('/home/profiles/cli-fixture/.eedsh/sync.lock')
    expect(errors).not.toMatch(/pid/i)
  })

  it('maps a package failure to a diagnostic and exit 1', async () => {
    const h = harness({ packages: { fail: true } })
    const code = await runEedsh(['sync', '--config', fixture('basic')], h.options)
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('package install')
  })

  it('reports an unexpected command failure and exits 1', async () => {
    const h = harness()
    const code = await runEedsh(['sync', '--config', fixture('basic')], {
      ...h.options,
      services: () => {
        throw new Error('service layer unavailable')
      },
    })
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('eedsh: service layer unavailable')
  })
})

describe('eedsh sync --watch', () => {
  it('reruns on change, retains the last generation on failure, and reuses services', async () => {
    const h = harness()
    const planA = defineProfile({
      name: 'cli-fixture',
      dsh: '0.2.1-rc.2',
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [insert({ id: 'row-a', name: '@scope/row-a' })])],
    })
    const planB: ProfilePlan = defineProfile({
      name: 'cli-fixture',
      dsh: '0.2.1-rc.2',
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [insert({ id: 'row-b', name: '@scope/row-b' })])],
    })

    let onChange: (() => void) | undefined
    let closed = 0
    const watch = async (_dir: string, callback: () => void) => {
      onChange = callback
      return {
        close: async () => {
          closed += 1
        },
      }
    }
    let call = 0
    const loadConfig = async (): Promise<ProfilePlan> => {
      call += 1
      if (call === 2) throw new Error('config compile failed')
      return call === 1 ? planA : planB
    }
    const controller = new AbortController()
    const running = runEedsh(['sync', '--config', fixture('basic'), '--watch'], {
      ...h.options,
      loadConfig,
      watch,
      signal: controller.signal,
    })

    expect(await waitFor(() => h.fs.files.has(generatedManifest))).toBe(true)
    const first = h.fs.files.get(generatedManifest)
    const constructions = h.constructions()

    onChange?.()
    expect(await waitFor(() => h.err.join('\n').includes('config compile failed'))).toBe(true)
    expect(h.fs.files.get(generatedManifest)).toBe(first)

    onChange?.()
    expect(await waitFor(() => h.fs.files.get(generatedManifest) !== first)).toBe(true)
    expect(h.constructions()).toBe(constructions)

    controller.abort()
    expect(await running).toBe(0)
    expect(closed).toBe(1)
  })

  it('releases the layer and reports when the watcher cannot start', async () => {
    const h = harness()
    const watch = async () => {
      throw new Error('watcher failed')
    }
    const code = await runEedsh(['sync', '--config', fixture('basic'), '--watch'], {
      ...h.options,
      watch,
    })
    expect(code).toBe(1)
    expect(h.packages.installs).toEqual([])
    expect(h.fs.files.size).toBe(0)
    expect(h.finalizers()).toBe(1)
    expect(h.err.join('\n')).toContain('watcher failed')
  })

  it('releases the layer and skips the watcher when the service layer cannot be built', async () => {
    const h = harness({ failLayer: true })
    let watchCalls = 0
    const watch = async () => {
      watchCalls += 1
      return { close: async () => {} }
    }
    const code = await runEedsh(['sync', '--config', fixture('basic'), '--watch'], {
      ...h.options,
      watch,
      signal: AbortSignal.abort(),
    })
    expect(code).toBe(1)
    expect(watchCalls).toBe(0)
    expect(h.packages.installs).toEqual([])
    expect(h.fs.files.size).toBe(0)
    expect(h.finalizers()).toBe(1)
    expect(h.err.join('\n')).toContain('cannot resolve DSH package')
  })

  it('starts the initial sync only after the watcher is ready', async () => {
    const h = harness()
    let releaseWatcher: (() => void) | undefined
    const watcherReady = new Promise<void>((resolve) => {
      releaseWatcher = resolve
    })
    let watchCalled = false
    const watch = async () => {
      watchCalled = true
      await watcherReady
      return { close: async () => {} }
    }
    const controller = new AbortController()
    const running = runEedsh(['sync', '--config', fixture('basic'), '--watch'], {
      ...h.options,
      watch,
      signal: controller.signal,
    })

    expect(await waitFor(() => watchCalled)).toBe(true)
    const installsBeforeReady = h.packages.installs.length
    releaseWatcher?.()
    expect(installsBeforeReady).toBe(0)
    expect(h.fs.files.size).toBe(0)
    expect(await waitFor(() => h.fs.files.has(generatedManifest))).toBe(true)

    controller.abort()
    expect(await running).toBe(0)
  })

  it('runs exactly one follow-up sync when a change arrives during the initial sync', async () => {
    const gate = Effect.runSync(Deferred.make<void>())
    const h = harness({
      packages: { beforeInstall: (count) => (count === 1 ? Deferred.await(gate) : Effect.void) },
    })
    let onChange: (() => void) | undefined
    const watch = async (_dir: string, callback: () => void) => {
      onChange = callback
      return { close: async () => {} }
    }
    const controller = new AbortController()
    const running = runEedsh(['sync', '--config', fixture('basic'), '--watch'], {
      ...h.options,
      watch,
      signal: controller.signal,
    })
    const runs = () =>
      h.out.filter(
        (line) => line.startsWith('eedsh: published') || line.startsWith('eedsh: unchanged'),
      ).length

    expect(await waitFor(() => h.packages.installs.length === 1)).toBe(true)
    const hasOnChange = typeof onChange === 'function'
    onChange?.()
    await Effect.runPromise(Deferred.succeed(gate, undefined))
    expect(hasOnChange).toBe(true)
    expect(await waitFor(() => runs() === 2)).toBe(true)
    await delay(100)
    expect(runs()).toBe(2)

    controller.abort()
    expect(await running).toBe(0)
  })

  it('coalesces a burst of changes during a sync into one follow-up sync', async () => {
    const gate = Effect.runSync(Deferred.make<void>())
    const h = harness({
      packages: { beforeInstall: (count) => (count === 1 ? Deferred.await(gate) : Effect.void) },
    })
    let onChange: (() => void) | undefined
    const watch = async (_dir: string, callback: () => void) => {
      onChange = callback
      return { close: async () => {} }
    }
    const controller = new AbortController()
    const running = runEedsh(['sync', '--config', fixture('basic'), '--watch'], {
      ...h.options,
      watch,
      signal: controller.signal,
    })
    const runs = () =>
      h.out.filter(
        (line) => line.startsWith('eedsh: published') || line.startsWith('eedsh: unchanged'),
      ).length

    expect(await waitFor(() => h.packages.installs.length === 1)).toBe(true)
    const hasOnChange = typeof onChange === 'function'
    onChange?.()
    onChange?.()
    onChange?.()
    await Effect.runPromise(Deferred.succeed(gate, undefined))
    expect(hasOnChange).toBe(true)
    expect(await waitFor(() => runs() === 2)).toBe(true)
    await delay(100)
    expect(runs()).toBe(2)

    controller.abort()
    expect(await running).toBe(0)
  })

  it('interrupts an in-flight rerun and releases the lock, watcher, and layer', async () => {
    const gate = Effect.runSync(Deferred.make<void>())
    const h = harness({
      packages: { beforeInstall: (count) => (count === 2 ? Deferred.await(gate) : Effect.void) },
    })
    const planA = defineProfile({
      name: 'cli-fixture',
      dsh: '0.2.1-rc.2',
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [insert({ id: 'row-a', name: '@scope/row-a' })])],
    })
    const planB: ProfilePlan = defineProfile({
      name: 'cli-fixture',
      dsh: '0.2.1-rc.2',
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [insert({ id: 'row-b', name: '@scope/row-b' })])],
      packages: { '@scope/plugin': '1.0.0' },
    })
    let onChange: (() => void) | undefined
    let closed = 0
    const watch = async (_dir: string, callback: () => void) => {
      onChange = callback
      return {
        close: async () => {
          closed += 1
        },
      }
    }
    let calls = 0
    const loadConfig = async (): Promise<ProfilePlan> => {
      calls += 1
      return calls === 1 ? planA : planB
    }
    const controller = new AbortController()
    const running = runEedsh(['sync', '--config', fixture('basic'), '--watch'], {
      ...h.options,
      loadConfig,
      watch,
      signal: controller.signal,
    })

    await waitFor(() => h.fs.files.has(generatedManifest))
    onChange?.()
    const started = await waitFor(() => h.packages.installs.length === 2)

    controller.abort()
    const code = await running
    const lockHeldAtStop = h.lock.isHeld()
    const releasesAtStop = [...h.lock.releases]
    const watcherClosesAtStop = closed
    const layerFinalizersAtStop = h.finalizers()
    await Effect.runPromise(Deferred.succeed(gate, undefined))

    expect(code).toBe(0)
    expect(started).toBe(true)
    expect(lockHeldAtStop).toBe(false)
    expect(releasesAtStop).toContain('/home/profiles/cli-fixture/.eedsh/sync.lock')
    expect(watcherClosesAtStop).toBe(1)
    expect(layerFinalizersAtStop).toBe(1)
  })

  it('warns but exits 0 when the watcher fails to close on a normal stop', async () => {
    const h = harness()
    let closed = 0
    const watch = async () => ({
      close: async () => {
        closed += 1
        throw new Error('close failed')
      },
    })
    const controller = new AbortController()
    const running = runEedsh(['sync', '--config', fixture('basic'), '--watch'], {
      ...h.options,
      watch,
      signal: controller.signal,
    })

    expect(await waitFor(() => h.fs.files.has(generatedManifest))).toBe(true)
    controller.abort()

    expect(await running).toBe(0)
    expect(closed).toBe(1)
    expect(h.err.join('\n')).toContain('warning: close failed')
    expect(h.finalizers()).toBe(1)
  })
})

describe('eedsh check', () => {
  const configPath = fixture('basic')

  it('prints the resolved invocation and runs the compiler without materializing', async () => {
    const h = harness()
    const { calls, spawn } = fakeSpawner({ listing: `${configPath}\n` })
    const code = await runEedsh(['check', '--config', configPath, '--', '--pretty', 'false'], {
      ...h.options,
      spawn,
      loadConfig: async () => {
        throw new Error('eedsh check must not evaluate the config')
      },
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
    const code = await runEedsh(['check', '--config', configPath], { ...h.options, spawn })
    expect(code).toBe(2)
    expect(h.err.join('\n')).toContain('check failed')
    expect(h.fs.files.size).toBe(0)
  })
})

describe('eedsh check failures', () => {
  async function externalProject(configSource: string, tsconfig?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'eedsh-check-'))
    const configPath = join(dir, 'eedsh.config.ts')
    await writeFile(configPath, configSource)
    if (tsconfig !== undefined) await writeFile(join(dir, 'tsconfig.json'), tsconfig)
    return configPath
  }

  it('fails with config.not_found for a missing config', async () => {
    const h = harness()
    const { calls, spawn } = fakeSpawner()
    const code = await runEedsh(['check', '--config', join(root, 'nope/eedsh.config.ts')], {
      ...h.options,
      spawn,
    })
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('config.not_found')
    expect(calls).toHaveLength(0)
  })

  it('fails with check.tsconfig_missing when no tsconfig is found', async () => {
    const configPath = await externalProject('export default {}\n')
    const h = harness()
    const { calls, spawn } = fakeSpawner()
    const code = await runEedsh(['check', '--config', configPath], { ...h.options, spawn })
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('check.tsconfig_missing')
    expect(h.err.join('\n')).toContain('tsconfig.json')
    expect(calls).toHaveLength(0)
  })

  it('fails with check.typescript_missing when the project has no TypeScript', async () => {
    const configPath = await externalProject('export default {}\n', '{}\n')
    const h = harness()
    const { calls, spawn } = fakeSpawner()
    const code = await runEedsh(['check', '--config', configPath], { ...h.options, spawn })
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('check.typescript_missing')
    expect(h.err.join('\n')).toContain('install')
    expect(calls).toHaveLength(0)
  })

  it('fails with check.config_not_in_project when the tsconfig excludes the config', async () => {
    const h = harness()
    const { calls, spawn } = fakeSpawner({ listing: '/home/project/src/index.ts\n' })
    const code = await runEedsh(['check', '--config', fixture('basic')], { ...h.options, spawn })
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('check.config_not_in_project')
    expect(h.err.join('\n')).toContain(join(root, 'tsconfig.json'))
    expect(calls).toHaveLength(1)
  })
})

describe('documentation', () => {
  it('keeps the README example a valid plan', async () => {
    const example = './fixtures/readme/eedsh.config.ts'
    const module = (await import(example)) as { default: unknown }
    const result = validatePlan(module.default)
    expect(Result.isSuccess(result)).toBe(true)
  })
})

describe('eedsh run', () => {
  it('forwards dsh arguments through an injected spawn', async () => {
    const h = harness()
    const { calls, spawn } = fakeSpawner({ exitCode: 7 })
    const code = await runEedsh(
      ['run', '--config', fixture('basic'), '--no-sync', '--', '--port', '7777'],
      { ...h.options, spawn },
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
