import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  bundle,
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
import { ConfigError } from '../src/config'
import { DshResolveFailure } from '../src/internal/effect/errors'
import {
  DshInstallation,
  PackageManager,
  Preflight,
  SyncLock,
} from '../src/internal/effect/services'
import { preflightLayer } from '../src/preflight'
import { delay, waitFor } from './support/async'
import {
  fakeDsh,
  fakePackageManager,
  fakePreflight,
  fakeSyncLock,
  memoryFileSystem,
} from './support/fakes'
import { planOf } from './support/plan'
import { fakeSpawner } from './support/process'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const fixture = (name: string) => join(root, 'packages/cli/test/fixtures', name, 'eedsh.config.ts')
const generatedManifest = '/home/profiles/cli-fixture/.eedsh/generated/package.json'

function hasAnsi(text: string): boolean {
  return new RegExp(`${String.fromCharCode(27)}[[][0-9;]*m`).test(text)
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
    const loadConfig = (): Effect.Effect<never, Schema.SchemaError> =>
      Effect.fail(new Schema.SchemaError(decoded.failure.issue))
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

describe('config export forms', () => {
  async function writeConfig(source: string): Promise<string> {
    const dir = await tempDir('config-export-')
    const configPath = join(dir, 'eedsh.config.ts')
    await writeFile(configPath, source)
    return configPath
  }

  const successResult = `
import * as Result from 'effect/Result'
export default Result.succeed({
  format: 'eedsh/profile-plan',
  version: 1,
  profile: { name: 'result-export' },
  dsh: '0.2.1-rc.2',
  bundles: [],
  layers: [],
  packages: {},
})
`

  const plainPlan = `
export default {
  format: 'eedsh/profile-plan',
  version: 1,
  profile: { name: 'plain-export' },
  dsh: '0.2.1-rc.2',
  bundles: [],
  layers: [],
  packages: {},
}
`

  const failureResult = `
import { defineProfile } from '@eedsh/config'
export default defineProfile({
  name: '',
  dsh: 'latest',
  bundles: [],
})
`

  const forgedSuccess = `
import * as Result from 'effect/Result'
export default Result.succeed({
  format: 'eedsh/profile-plan',
  version: 1,
  profile: { name: 'forged-export' },
  dsh: 'latest',
  bundles: [],
  layers: [],
  packages: {},
})
`

  const authoringThrow = `
import { validatePlan } from '@eedsh/config'
import * as Result from 'effect/Result'
const result = validatePlan({
  format: 'eedsh/profile-plan',
  version: 1,
  profile: { name: 'thrown-export' },
  dsh: 'latest',
  bundles: [],
  layers: [],
  packages: {},
})
if (Result.isFailure(result)) throw result.failure
export default {}
`

  it('unwraps a successful Result export', async () => {
    const h = harness()
    const configPath = await writeConfig(successResult)
    const code = await runEedsh(['sync', '--config', configPath], h.options)
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile result-export')
    expect(h.fs.files.has('/home/profiles/result-export/.eedsh/generated/package.json')).toBe(true)
  })

  it('accepts a plain plan export', async () => {
    const h = harness()
    const configPath = await writeConfig(plainPlan)
    const code = await runEedsh(['sync', '--config', configPath], h.options)
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('profile plain-export')
    expect(h.fs.files.has('/home/profiles/plain-export/.eedsh/generated/package.json')).toBe(true)
  })

  it('reports a failed Result export with the native schema message', async () => {
    const h = harness()
    const configPath = await writeConfig(failureResult)
    const code = await runEedsh(['sync', '--config', configPath], h.options)
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('profile name "" is not usable as a profile directory')
    expect(errors).toContain('"latest" is not an exact version')
    expect(errors).not.toContain('config.import_failed')
    expect(h.fs.files.size).toBe(0)
  })

  it('revalidates a forged successful Result export', async () => {
    const h = harness()
    const configPath = await writeConfig(forgedSuccess)
    const code = await runEedsh(['sync', '--config', configPath], h.options)
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('"latest" is not an exact version')
    expect(errors).not.toContain('config.import_failed')
    expect(h.fs.files.size).toBe(0)
  })

  it('surfaces a schema failure raised during module evaluation', async () => {
    const h = harness()
    const configPath = await writeConfig(authoringThrow)
    const code = await runEedsh(['sync', '--config', configPath], h.options)
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('"latest" is not an exact version')
    expect(errors).not.toContain('config.import_failed')
    expect(h.fs.files.size).toBe(0)
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

describe('generation record diagnostics', () => {
  const profileDir = '/home/profiles/cli-fixture'
  const recordPath = `${profileDir}/.eedsh/generated/package.json`
  const manifestPath = `${profileDir}/package.json`
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
    const code = await runEedsh(['sync', '--config', fixture('basic')], h.options)
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
    const code = await runEedsh(['sync', '--config', fixture('basic')], h.options)
    expect(code).toBe(1)
    const errors = h.err.join('\n')
    expect(errors).toContain('upgrade eedsh')
    expect(errors).not.toContain('--adopt-ownership')
  })

  it('documents --adopt-ownership in sync help', async () => {
    const h = harness()
    expect(await runEedsh(['sync', '--help'], h.options)).toBe(0)
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
    const code = await runEedsh(
      ['sync', '--config', fixture('basic'), '--adopt-ownership'],
      h.options,
    )
    expect(code).toBe(0)
    const errors = h.err.join('\n')
    expect(errors).toContain('eedsh: notice:')
    expect(errors).toContain(adopted)
    expect(errors).not.toContain('--explain')
  })
})

/** Add the lockfile and installed packages a clean doctor run expects. */
function addPublishedRuntimeState(h: ReturnType<typeof harness>): void {
  const profileDir = '/home/profiles/cli-fixture'
  const record = JSON.parse(
    h.fs.files.get(`${profileDir}/.eedsh/generated/package.json`) ?? '{}',
  ) as { eedsh?: { packages?: Record<string, string> } }
  const packages = record.eedsh?.packages ?? {}
  const entries = Object.entries(packages)
    .map(([name, spec]) => `      '${name}':\n        specifier: ${spec}`)
    .join('\n')
  h.fs.files.set(
    `${profileDir}/pnpm-lock.yaml`,
    `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n${entries}\n`,
  )
  for (const name of Object.keys(packages)) {
    h.fs.files.set(
      `${profileDir}/node_modules/${name}/package.json`,
      `${JSON.stringify({ name, version: '0.0.0' })}\n`,
    )
  }
}

async function syncedProfile() {
  const h = harness()
  expect(await runEedsh(['sync', '--config', fixture('basic')], h.options)).toBe(0)
  addPublishedRuntimeState(h)
  return h
}

function doctorOptions(h: ReturnType<typeof harness>) {
  return {
    ...h.options,
    fileSystem: () => Layer.succeed(FileSystem.FileSystem, h.fs.fs),
  }
}

describe('eedsh doctor', () => {
  const profileDir = '/home/profiles/cli-fixture'
  const profileName = 'cli-fixture'

  it('inspects --profile without evaluating a config', async () => {
    const h = await syncedProfile()
    const code = await runEedsh(['doctor', '--profile', profileName], {
      ...doctorOptions(h),
      loadConfig: () => Effect.die(new Error('doctor --profile must not evaluate the config')),
    })
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('clean: 0 errors, 0 warnings')
  })

  it('takes the profile name from the config', async () => {
    const h = await syncedProfile()
    const code = await runEedsh(['doctor', '--config', fixture('basic')], doctorOptions(h))
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain('clean: 0 errors, 0 warnings')
  })

  it('rejects --profile together with --config as a usage error', async () => {
    const h = harness()
    const code = await runEedsh(
      ['doctor', '--profile', profileName, '--config', fixture('basic')],
      doctorOptions(h),
    )
    expect(code).toBe(2)
    expect(h.err.join('\n')).toContain('--profile')
  })

  it('rejects an unusable profile name as a usage error', async () => {
    const h = harness()
    expect(await runEedsh(['doctor', '--profile', '../escape'], doctorOptions(h))).toBe(2)
    expect(await runEedsh(['doctor', '--profile', 'node_modules'], doctorOptions(h))).toBe(2)
  })

  it('reports a missing profile with exit 1', async () => {
    const h = harness()
    const code = await runEedsh(['doctor', '--profile', 'missing'], doctorOptions(h))
    expect(code).toBe(1)
    expect(h.out.join('\n')).toContain('does not exist')
  })

  it('exits 1 when a finding is an error', async () => {
    const h = await syncedProfile()
    h.fs.files.delete(`${profileDir}/.eedsh/generated/package.json`)
    const code = await runEedsh(['doctor', '--profile', profileName], doctorOptions(h))
    expect(code).toBe(1)
    expect(h.out.join('\n')).toContain('error: record:')
  })

  it('exits 0 with warnings and 1 with --strict', async () => {
    const h = await syncedProfile()
    h.fs.files.delete(`${profileDir}/cordis.yml`)
    expect(await runEedsh(['doctor', '--profile', profileName], doctorOptions(h))).toBe(0)
    expect(h.out.join('\n')).toContain('warning: scaffolding:')
    const strict = await runEedsh(
      ['doctor', '--profile', profileName, '--strict'],
      doctorOptions(h),
    )
    expect(strict).toBe(1)
  })

  it('rejects --explain as a usage error', async () => {
    const h = await syncedProfile()
    const code = await runEedsh(['doctor', '--profile', profileName, '--explain'], doctorOptions(h))
    expect(code).toBe(2)
  })
})

describe('dependency section notices', () => {
  const manifestPath = '/home/profiles/cli-fixture/package.json'

  it('prints a cleanup notice and still reinstalls the profile', async () => {
    const h = harness()
    expect(await runEedsh(['sync', '--config', fixture('basic')], h.options)).toBe(0)
    const installs = h.packages.installs.length
    const manifest = JSON.parse(h.fs.files.get(manifestPath) ?? '{}') as {
      devDependencies?: Record<string, string>
    }
    manifest.devDependencies = { '@eedsh/generated': '^1.0.0' }
    h.fs.files.set(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    expect(await runEedsh(['sync', '--config', fixture('basic')], h.options)).toBe(0)
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
    const code = await runEedsh(['sync', '--config', fixture('basic')], h.options)
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain('unmatched target')
  })

  it('reports a typed failure exactly once', async () => {
    const h = harness({ preflight: { fail: true } })
    const code = await runEedsh(['sync', '--config', fixture('basic')], h.options)
    expect(code).toBe(1)
    expect(h.err.join('\n').match(/unmatched target/g)).toHaveLength(1)
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
    const errors = h.err.join('\n')
    expect(errors).toContain('eedsh: service layer unavailable')
    expect(errors.match(/service layer unavailable/g)).toHaveLength(1)
  })
})

describe('eedsh sync --watch', () => {
  it('reruns on change, retains the last generation on failure, and reuses services', async () => {
    const h = harness()
    const planA = planOf({
      name: 'cli-fixture',
      dsh: '0.2.1-rc.2',
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [insert({ id: 'row-a', name: '@scope/row-a' })])],
    })
    const planB = planOf({
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
    const loadConfig = (): Effect.Effect<ProfilePlan, ConfigError> => {
      call += 1
      if (call === 2) {
        return Effect.fail(new ConfigError('config.import_failed', 'config compile failed'))
      }
      return Effect.succeed(call === 1 ? planA : planB)
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
    const planA = planOf({
      name: 'cli-fixture',
      dsh: '0.2.1-rc.2',
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [layer('cli', [insert({ id: 'row-a', name: '@scope/row-a' })])],
    })
    const planB = planOf({
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
    const loadConfig = (): Effect.Effect<ProfilePlan> => {
      calls += 1
      return Effect.succeed(calls === 1 ? planA : planB)
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
      loadConfig: () => Effect.die(new Error('eedsh check must not evaluate the config')),
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
    const errors = h.err.join('\n')
    expect(errors).toContain('check failed')
    expect(errors).not.toContain('check.')
    expect(h.fs.files.size).toBe(0)
  })

  it('forwards a failed file listing without a check failure code', async () => {
    const h = harness()
    const { spawn } = fakeSpawner({ listingExit: 2, stderr: 'listing failed', listing: '' })
    const code = await runEedsh(['check', '--config', configPath], { ...h.options, spawn })
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
    const exported = Result.isResult(module.default)
      ? Result.getOrThrow(module.default)
      : module.default
    const result = validatePlan(exported)
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
