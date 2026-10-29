import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  defineConfig,
  PresetDefinitionError,
  ResolutionError,
  takeResolutionTrace,
} from '@eedsh/config'
import type { EedshConfig, ProfilePlan } from '@eedsh/plan'
import { Effect } from 'effect'
import * as Result from 'effect/Result'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError } from '../../src/config'
import { runReplLoop } from '../../src/repl/prompt'
import {
  type ReplConfigFailure,
  ReplSession,
  ReplSessionError,
  type SyncOutcome,
} from '../../src/repl/session'
import { waitFor } from '../support/async'

const root = process.cwd()
const tempRoot = join(root, 'packages/cli/.tmp')
let work = ''
const sessions: ReplSession[] = []

function configWith(rows: readonly string[], defaultProfile?: 'work'): EedshConfig {
  const builder = defineConfig().dsh('0.2.1-rc.2')
  if (defaultProfile !== undefined) builder.defaultProfile(defaultProfile)
  const result = builder
    .profile('work', (profile) => {
      profile
        .bundle('@deepseek-ai/dsh-base')
        .generated()
        .layer('work', (layer) => {
          for (const id of rows) layer.insert({ id, name: `@scope/${id}` })
        })
    })
    .build()
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

function configWithProfiles(names: readonly string[], defaultProfile?: string): EedshConfig {
  const builder = defineConfig().dsh('0.2.1-rc.2')
  if (defaultProfile !== undefined) builder.defaultProfile(defaultProfile)
  for (const name of names) builder.profile(name, (profile) => profile.generated())
  const result = builder.build()
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

function loaded(config: EedshConfig) {
  return { config, provenance: undefined, configDir: work }
}

function rowsOf(plan: ProfilePlan): number {
  let count = 0
  for (const item of plan.layers) {
    for (const patch of item.patches) {
      if (Array.isArray(patch.insert)) count += patch.insert.length
    }
  }
  return count
}

const authoring = {
  module: {
    defineConfig: () => 'bound-define-config',
    definePreset: () => 'bound-define-preset',
    marker: 42,
  },
  packagePath: '/fake/@eedsh/config/package.json',
  entryPath: '/fake/@eedsh/config/index.js',
  version: '0.0.0',
}

interface Harness {
  session: ReplSession
  out: string[]
  err: string[]
  loads: () => number
  setConfig: (config: EedshConfig) => void
  setFailure: (error: ReplConfigFailure) => void
  syncs: ProfilePlan[]
}

async function session(
  options: {
    config?: EedshConfig
    profile?: string
    sync?: boolean
    syncPlan?: (plan: ProfilePlan) => Promise<SyncOutcome>
    watch?: (dir: string, onChange: () => void) => Promise<{ close(): Promise<void> }>
    installPreview?: (dir: string) => Promise<void>
    watchConfig?: boolean
    authoringModule?: Record<string, unknown>
  } = {},
): Promise<Harness> {
  let current = options.config ?? configWith(['a'])
  let failure: ReplConfigFailure | undefined
  let loadCount = 0
  const out: string[] = []
  const err: string[] = []
  const syncs: ProfilePlan[] = []
  const created = await ReplSession.create({
    configPath: join(work, 'config.ts'),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    sync: options.sync ?? false,
    env: { DSH_HOME: join(work, 'home') },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    loadConfig: () => {
      loadCount += 1
      return failure === undefined ? Effect.succeed(loaded(current)) : Effect.fail(failure)
    },
    compose: async (plan) => ({ rowCount: rowsOf(plan), warnings: [] }),
    syncPlan:
      options.syncPlan ??
      (async (plan) => {
        syncs.push(plan)
        return { changed: true, generationId: 'abcdef0123456789' }
      }),
    ...(options.watch === undefined ? {} : { watch: options.watch }),
    ...(options.installPreview === undefined ? {} : { installPreview: options.installPreview }),
    cacheRoot: join(work, 'cache'),
    authoring:
      options.authoringModule === undefined
        ? authoring
        : { ...authoring, module: options.authoringModule },
    watchConfig: options.watchConfig ?? false,
  })
  sessions.push(created)
  return {
    session: created,
    out,
    err,
    loads: () => loadCount,
    setConfig: (config) => {
      current = config
      failure = undefined
    },
    setFailure: (error) => {
      failure = error
    },
    syncs,
  }
}

beforeEach(async () => {
  await mkdir(tempRoot, { recursive: true })
  work = await mkdtemp(join(tempRoot, 'session-'))
  await mkdir(join(work, 'home', 'profiles', 'work'), { recursive: true })
  await writeFile(
    join(work, 'home', 'profiles', 'work', 'package.json'),
    JSON.stringify({ name: 'dsh-profile-work', private: true }),
  )
})

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((item) => item.close()))
  await rm(work, { recursive: true, force: true })
})

