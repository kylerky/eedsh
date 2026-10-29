import { bundle, defineConfig, definePreset, LayerBuilder, ResolutionError } from '@eedsh/config'
import type { EedshConfig, ProfilePlan } from '@eedsh/plan'
import * as Result from 'effect/Result'
import type * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import { describe, expect, it } from 'vitest'

const dsh = '0.2.1-rc.2'

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

function issuesOf(error: Schema.SchemaError) {
  return formatIssues(error.issue).issues.map((issue) => ({
    path: (issue.path ?? []).map((segment) =>
      typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment,
    ),
    message: issue.message,
  }))
}

function configOf(result: Result.Result<EedshConfig, Schema.SchemaError>): EedshConfig {
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}

function failureOf(result: Result.Result<EedshConfig, Schema.SchemaError>): Schema.SchemaError {
  if (Result.isSuccess(result)) throw new Error('expected defineConfig().build() to fail')
  return result.failure
}

function planOf(config: EedshConfig, name: string): ProfilePlan {
  const result = config.profiles[name]
  if (result === undefined) throw new Error(`missing profile ${name}`)
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}

describe('fluent config builder', () => {
  it('builds a minimal fluent config synchronously', () => {
    const result = defineConfig()
      .dsh(dsh)
      .profile('work', (profile) => profile.bundle('@deepseek-ai/dsh-base'))
      .build()
    expect(result).not.toBeInstanceOf(Promise)
    const config = configOf(result)
    expect(config.dsh).toBe(dsh)
    expect(Object.keys(config.profiles)).toEqual(['work'])
    expect(planOf(config, 'work').profile.name).toBe('work')
  })

  it('chains the pin, default profile, profiles, and packages', () => {
    const config = configOf(
      defineConfig()
        .dsh('1.2.3')
        .defaultProfile('home')
        .profile('work', (profile) =>
          profile
            .bundle('@deepseek-ai/dsh-base')
            .bundle(bundle('@deepseek-ai/dsh-web-app', { source: 'link:../web-app' }))
            .generated()
            .layer('plugins', (layer) =>
              layer.insert({ id: 'my-plugin', name: '@scope/my-plugin' }),
            )
            .package('@scope/my-plugin', 'link:../my-plugin'),
        )
        .profile('home', (profile) => profile.bundle('@deepseek-ai/dsh-base'))
        .build(),
    )
    expect(config.dsh).toBe('1.2.3')
    expect(config.defaultProfile).toBe('home')
    expect(Object.keys(config.profiles)).toEqual(['work', 'home'])
    const work = planOf(config, 'work')
    expect(work.bundles).toEqual([
      { kind: 'bundle', name: '@deepseek-ai/dsh-base' },
      { kind: 'bundle', name: '@deepseek-ai/dsh-web-app', source: 'link:../web-app' },
      { kind: 'generated' },
    ])
    expect(work.packages).toEqual({ '@scope/my-plugin': 'link:../my-plugin' })
    expect(planOf(config, 'home').packages).toEqual({})
  })

  it('scopes each layer callback to its own layer and keeps authored order', () => {
    const config = configOf(
      defineConfig()
        .dsh(dsh)
        .profile('work', (profile) => {
          profile.layer('first', (layer) => layer.insert({ id: 'first-row', name: '@scope/first' }))
          profile.layer('second', (layer) => layer.disable('preset-standard'))
        })
        .build(),
    )
    expect(planOf(config, 'work').layers).toEqual([
      { id: 'first', patches: [{ insert: [{ id: 'first-row', name: '@scope/first' }] }] },
      { id: 'second', patches: [{ id: 'preset-standard', disabled: true }] },
    ])
  })

  it('keeps the callback return value irrelevant', () => {
    const config = configOf(
      defineConfig()
        .dsh(dsh)
        .profile('work', (profile) => {
          profile.bundle('@deepseek-ai/dsh-base')
          return undefined as never
        })
        .build(),
    )
    expect(planOf(config, 'work').bundles).toEqual([
      { kind: 'bundle', name: '@deepseek-ai/dsh-base' },
    ])
  })

  it('normalizes typed handles before validation', () => {
    const base = bundle('@deepseek-ai/dsh-base')
    const web = bundle('@deepseek-ai/dsh-web-app')
    const config = configOf(
      defineConfig()
        .dsh(dsh)
        .profile('work', (profile) => profile.bundle(base).bundle(web).generated())
        .build(),
    )
    const plan = planOf(config, 'work')
    expect(plan.bundles).toEqual([
      { kind: 'bundle', name: '@deepseek-ai/dsh-base' },
      { kind: 'bundle', name: '@deepseek-ai/dsh-web-app' },
      { kind: 'generated' },
    ])
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
  })

  it('writes the complete preset registry config from explicit references', () => {
    const standard = definePreset('standard')
    const adapted = definePreset('ptc-fresh', { rowId: 'preset-adapted' })
    const config = configOf(
      defineConfig()
        .dsh(dsh)
        .profile('work', (profile) => {
          profile.layer('registry', (layer) => layer.selectPreset(adapted, { default: standard }))
        })
        .build(),
    )
    expect(planOf(config, 'work').layers).toEqual([
      {
        id: 'registry',
        patches: [
          {
            id: 'agent-preset-registry',
            config: { default: 'standard', selectedDefault: 'ptc-fresh' },
          },
        ],
      },
    ])
  })

  it('requires the deployment default and accepts no shorthand', () => {
    const adapted = definePreset('ptc-fresh')
    const layer = new LayerBuilder('registry')
    if (false as boolean) {
      // @ts-expect-error the deployment default must be supplied explicitly
      layer.selectPreset(adapted)
      // @ts-expect-error the deployment default must be supplied explicitly
      layer.selectPreset(adapted, {})
      // @ts-expect-error a preset reference is a handle, never a bare id
      layer.selectPreset('ptc-fresh', { default: adapted })
    }
    expect(layer.patches).toEqual([])
  })

  it('returns detached, independent builds', () => {
    const builder = defineConfig().dsh(dsh)
    builder.profile('work', (profile) => profile.bundle('@deepseek-ai/dsh-base'))
    const first = configOf(builder.build())
    const second = configOf(builder.build())
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
  })
})

