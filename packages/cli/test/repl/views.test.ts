import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineConfig, takeResolutionTrace } from '@eedsh/config'
import type { EedshConfig, ProfilePlan } from '@eedsh/plan'
import { Effect } from 'effect'
import * as Result from 'effect/Result'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DoctorResult } from '../../src/doctor'
import { touchedRowIds } from '../../src/preflight'
import { ReplSession } from '../../src/repl/session'
import {
  ConfigView,
  EntryView,
  PackageView,
  type ProfileSnapshot,
  ProfileView,
  PublishedProfileView,
  type PublishedSnapshot,
  ViewError,
} from '../../src/repl/views'

const tempRoot = join(process.cwd(), 'packages/cli/.tmp')
let work = ''
const sessions: ReplSession[] = []

const authoring = {
  module: { defineConfig: () => undefined },
  packagePath: '/fake/@eedsh/config/package.json',
  entryPath: '/fake/@eedsh/config/index.js',
  version: '0.0.0',
}

const fakeDoctor = async (): Promise<DoctorResult> => ({
  findings: [],
  errors: 0,
  warnings: 0,
})

function configOf(build: (builder: ReturnType<typeof defineConfig>) => void): EedshConfig {
  const builder = defineConfig().dsh('0.2.1-rc.2')
  build(builder)
  const result = builder.build()
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

function baseConfig(): EedshConfig {
  return configOf((builder) =>
    builder
      .defaultProfile('work')
      .profile('work', (profile) =>
        profile
          .package('@scope/plugin', 'link:../plugin')
          .bundle('@deepseek-ai/dsh-base')
          .generated()
          .layer('cli', (layer) => layer.insert({ id: 'row-a', name: '@scope/a' })),
      )
      .profile('home', (profile) => profile.bundle('@eedsh/runtime')),
  )
}

function emptyPublished(dir = ''): PublishedSnapshot {
  return {
    dir,
    exists: false,
    manifest: undefined,
    generation: undefined,
    record: undefined,
    plan: undefined,
    planPath: undefined,
    findings: [],
    errors: 0,
    warnings: 0,
  }
}

function snapshotOf(overrides: Partial<ProfileSnapshot> = {}): ProfileSnapshot {
  return {
    profileDir: '/profile',
    composition: {
      rowCount: 2,
      entries: [{ id: 'outer', group: true, config: [{ id: 'inner' }] }, { id: 'timer' }],
      sources: {
        outer: 'bundle:@deepseek-ai/dsh-base',
        inner: 'bundle:@deepseek-ai/dsh-base',
        timer: 'generated:cli',
      },
      warnings: ['one warning'],
      error: undefined,
    },
    published: emptyPublished('/profile'),
    ...overrides,
  }
}

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
    - id: group-row
      group: true
      name: '@fixture/group'
      config:
        - id: child-row
          name: '@fixture/child'
    - id: profile-row
      name: '@fixture/plugin'
`,
  )
  return profileDir
}

async function makeSession(
  options: {
    config?: EedshConfig
    compose?: (
      plan: ProfilePlan,
      profileDir: string,
    ) => Promise<{
      rowCount: number
      warnings: readonly string[]
      entries?: readonly Record<string, unknown>[]
      sources?: Readonly<Record<string, string>>
    }>
    useDefaultCompose?: boolean
    syncPlan?: (plan: ProfilePlan) => Promise<{
      changed: boolean
      generationId: string
      restartRequired?: boolean
    }>
    installPreview?: (dir: string) => Promise<void>
    doctor?: (dir: string) => Promise<DoctorResult>
  } = {},
) {
  let current = options.config ?? baseConfig()
  const out: string[] = []
  const err: string[] = []
  const syncs: ProfilePlan[] = []
  const session = await ReplSession.create({
    configPath: join(work, 'config.ts'),
    env: { DSH_HOME: join(work, 'home') },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    loadConfig: () => Effect.succeed({ config: current, provenance: undefined, configDir: work }),
    ...(options.useDefaultCompose === true
      ? {}
      : {
          compose:
            options.compose ??
            (async (plan: ProfilePlan) => ({
              rowCount: plan.layers.reduce(
                (count, layer) =>
                  count +
                  layer.patches.reduce(
                    (inner, patch) =>
                      inner + (Array.isArray(patch.insert) ? patch.insert.length : 0),
                    0,
                  ),
                0,
              ),
              warnings: [],
            })),
        }),
    syncPlan:
      options.syncPlan ??
      (async (plan) => {
        syncs.push(plan)
        return { changed: true, generationId: 'abcdef0123456789' }
      }),
    doctor: options.doctor ?? fakeDoctor,
    cacheRoot: join(work, 'cache'),
    authoring,
    watchConfig: false,
    ...(options.installPreview === undefined ? {} : { installPreview: options.installPreview }),
  })
  sessions.push(session)
  return {
    session,
    out,
    err,
    syncs,
    setConfig: (config: EedshConfig) => {
      current = config
    },
  }
}

beforeEach(async () => {
  await mkdir(tempRoot, { recursive: true })
  work = await mkdtemp(join(tempRoot, 'views-'))
  await mkdir(join(work, 'home', 'profiles', 'work'), { recursive: true })
  await writeFile(
    join(work, 'home', 'profiles', 'work', 'package.json'),
    JSON.stringify({ name: 'dsh-profile-work', private: true }),
  )
})

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  await rm(work, { recursive: true, force: true })
})

async function directoryFiles(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files: Record<string, string> = {}
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files[path] = await readFile(path, 'utf8')
  }
  return files
}

describe('profile and bundle views', () => {
  it('exposes the plan, bundle selections, and layers', () => {
    const config = baseConfig()
    const outcome = config.profiles.work
    if (outcome === undefined) throw new Error('missing work profile')
    const view = new ProfileView('work', outcome, snapshotOf())
    expect(view.name).toBe('work')
    expect(view.valid).toBe(true)
    expect(view.error).toBeUndefined()
    expect(view.plan().profile.name).toBe('work')
    expect(view.result()).toBe(outcome)
    const bundles = view.bundles()
    expect(bundles.map((bundle) => bundle.name)).toEqual(['@deepseek-ai/dsh-base'])
    expect(bundles[0]?.profile).toBe('work')
    expect(bundles[0]?.toJSON()).toEqual({
      kind: 'bundle',
      name: '@deepseek-ai/dsh-base',
    })
    expect(view.layers().map((layer) => layer.id)).toEqual(['cli'])
  })

  it('reports an invalid profile without throwing from the constructor', () => {
    const config = baseConfig()
    const outcome = config.profiles.home
    if (outcome === undefined) throw new Error('missing home profile')
    const view = new ProfileView('home', outcome, snapshotOf())
    expect(view.valid).toBe(false)
    expect(view.error).toContain('owned by the materializer')
    expect(() => view.plan()).toThrow(ViewError)
    expect(() => view.plan()).toThrow(/invalid/)
    expect(view.packages().declared).toEqual({})
  })

  it('lists declared profiles and returns a missing profile as undefined', () => {
    const config = baseConfig()
    const view = new ConfigView(config, new Map())
    expect(view.dsh).toBe('0.2.1-rc.2')
    expect(view.defaultProfile).toBe('work')
    expect(view.profiles().map((profile) => profile.name)).toEqual(['work', 'home'])
    expect(view.profiles().map((profile) => profile.valid)).toEqual([true, false])
    expect(view.profile('work')?.name).toBe('work')
    expect(view.profile('missing')).toBeUndefined()
  })
})

describe('package views', () => {
  it('combines declared, managed, and installed packages', async () => {
    const config = baseConfig()
    const outcome = config.profiles.work
    if (outcome === undefined || Result.isFailure(outcome)) throw new Error('invalid work profile')
    const profileDir = join(work, 'home', 'profiles', 'work')
    const installedDir = join(profileDir, 'node_modules', '@scope', 'plugin')
    await mkdir(installedDir, { recursive: true })
    await writeFile(
      join(installedDir, 'package.json'),
      JSON.stringify({ name: '@scope/plugin', version: '2.0.0' }),
    )
    await writeFile(
      join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-work',
        dependencies: {
          '@scope/plugin': 'link:../plugin',
          '@eedsh/runtime': 'link:runtime',
          'user-package': '1.2.3',
        },
      }),
    )
    const view = new PackageView(
      outcome.success,
      profileDir,
      JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >,
    )
    expect(view.declared).toEqual({ '@scope/plugin': 'link:../plugin' })
    expect(view.managed).toEqual(['@eedsh/generated', '@eedsh/runtime', '@scope/plugin'])
    expect(view.installed).toEqual({ '@scope/plugin': '2.0.0' })
    expect(view.names()).toEqual([
      '@eedsh/generated',
      '@eedsh/runtime',
      '@scope/plugin',
      'user-package',
    ])
    expect(view.get('@scope/plugin')).toEqual({
      name: '@scope/plugin',
      spec: 'link:../plugin',
      managed: true,
      installedVersion: '2.0.0',
    })
    expect(view.get('user-package')?.managed).toBe(false)
    expect(view.get('missing')).toBeUndefined()
  })
})

describe('composition and entry views', () => {
  it('exposes composed entries with last-touch provenance', () => {
    const config = baseConfig()
    const outcome = config.profiles.work
    if (outcome === undefined) throw new Error('missing work profile')
    const view = new ProfileView('work', outcome, snapshotOf())
    const composition = view.composition()
    expect(composition.rowCount).toBe(2)
    expect(composition.warnings).toEqual(['one warning'])
    expect(composition.error).toBeUndefined()
    const entries = view.entries()
    expect(entries.map((entry) => entry.id)).toEqual(['outer', 'timer'])
    expect(entries[0]?.source).toBe('bundle:@deepseek-ai/dsh-base')
    expect(entries[1]?.source).toBe('generated:cli')
    expect(entries[1]?.toJSON()).toEqual({ id: 'timer' })
    expect(new EntryView({ name: 'no-id' }, {})).toMatchObject({ id: '', source: undefined })
  })

  it('treats a failed composition as a view error and no entries', () => {
    const config = baseConfig()
    const outcome = config.profiles.work
    if (outcome === undefined) throw new Error('missing work profile')
    const view = new ProfileView(
      'work',
      outcome,
      snapshotOf({
        composition: {
          rowCount: 0,
          entries: [],
          sources: {},
          warnings: ['w'],
          error: 'cannot resolve bundle',
        },
      }),
    )
    expect(view.entries()).toEqual([])
    expect(view.composition().error).toBe('cannot resolve bundle')
    expect(view.composition().warnings).toEqual(['w'])
  })

  it('scans inserted rows, nested group children, and id targets', () => {
    const patches = [
      {
        insert: [
          { id: 'group-row', group: true, config: [{ id: 'child-row' }] },
          { id: 'plain-row' },
        ],
      },
      { id: 'timer', disabled: true },
    ]
    expect(touchedRowIds(patches)).toEqual(['group-row', 'child-row', 'plain-row', 'timer'])
  })
})

describe('published views', () => {
  it('reports a missing profile as exists false', () => {
    const view = new PublishedProfileView(emptyPublished('/missing'))
    expect(view.exists).toBe(false)
    expect(view.manifest).toBeUndefined()
    expect(view.record).toBeUndefined()
    expect(view.findings).toEqual([])
  })

  it('exposes a manifest, generation record, and authoritative plan', () => {
    const view = new PublishedProfileView({
      dir: '/profile',
      exists: true,
      manifest: { name: 'dsh-profile-work' },
      generation: {
        _tag: 'valid',
        record: {
          format: 'eedsh/generation',
          version: 1,
          generationId: 'gen-1',
          planHash: 'a'.repeat(64),
          eedshVersion: '0.0.0',
          dshVersion: '0.2.1-rc.2',
          layers: [],
          bundles: ['@deepseek-ai/dsh-base', '@eedsh/runtime', '@eedsh/generated'],
          packages: { '@eedsh/runtime': 'link:runtime' },
        },
        previous: {
          bundles: ['@deepseek-ai/dsh-base', '@eedsh/runtime', '@eedsh/generated'],
          packages: { '@eedsh/runtime': 'link:runtime' },
        },
      },
      record: undefined,
      plan: { profile: { name: 'work' } },
      planPath: '/profile/.eedsh/generated/plans/gen-1.json',
      findings: [
        { severity: 'warning', check: 'lockfile', message: 'stale', path: undefined as never },
      ],
      errors: 0,
      warnings: 1,
    })
    expect(view.exists).toBe(true)
    expect(view.manifest).toEqual({ name: 'dsh-profile-work' })
    expect(view.generation?._tag).toBe('valid')
    expect(view.plan).toEqual({ profile: { name: 'work' } })
    expect(view.planPath).toContain('gen-1.json')
    expect(view.findings).toHaveLength(1)
    expect(view.errors).toBe(0)
    expect(view.warnings).toBe(1)
  })
})

describe('exploration snapshots', () => {
  it('rebuilds package and composition views after a reload', async () => {
    const h = await makeSession({
      useDefaultCompose: true,
      config: configOf((builder) =>
        builder.profile('work', (profile) =>
          profile
            .generated()
            .layer('cli', (layer) => layer.insert({ id: 'row-a', name: '@scope/a' })),
        ),
      ),
    })
    expect(await h.session.evaluate('selectedProfile.entries()[0].id')).toBe('row-a')
    expect(await h.session.evaluate('selectedProfile.entries()[0].source')).toBe('generated:cli')
    h.setConfig(
      configOf((builder) =>
        builder.profile('work', (profile) =>
          profile
            .package('@scope/new', '1.0.0')
            .generated()
            .layer('cli', (layer) => layer.insert({ id: 'row-b', name: '@scope/b' })),
        ),
      ),
    )
    await h.session.reload()
    expect(await h.session.evaluate('selectedProfile.packages().declared')).toEqual({
      '@scope/new': '1.0.0',
    })
    expect(await h.session.evaluate('selectedProfile.entries()[0].id')).toBe('row-b')
  })

  it('rebuilds the selected profile view on a profile switch', async () => {
    const h = await makeSession({
      config: configOf((builder) =>
        builder
          .defaultProfile('work')
          .profile('work', (profile) => profile.generated())
          .profile('home', (profile) => profile.generated()),
      ),
    })
    expect(await h.session.evaluate('selectedProfile.published().dir')).toContain('profiles/work')
    await h.session.command('.profile home')
    expect(await h.session.evaluate('selectedProfile.name')).toBe('home')
    expect(await h.session.evaluate('selectedProfile.published().dir')).toContain('profiles/home')
  })

  it('uses the preview directory as the selected profile root', async () => {
    const installPreview = async (dir: string): Promise<void> => {
      await mkdir(join(dir, 'node_modules', '@acme', 'x'), { recursive: true })
      await writeFile(
        join(dir, 'node_modules', '@acme', 'x', 'package.json'),
        JSON.stringify({ name: '@acme/x', version: '1.2.3' }),
      )
    }
    const h = await makeSession({
      installPreview,
      config: configOf((builder) => builder.profile('work', (profile) => profile.generated())),
    })
    const realDir = await h.session.evaluate('selectedProfile.published().dir')
    await h.session.command('.sync off')
    await h.session.resolve(['@acme/x@1.2.3'])
    const previewDir = await h.session.evaluate('selectedProfile.published().dir')
    expect(previewDir).not.toBe(realDir)
    expect(previewDir).toContain('cache')
  })

  it('refreshes published state after a successful sync', async () => {
    const h = await makeSession({
      config: configOf((builder) => builder.profile('work', (profile) => profile.generated())),
      syncPlan: async () => {
        const profileDir = join(work, 'home', 'profiles', 'work')
        const recordDir = join(profileDir, '.eedsh', 'generated')
        await mkdir(join(recordDir, 'plans'), { recursive: true })
        await writeFile(
          join(recordDir, 'package.json'),
          JSON.stringify({
            name: '@eedsh/generated',
            eedsh: {
              format: 'eedsh/generation',
              version: 1,
              generationId: 'gen-1',
              planHash: 'a'.repeat(64),
              eedshVersion: '0.0.0',
              dshVersion: '0.2.1-rc.2',
              layers: [],
              bundles: ['@deepseek-ai/dsh-base', '@eedsh/runtime', '@eedsh/generated'],
              packages: { '@eedsh/runtime': 'link:runtime' },
            },
          }),
        )
        await writeFile(
          join(recordDir, 'plans', 'gen-1.json'),
          JSON.stringify({ profile: { name: 'work' } }),
        )
        return { changed: true, generationId: 'gen-1' }
      },
    })
    expect(await h.session.evaluate('selectedProfile.published().exists')).toBe(true)
    expect(await h.session.evaluate('selectedProfile.published().record')).toBeUndefined()
    await h.session.command('.sync')
    expect(await h.session.evaluate('selectedProfile.published().record.generationId')).toBe(
      'gen-1',
    )
    expect(await h.session.evaluate('selectedProfile.published().plan')).toEqual({
      profile: { name: 'work' },
    })
  })

  it('reports a declared profile with no published directory as missing', async () => {
    const h = await makeSession({
      config: configOf((builder) =>
        builder
          .defaultProfile('work')
          .profile('work', (profile) => profile.generated())
          .profile('home', (profile) => profile.generated()),
      ),
    })
    expect(await h.session.evaluate("config.profile('home').published().exists")).toBe(false)
  })
})

describe('read-only exploration', () => {
  it('walks every view without writing under the profile directory', async () => {
    const profileDir = await installProfileBundle()
    const before = await directoryFiles(profileDir)
    const h = await makeSession({
      config: configOf((builder) =>
        builder.profile('work', (profile) =>
          profile
            .bundle('@fixture/custom')
            .generated()
            .layer('cli', (layer) => layer.insert({ id: 'row-a', name: '@scope/a' })),
        ),
      ),
      compose: async () => ({
        rowCount: 1,
        warnings: [],
        entries: [{ id: 'row-a' }],
        sources: { 'row-a': 'generated:cli' },
      }),
    })
    takeResolutionTrace()
    const script = `
      config.dsh
      config.profiles().map((profile) => [profile.name, profile.valid])
      selectedProfile.bundles().map((bundle) => [bundle.name, bundle.profile])
      selectedProfile.bundles()[0].rows().map((row) => row.id)
      selectedProfile.bundles()[0].presets()
      selectedProfile.layers()
      selectedProfile.packages().all()
      selectedProfile.entries().map((entry) => [entry.id, entry.source])
      selectedProfile.published().exists
      selectedProfile.published().manifest
      selectedProfile.published().findings
    `
    const value = await h.session.evaluate(script)
    expect(Array.isArray(value)).toBe(true)
    expect(takeResolutionTrace()).toEqual([])
    expect(await directoryFiles(profileDir)).toEqual(before)
    expect(existsSync(join(profileDir, '.eedsh'))).toBe(false)
  })
})