describe('session evaluation', () => {
  it('evaluates annotated and awaited expressions and keeps bindings', async () => {
    const h = await session()
    expect(await h.session.evaluate('const x: number = 2; x')).toBe(2)
    expect(await h.session.evaluate('x + 5')).toBe(7)
    expect(await h.session.evaluate('await Promise.resolve(9)')).toBe(9)
    expect(await h.session.evaluate('config.dsh')).toBe('0.2.1-rc.2')
    expect(await h.session.evaluate('typeof marker')).toBe('undefined')
    expect(await h.session.evaluate('typeof defineConfig')).toBe('function')
    expect(await h.session.evaluate('typeof definePreset')).toBe('function')
    expect(await h.session.evaluate('definePreset()')).toBe('bound-define-preset')
  })

  it('selects the default profile and reports ambiguity or an unknown name', async () => {
    const defaulted = await session({
      config: configWithProfiles(['work', 'home'], 'home'),
    })
    expect(defaulted.session.profile).toBe('home')

    await expect(
      ReplSession.create({
        configPath: join(work, 'config.ts'),
        env: { DSH_HOME: join(work, 'home') },
        stdout: () => {},
        stderr: () => {},
        loadConfig: () => Effect.succeed(loaded(configWithProfiles(['work', 'home']))),
        authoring,
        watchConfig: false,
      }),
    ).rejects.toMatchObject({ code: 'repl.profile_selection' })

    await expect(
      ReplSession.create({
        configPath: join(work, 'config.ts'),
        profile: 'missing',
        env: { DSH_HOME: join(work, 'home') },
        stdout: () => {},
        stderr: () => {},
        loadConfig: () => Effect.succeed(loaded(configWithProfiles(['work']))),
        authoring,
        watchConfig: false,
      }),
    ).rejects.toBeInstanceOf(ReplSessionError)
  })

  it('loads the authoring package installed in the config project', async () => {
    const configDir = await mkdtemp(join(tempRoot, 'authoring-'))
    const packageDir = join(configDir, 'node_modules', '@eedsh', 'config')
    await mkdir(packageDir, { recursive: true })
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@eedsh/config',
        version: '9.9.9',
        type: 'module',
        exports: { '.': './index.js', './package.json': './package.json' },
      }),
    )
    await writeFile(
      join(packageDir, 'index.js'),
      "export const defineConfig = () => 'bound'\nexport const marker = 99\n",
    )
    const created = await ReplSession.create({
      configPath: join(configDir, 'config.ts'),
      env: { DSH_HOME: join(work, 'home') },
      stdout: () => {},
      stderr: () => {},
      loadConfig: () => Effect.succeed(loaded(configWith(['a']))),
      compose: async () => ({ rowCount: 1, warnings: [] }),
      watchConfig: false,
    })
    sessions.push(created)
    expect(created.authoring.version).toBe('9.9.9')
    expect(created.authoring.entryPath).toBe(join(packageDir, 'index.js'))
    expect(await created.evaluate('defineConfig()')).toBe('bound')
    expect((await created.evaluateOutcome('marker')).ok).toBe(false)
    await rm(configDir, { recursive: true, force: true })
  })

  it('fails structurally when the config project has no authoring package', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'eedsh-authoring-missing-'))
    try {
      await expect(
        ReplSession.create({
          configPath: join(configDir, 'config.ts'),
          env: { DSH_HOME: join(work, 'home') },
          stdout: () => {},
          stderr: () => {},
          loadConfig: () => Effect.succeed(loaded(configWith(['a']))),
          watchConfig: false,
        }),
      ).rejects.toMatchObject({ code: 'repl.authoring_package_missing' })
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  })
})

