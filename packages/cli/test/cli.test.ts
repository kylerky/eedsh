import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  bundle,
  defineProfile,
  generated,
  insert,
  layer,
  type ProfilePlan,
  validatePlan,
} from '@eedsh/config'
import { Effect, Layer } from 'effect'
import { beforeAll, describe, expect, it } from 'vitest'
import { runCli, type SpawnedProcessLike, type SpawnLike } from '../src/cli.js'
import {
  DshInstallation,
  FileSystem,
  PackageManager,
  Preflight,
} from '../src/internal/effect/services.js'
import { preflightLayer } from '../src/preflight.js'
import { fakeDsh, fakePackageManager, fakePreflight, memoryFileSystem } from './support/fakes.js'

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

const tempRoot = join(root, 'packages/cli/.tmp')

async function tempDir(prefix: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  return mkdtemp(join(tempRoot, prefix))
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
  packages?: { fail?: boolean }
  realPreflight?: boolean
}

function harness(options: HarnessOptions = {}) {
  const fs = memoryFileSystem(options.files)
  const packages = fakePackageManager(options.packages)
  const dsh = fakeDsh({ patches: options.basePatches ?? [] })
  const preflight = fakePreflight(options.preflight)
  const dshLayer = Layer.succeed(DshInstallation, dsh.shape)
  let constructions = 0
  const services = () =>
    Layer.mergeAll(
      Layer.effect(
        FileSystem,
        Effect.sync(() => {
          constructions += 1
          return fs.shape
        }),
      ),
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
    )
  const out: string[] = []
  const err: string[] = []
  const deps = {
    env: { DSH_HOME: '/home' },
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
    services,
  }
  return {
    deps,
    fs,
    packages,
    dsh,
    preflight,
    out,
    err,
    constructions: () => constructions,
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
    const code = await runCli(['sync', '--config', fixture('basic')], h.deps)
    expect(code).toBe(0)
    expect(h.fs.files.has(generatedManifest)).toBe(true)
    expect(h.packages.installs).toEqual(['/home/profiles/cli-fixture'])
    expect(h.out.join('\n')).toContain('cli-fixture')
    expect(h.err.join('\n')).not.toContain('eedsh:')
  })

  it('discovers eedsh.config.ts in the working directory', async () => {
    const h = harness()
    const code = await runCli(['sync'], {
      ...h.deps,
      cwd: join(root, 'packages/cli/test/fixtures/basic'),
    })
    expect(code).toBe(0)
    expect(h.fs.files.has(generatedManifest)).toBe(true)
  })

  it('reports an invalid config with a stable code and exit 1', async () => {
    const h = harness()
    const code = await runCli(['sync', '--config', fixture('invalid')], h.deps)
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('plan.missing_profile_name')
    expect(h.fs.files.size).toBe(0)
  })

  it('reports a missing config file with exit 1', async () => {
    const h = harness()
    const code = await runCli(['sync', '--config', join(root, 'nope/eedsh.config.ts')], h.deps)
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
    const code = await runCli(['sync'], {
      ...h.deps,
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
    const code = await runCli(['sync', '--config', path], h.deps)
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile cli-mts')
  })

  for (const { dir, name } of rejected) {
    it(`rejects a discovered ${name} config with a stable code`, async () => {
      const h = harness()
      const code = await runCli(['sync'], {
        ...h.deps,
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
      const code = await runCli(['sync', '--config', path], h.deps)
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
    const code = await runCli(['sync', '--config', fixture('enum')], h.deps)
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile enum-basic')
    expect(h.fs.files.has('/home/profiles/enum-basic/.eedsh/generated/package.json')).toBe(true)
  })

  it('evaluates a config in a CommonJS project', async () => {
    const h = harness()
    const code = await runCli(['sync', '--config', fixture('cjs-project')], h.deps)
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile cli-cjs')
    expect(h.fs.files.has('/home/profiles/cli-cjs/.eedsh/generated/package.json')).toBe(true)
  })

  it('reports a syntax error as config.import_failed', async () => {
    const dir = await tempDir('syntax-')
    const configPath = join(dir, 'eedsh.config.ts')
    await writeFile(configPath, 'export default {\n')

    const h = harness()
    const code = await runCli(['sync', '--config', configPath], h.deps)
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
    const running = runCli(['sync', '--config', configPath, '--watch'], {
      ...h.deps,
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
  it('returns exit 2 for usage errors', async () => {
    const h = harness()
    expect(await runCli(['bogus'], h.deps)).toBe(2)
    expect(await runCli(['sync', '--bogus'], h.deps)).toBe(2)
    expect(await runCli(['sync', '--config'], h.deps)).toBe(2)
    expect(h.fs.files.size).toBe(0)
  })

  it('prints help and version', async () => {
    const help = harness()
    expect(await runCli(['--help'], help.deps)).toBe(0)
    expect(help.out.join('\n')).toContain('eedsh sync')
    const version = harness()
    expect(await runCli(['--version'], version.deps)).toBe(0)
    expect(version.out.join('\n')).toMatch(/\d+\.\d+\.\d+/)
  })
})

describe('strict mode', () => {
  const basePatches = [{ insert: [{ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' }] }]

  it('warns about unmatched targets but publishes without strict mode', async () => {
    const h = harness({ basePatches, realPreflight: true })
    const code = await runCli(['sync', '--config', fixture('unmatched')], h.deps)
    expect(code).toBe(0)
    expect(h.err.join('\n')).toContain('missing-row')
    expect(h.fs.files.has('/home/profiles/cli-unmatched/.eedsh/generated/package.json')).toBe(true)
  })

  it('fails without publishing in strict mode', async () => {
    const h = harness({ basePatches, realPreflight: true })
    const code = await runCli(['sync', '--strict', '--config', fixture('unmatched')], h.deps)
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('missing-row')
    expect(h.fs.files.has('/home/profiles/cli-unmatched/.eedsh/generated/package.json')).toBe(false)
  })
})

describe('tagged failures', () => {
  it('maps a preflight failure to a diagnostic and exit 1', async () => {
    const h = harness({ preflight: { fail: true } })
    const code = await runCli(['sync', '--config', fixture('basic')], h.deps)
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('unmatched target')
  })

  it('maps a held sync lock to a diagnostic and exit 1', async () => {
    const h = harness({
      files: {
        '/home/profiles/cli-fixture/.eedsh/sync.lock': JSON.stringify({ pid: process.pid }),
      },
    })
    const code = await runCli(['sync', '--config', fixture('basic')], h.deps)
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('another sync')
  })

  it('maps a package failure to a diagnostic and exit 1', async () => {
    const h = harness({ packages: { fail: true } })
    const code = await runCli(['sync', '--config', fixture('basic')], h.deps)
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('package install')
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
    const running = runCli(['sync', '--config', fixture('basic'), '--watch'], {
      ...h.deps,
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
})

describe('documentation', () => {
  it('keeps the README example a valid plan', async () => {
    const example = './fixtures/readme/eedsh.config.ts'
    const module = (await import(example)) as { default: unknown }
    const result = validatePlan(module.default)
    expect(result.ok).toBe(true)
  })
})

describe('eedsh run', () => {
  it('forwards dsh arguments through an injected spawn', async () => {
    const h = harness()
    const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = []
    class FakeChild implements SpawnedProcessLike {
      exit?: (code: number | null, signal: string | null) => void
      error?: (error: Error) => void

      on(event: 'exit', callback: (code: number | null, signal: string | null) => void): unknown
      on(event: 'error', callback: (error: Error) => void): unknown
      on(event: 'exit' | 'error', callback: unknown): unknown {
        if (event === 'exit') {
          this.exit = callback as (code: number | null, signal: string | null) => void
        } else {
          this.error = callback as (error: Error) => void
        }
        return this
      }

      kill(): boolean {
        return true
      }
    }

    const spawn: SpawnLike = (command, args, options) => {
      calls.push({ command, args, options: options as Record<string, unknown> })
      const child = new FakeChild()
      queueMicrotask(() => child.exit?.(7, null))
      return child
    }
    const code = await runCli(
      ['run', '--config', fixture('basic'), '--no-sync', '--', '--port', '7777'],
      { ...h.deps, spawn },
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