describe('builder defects', () => {
  it('fails at build when the pin is missing', () => {
    const error = failureOf(
      defineConfig()
        .profile('work', (profile) => profile.bundle('@deepseek-ai/dsh-base'))
        .build(),
    )
    expect(issuesOf(error).map((issue) => issue.path)).toContainEqual(['dsh'])
  })

  it('fails at build when no profile is declared', () => {
    const error = failureOf(defineConfig().dsh(dsh).build())
    expect(issuesOf(error).map((issue) => issue.path)).toContainEqual(['profiles'])
  })

  it('rejects an unsafe profile key and names it', () => {
    const error = failureOf(
      defineConfig()
        .dsh(dsh)
        .profile('a/b', (profile) => profile.bundle('@deepseek-ai/dsh-base'))
        .build(),
    )
    const issues = issuesOf(error)
    expect(issues.map((issue) => issue.path)).toContainEqual(['profiles', 'a/b'])
    expect(issues.some((issue) => issue.message.includes('"a/b"'))).toBe(true)
  })

  it('rejects an unknown default profile', () => {
    const error = failureOf(
      defineConfig()
        .dsh(dsh)
        .defaultProfile('missing')
        .profile('work', (profile) => profile.bundle('@deepseek-ai/dsh-base'))
        .build(),
    )
    const issues = issuesOf(error)
    expect(issues.map((issue) => issue.path)).toContainEqual(['defaultProfile'])
    expect(issues.some((issue) => issue.message.includes('"missing"'))).toBe(true)
  })

  it('keeps an invalid profile as its own failure and validates its sibling', () => {
    const config = configOf(
      defineConfig()
        .dsh(dsh)
        .profile('work', (profile) => profile.bundle('@deepseek-ai/dsh-base'))
        .profile('home', (profile) => profile.bundle('@eedsh/runtime'))
        .build(),
    )
    const work = config.profiles.work
    const home = config.profiles.home
    expect(work !== undefined && Result.isSuccess(work)).toBe(true)
    expect(home !== undefined && Result.isFailure(home)).toBe(true)
    if (home !== undefined && Result.isFailure(home)) {
      expect(home.failure.message).toContain('owned by the materializer')
    }
  })

  it('fails with the native schema error and never throws', () => {
    expect(() =>
      defineConfig()
        .dsh('latest')
        .profile('work', () => undefined)
        .build(),
    ).not.toThrow()
    const failure = failureOf(defineConfig().dsh('latest').build())
    expect(SchemaIssue.isIssue(failure.issue)).toBe(true)
  })
})

describe('public authoring surface', () => {
  it('replaces the free helpers with methods', async () => {
    const module = (await import('@eedsh/config')) as Record<string, unknown>
    for (const symbol of [
      'defineProfile',
      'rows',
      'presets',
      'row',
      'insert',
      'disable',
      'enable',
      'override',
      'layer',
      'raw',
    ]) {
      expect(symbol in module, `@eedsh/config must not export ${symbol}`).toBe(false)
    }
    expect(typeof module.defineConfig).toBe('function')
    expect(typeof module.bundle).toBe('function')
  })
})
describe('rooted query rejection', () => {
  it('rejects a rooted query as a bundle selection', () => {
    const rooted = bundle('@deepseek-ai/dsh-base').fromProfile('work')
    const builder = defineConfig().dsh(dsh)
    expect(() =>
      builder.profile('work', (profile) => {
        // @ts-expect-error a rooted query is query-only and not a plan selection
        profile.bundle(rooted)
      }),
    ).toThrowError(ResolutionError)
  })
})