describe('typed domain bindings', () => {
  it('binds config, selectedProfile, and plan', async () => {
    const h = await session({ config: configWithProfiles(['work', 'home'], 'work') })
    expect(await h.session.evaluate('config.dsh')).toBe('0.2.1-rc.2')
    expect(await h.session.evaluate('config.profiles().map((profile) => profile.name)')).toEqual([
      'work',
      'home',
    ])
    expect(await h.session.evaluate('selectedProfile.name')).toBe('work')
    expect(await h.session.evaluate('plan.profile.name')).toBe('work')
    expect(await h.session.evaluate('selectedProfile.bundles().length')).toBe(0)
    expect(await h.session.evaluate('selectedProfile.layers().length')).toBe(0)
  })

  it('does not bind the legacy profile string or the raw profiles map', async () => {
    const h = await session()
    expect(await h.session.evaluate('typeof profile')).toBe('undefined')
    const legacy = await h.session.evaluateOutcome('profile')
    expect(legacy.ok).toBe(false)
    const raw = await h.session.evaluateOutcome('profiles')
    expect(raw.ok).toBe(false)
    expect(await h.session.evaluate('1 + 1')).toBe(2)
  })

  it('binds definePreset only when the authoring package exports it', async () => {
    const without = await session({ authoringModule: { defineConfig: () => undefined } })
    expect(await without.session.evaluate('typeof definePreset')).toBe('undefined')
    const withIt = await session({
      authoringModule: { defineConfig: () => undefined, definePreset: () => 'bound' },
    })
    expect(await withIt.session.evaluate('typeof definePreset')).toBe('function')
    expect(await withIt.session.evaluate('definePreset()')).toBe('bound')
  })

  it('keeps bindings current after reload', async () => {
    const h = await session()
    h.setConfig(configWith(['a', 'b']))
    await h.session.reload()
    expect(await h.session.evaluate('selectedProfile.layers()[0].patches.length')).toBe(2)
    expect(await h.session.evaluate('selectedProfile.layers()[0].patches[1].insert[0].id')).toBe(
      'b',
    )
  })

  it('fails loudly when the authoring module collides with a binding', async () => {
    await expect(
      session({
        authoringModule: {
          config: {},
          defineConfig: () => undefined,
          definePreset: () => undefined,
        },
      }),
    ).rejects.toMatchObject({ code: 'repl.binding_collision' })
    await expect(
      session({
        authoringModule: {
          selectedProfile: {},
          defineConfig: () => undefined,
          definePreset: () => undefined,
        },
      }),
    ).rejects.toMatchObject({ code: 'repl.binding_collision' })
    await expect(
      session({
        authoringModule: { plan: {}, defineConfig: () => undefined, definePreset: () => undefined },
      }),
    ).rejects.toMatchObject({ code: 'repl.binding_collision' })
  })
})

describe('authoring failure formatting', () => {
  it('reports a preserved resolution failure by code instead of a config import failure', async () => {
    const h = await session()
    h.setFailure(
      new ResolutionError({
        code: 'resolution.preset_not_found',
        bundle: '@deepseek-ai/dsh-base',
        message: 'bundle "@deepseek-ai/dsh-base" declares no preset "missing"',
      }),
    )
    await h.session.reload()
    const err = h.err.join('\n')
    expect(err).toContain('reload failed')
    expect(err).toContain('resolution.preset_not_found')
    expect(err).toContain('declares no preset "missing"')
    expect(err).not.toContain('config.import_failed')
  })

  it('reports a preserved preset-definition failure with its ids', async () => {
    const h = await session()
    h.setFailure(
      new PresetDefinitionError({
        code: 'preset.child_not_found',
        presetId: 'ptc-fresh',
        rowId: 'preset-ptc-fresh',
        childId: 'missing',
        message: 'preset "ptc-fresh" (row "preset-ptc-fresh") declares no child "missing"',
      }),
    )
    await h.session.reload()
    const err = h.err.join('\n')
    expect(err).toContain('reload failed')
    expect(err).toContain('preset.child_not_found')
    expect(err).toContain('"ptc-fresh"')
    expect(err).toContain('"preset-ptc-fresh"')
    expect(err).toContain('"missing"')
    expect(err).not.toContain('config.import_failed')
  })
})

describe('reload and diff', () => {
  it('reports an added row and the new composition size', async () => {
    const h = await session()
    h.setConfig(configWith(['a', 'b']))
    await h.session.reload()
    expect(h.out.join('\n')).toContain('+ row "b"')
    expect(h.out.join('\n')).toContain('composition: 2 rows, 0 warnings')
  })

  it('keeps the previous plan after an invalid save and retries with .reload', async () => {
    const h = await session()
    const before = h.session.currentPlan
    h.setFailure(new ConfigError('config.import_failed', 'bad save'))
    await h.session.reload()
    expect(h.err.join('\n')).toContain('reload failed')
    expect(h.session.currentPlan).toBe(before)
    h.setConfig(configWith(['a', 'b']))
    await h.session.command('.reload')
    expect(h.session.currentPlan).not.toBe(before)
    expect(h.out.join('\n')).toContain('+ row "b"')
  })
})

describe('profile switching', () => {
  it('switches the selected profile without re-importing the config', async () => {
    const h = await session({ config: configWithProfiles(['work', 'home'], 'work') })
    const before = h.loads()
    await h.session.command('.profile home')
    expect(h.session.profile).toBe('home')
    expect(await h.session.evaluate('selectedProfile.name')).toBe('home')
    expect(await h.session.evaluate('plan.profile.name')).toBe('home')
    expect(h.loads()).toBe(before)
    expect(h.out.join('\n')).toContain('profile: home')
  })

  it('reports an unknown profile, lists the declared names, and keeps the selection', async () => {
    const h = await session({ config: configWithProfiles(['work', 'home'], 'work') })
    await h.session.command('.profile missing')
    expect(h.err.join('\n')).toContain('"missing"')
    expect(h.err.join('\n')).toContain('work, home')
    expect(h.session.profile).toBe('work')
    expect(await h.session.evaluate('selectedProfile.name')).toBe('work')
  })

  it('rejects an invalid profile and keeps the selection', async () => {
    const result = defineConfig()
      .dsh('0.2.1-rc.2')
      .defaultProfile('work')
      .profile('work', (profile) => profile.generated())
      .profile('home', (profile) => profile.bundle('@eedsh/runtime'))
      .build()
    if (Result.isFailure(result)) throw result.failure
    const h = await session({ config: result.success })
    await h.session.command('.profile home')
    expect(h.err.join('\n')).toContain('invalid')
    expect(h.session.profile).toBe('work')
  })

  it('makes .sync act on the switched profile', async () => {
    const h = await session({ config: configWithProfiles(['work', 'home'], 'work') })
    await h.session.command('.profile home')
    await h.session.command('.sync')
    expect(h.syncs).toHaveLength(1)
    expect(h.syncs[0]?.profile.name).toBe('home')
  })

  it('reports usage for a missing argument', async () => {
    const h = await session()
    await h.session.command('.profile')
    expect(h.err.join('\n')).toContain('usage: .profile <name>')
  })
})

describe('session sync', () => {
  it('reports changed and unchanged publications and restart requirements', async () => {
    let changed = true
    const restart = true
    const h = await session({
      syncPlan: async () => ({
        changed,
        generationId: 'abcdef0123456789',
        restartRequired: restart,
      }),
    })
    await h.session.command('.sync')
    expect(h.out.join('\n')).toContain('published profile "work"')
    expect(h.out.join('\n')).toContain('restart required')
    changed = false
    await h.session.command('.sync')
    expect(h.out.join('\n')).toContain('is up to date')
    expect(h.out.join('\n').split('restart required')).toHaveLength(2)
  })

  it('keeps the prompt usable after a sync failure', async () => {
    const h = await session({
      syncPlan: async () => {
        throw { _tag: 'SyncLocked', message: 'another sync holds the lock' }
      },
    })
    await h.session.command('.sync')
    expect(h.err.join('\n')).toContain('sync failed')
    expect(await h.session.evaluate('1 + 1')).toBe(2)
  })

  it('runs the same reload and sync path from the watcher', async () => {
    let onChange: (() => void) | undefined
    let calls = 0
    const h = await session({
      sync: true,
      watchConfig: true,
      watch: async (_dir, callback) => {
        onChange = callback
        return { close: async () => {} }
      },
      syncPlan: async () => {
        calls += 1
        return { changed: true, generationId: 'abcdef0123456789' }
      },
    })
    h.setConfig(configWith(['a', 'b']))
    onChange?.()
    expect(await waitFor(() => calls === 1)).toBe(true)
    expect(h.out.join('\n')).toContain('+ row "b"')
  })

  it('syncs changed saves in continuous mode, skips invalid saves, and pauses failures', async () => {
    let fail = false
    let calls = 0
    const h = await session({
      sync: true,
      syncPlan: async () => {
        calls += 1
        if (fail) throw new Error('install broke')
        return { changed: true, generationId: 'abcdef0123456789' }
      },
    })
    h.setConfig(configWith(['a', 'b']))
    await h.session.reload()
    expect(calls).toBe(1)
    expect(h.out.join('\n')).toContain('sync: on')

    h.setFailure(new ConfigError('config.import_failed', 'bad save'))
    await h.session.reload()
    expect(calls).toBe(1)

    fail = true
    h.setConfig(configWith(['a', 'b', 'c']))
    await h.session.reload()
    expect(calls).toBe(2)
    await h.session.reload()
    expect(calls).toBe(2)

    fail = false
    h.setConfig(configWith(['a', 'b', 'c', 'd']))
    await h.session.reload()
    expect(calls).toBe(3)

    await h.session.command('.sync off')
    h.setConfig(configWith(['a', 'b', 'c', 'd', 'e']))
    await h.session.reload()
    expect(calls).toBe(3)
  })
})

describe('preview integration', () => {
  async function installPreview(dir: string): Promise<void> {
    await mkdir(join(dir, 'node_modules', '@acme', 'x'), { recursive: true })
    await writeFile(
      join(dir, 'node_modules', '@acme', 'x', 'package.json'),
      JSON.stringify({ name: '@acme/x', version: '1.2.3' }),
    )
  }

  function previewDir(out: readonly string[]): string | undefined {
    const line = out.find((entry) => entry.startsWith('preview:'))
    return line?.match(/ at (.*?)(?: \(reused\))?$/)?.[1]
  }

  it('prints the override, evaluates, and never touches the profile', async () => {
    const h = await session({ installPreview })
    const profileManifest = join(work, 'home', 'profiles', 'work', 'package.json')
    const before = await readFile(profileManifest, 'utf8')
    await h.session.resolve(['@acme/x@1.2.3'])
    expect(h.session.previewActive).toBe(true)
    expect(h.out.join('\n')).toContain('profile-root override:')
    expect(h.out.join('\n')).toContain('preview: @acme/x@1.2.3')
    expect(previewDir(h.out)).toBeDefined()
    expect(await readFile(profileManifest, 'utf8')).toBe(before)
  })

  it('deletes the preview when the real install reproduces the plan', async () => {
    const h = await session({
      installPreview,
      syncPlan: async () => ({ changed: true, generationId: 'abcdef0123456789' }),
    })
    await h.session.resolve(['@acme/x@1.2.3'])
    const dir = previewDir(h.out)
    expect(dir).toBeDefined()
    await h.session.command('.sync')
    expect(h.out.join('\n')).toContain('bootstrap complete')
    expect(h.session.previewActive).toBe(false)
    await expect(readFile(join(dir as string, 'package.json'), 'utf8')).rejects.toThrow()
  })

  it('keeps the preview when the real install diverges', async () => {
    let h!: Harness
    h = await session({
      installPreview,
      syncPlan: async () => {
        h.setConfig(configWith(['different']))
        return { changed: true, generationId: 'abcdef0123456789' }
      },
    })
    await h.session.resolve(['@acme/x@1.2.3'])
    const dir = previewDir(h.out)
    expect(dir).toBeDefined()
    await h.session.command('.sync')
    expect(h.out.join('\n')).toContain('preview divergence')
    expect(h.session.previewActive).toBe(false)
    expect(h.session.currentPlan.layers[0]?.patches[0]).toMatchObject({
      insert: [{ id: 'different' }],
    })
    expect(await readFile(join(dir as string, 'package.json'), 'utf8')).toContain('@acme/x')
  })

  it('keeps the previous evaluation when the preview install fails', async () => {
    const h = await session({
      installPreview: async () => {
        throw new Error('registry unavailable')
      },
    })
    const before = h.session.currentPlan
    await h.session.resolve(['@acme/x@1.2.3'])
    expect(h.err.join('\n')).toContain('preview not ready')
    expect(h.session.previewActive).toBe(false)
    expect(h.session.currentPlan).toBe(before)
  })
})

describe('shell commands', () => {
  it('lists bindings, commands, and discovery hints in the banner and help', async () => {
    const h = await session()
    const banner = h.out.join('\n')
    for (const token of ['config', 'selectedProfile', 'plan', '.profile', 'Tab']) {
      expect(banner).toContain(token)
    }
    await h.session.command('.help')
    const help = h.out.join('\n')
    for (const token of ['config', 'selectedProfile', 'plan', '.profile', 'Tab']) {
      expect(help).toContain(token)
    }
  })

  it('lists commands, rejects unknown dot words, and exits', async () => {
    const h = await session()
    await h.session.command('.help')
    expect(h.out.join('\n')).toContain('.resolve')
    expect(h.out.join('\n')).toContain('.exit')
    await h.session.command('.bogus')
    expect(h.err.join('\n')).toContain('invalid command')
    expect(await h.session.command('.exit')).toBe(true)
  })

  it('runs a non-TTY loop without prompts', async () => {
    const out: string[] = []
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
    const configured = await ReplSession.create({
      configPath: join(work, 'config.ts'),
      env: { DSH_HOME: join(work, 'home') },
      stdout: (line) => out.push(line),
      stderr: () => {},
      loadConfig: () => Effect.succeed(loaded(configWith(['a']))),
      compose: async () => ({ rowCount: 1, warnings: [] }),
      authoring,
      watchConfig: false,
    })
    sessions.push(configured)
    const running = runReplLoop(configured, { input, output })
    input.write('.help\n.exit\n')
    await running
    expect(out.join('\n')).toContain('.reload')
    expect(chunks.join('')).not.toContain('eedsh>')
  })
})
describe('completion catalogs', () => {
  async function installProfileBundle(): Promise<string> {
    const profileDir = join(work, 'home', 'profiles', 'work')
    const packageDir = join(profileDir, 'node_modules', '@fixture', 'custom')
    await mkdir(packageDir, { recursive: true })
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@fixture/custom',
        version: '1.0.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
    )
    await writeFile(
      join(packageDir, 'cordis.patch.yml'),
      `- insert:
    - id: profile-row
      name: '@fixture/plugin'
`,
    )
    return profileDir
  }

  it('refreshes profile names after a reload', async () => {
    const h = await session({ config: configWithProfiles(['work'], 'work') })
    expect((await h.session.complete('.profile ')).hits).toEqual(['work'])
    h.setConfig(configWithProfiles(['work', 'home'], 'work'))
    await h.session.reload()
    expect((await h.session.complete('.profile ')).hits).toEqual(['work', 'home'])
  })

  it('resolves row ids for a rooted bundle through the profile install', async () => {
    await installProfileBundle()
    takeResolutionTrace()
    const h = await session({ config: configWithProfiles(['work'], 'work') })
    const result = await h.session.complete("bundle('@fixture/custom').fromProfile('work').row('")
    expect(result.hits).toEqual(["'profile-row'"])
    expect(takeResolutionTrace()).toEqual([])
    expect(h.out.join('\n')).not.toContain('resolved @fixture/custom')
  })

  it('completes profile names in chain arguments', async () => {
    const h = await session({ config: configWithProfiles(['work', 'home'], 'work') })
    expect(
      (await h.session.complete("bundle('@deepseek-ai/dsh-base').fromProfile('")).hits,
    ).toEqual(["'work'", "'home'"])
  })

  it('keeps completion read-only', async () => {
    const profileDir = await installProfileBundle()
    const manifest = join(profileDir, 'package.json')
    const before = await readFile(manifest, 'utf8')
    const h = await session({ config: configWithProfiles(['work'], 'work') })
    await h.session.complete("bundle('@fixture/custom').fromProfile('work').row('")
    await h.session.complete('.profile ')
    expect(await readFile(manifest, 'utf8')).toBe(before)
    expect(existsSync(join(profileDir, '.eedsh'))).toBe(false)
  })

  it('keeps the prompt usable when completion resolution fails', async () => {
    const h = await session({ config: configWithProfiles(['work'], 'work') })
    const result = await h.session.complete("bundle('@fixture/missing').fromProfile('work').row('")
    expect(result.hits).toEqual([])
    expect(await h.session.evaluate('1 + 1')).toBe(2)
  })

  it('falls back to generic completion and filters prototype noise', async () => {
    const h = await session()
    await h.session.evaluate('const completionValue = 1')
    const [hits] = await h.session.completeGeneric('completionV')
    expect(hits).toContain('completionValue')
    expect(hits).not.toContain('constructor')
    expect(hits).not.toContain('toString')
  })
})
