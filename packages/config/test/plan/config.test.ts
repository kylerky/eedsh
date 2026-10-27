import {
  bundle,
  type DefineConfigInput,
  defineConfig,
  defineProfile,
  type EedshConfig,
  generated,
  insert,
  layer,
  type ProfileDefinition,
  type ProfilePlan,
  validateConfigValue,
} from '@eedsh/config'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import { describe, expect, it } from 'vitest'

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

function issuesOf(error: Schema.SchemaError) {
  return formatIssues(error.issue).issues.map((issue) => ({
    path: (issue.path ?? []).map((segment) =>
      typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment,
    ),
    message: issue.message,
  }))
}

const dsh = '0.2.1-rc.2'

function workProfile(): ProfileDefinition {
  return defineProfile({
    bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
    layers: [layer('work', [insert({ id: 'work-row', name: '@scope/work-row' })])],
  })
}

function homeProfile(): ProfileDefinition {
  return defineProfile({
    bundles: [bundle('@deepseek-ai/dsh-base')],
  })
}

function configOf(input: DefineConfigInput<Record<string, ProfileDefinition>>): EedshConfig {
  const result = defineConfig(input)
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}

function failureOf(
  input: DefineConfigInput<Record<string, ProfileDefinition>>,
): Schema.SchemaError {
  const result = defineConfig(input)
  if (Result.isSuccess(result)) throw new Error('expected defineConfig to fail')
  return result.failure
}

function planOf(config: EedshConfig, name: string): ProfilePlan {
  const result = config.profiles[name]
  if (result === undefined) throw new Error(`missing profile ${name}`)
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}

describe('defineConfig envelope', () => {
  it('produces one validated plan per key with the shared pin', () => {
    const config = configOf({
      dsh,
      defaultProfile: 'work',
      profiles: { work: workProfile(), home: homeProfile() },
    })
    expect(config.dsh).toBe(dsh)
    expect(config.defaultProfile).toBe('work')
    expect(Object.keys(config.profiles)).toEqual(['work', 'home'])
    const work = planOf(config, 'work')
    const home = planOf(config, 'home')
    expect(work.profile.name).toBe('work')
    expect(home.profile.name).toBe('home')
    expect(work.dsh).toBe(dsh)
    expect(home.dsh).toBe(dsh)
    expect(work.layers.map((item) => item.id)).toEqual(['work'])
  })

  it('uses the record key as the profile name and always applies the shared pin', () => {
    const config = configOf({
      dsh: '1.2.3',
      profiles: { 'odd-name-2': homeProfile() },
    })
    expect(planOf(config, 'odd-name-2')).toMatchObject({
      profile: { name: 'odd-name-2' },
      dsh: '1.2.3',
    })
  })

  it('accepts records built dynamically from entries', () => {
    const names = ['work', 'home'] as const
    const profiles = Object.fromEntries(
      names.map((name) => [name, defineProfile({ bundles: [bundle('@deepseek-ai/dsh-base')] })]),
    )
    const config = configOf({ dsh, profiles })
    expect(Object.keys(config.profiles)).toEqual(['work', 'home'])
    for (const name of names) expect(planOf(config, name).profile.name).toBe(name)
  })

  it('returns a synchronous Result and never throws for a bad envelope', () => {
    const result = defineConfig({ dsh: 'latest', profiles: { work: workProfile() } })
    expect(result).not.toBeInstanceOf(Promise)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(Schema.isSchemaError(result.failure)).toBe(true)
  })
})

describe('config-level defects', () => {
  it('rejects an empty profile record', () => {
    const error = failureOf({ dsh, profiles: {} })
    expect(Schema.isSchemaError(error)).toBe(true)
    expect(issuesOf(error).map((issue) => issue.path)).toContainEqual(['profiles'])
  })

  it('rejects an unsafe profile key and names it', () => {
    const error = failureOf({
      dsh,
      profiles: { 'a/b': homeProfile() },
    })
    const issues = issuesOf(error)
    expect(issues.map((issue) => issue.path)).toContainEqual(['profiles', 'a/b'])
    expect(issues.some((issue) => issue.message.includes('"a/b"'))).toBe(true)
  })

  it('rejects an unknown default profile', () => {
    const error = failureOf({
      dsh,
      defaultProfile: 'missing',
      profiles: { work: workProfile() },
    })
    const issues = issuesOf(error)
    expect(issues.map((issue) => issue.path)).toContainEqual(['defaultProfile'])
    expect(issues.some((issue) => issue.message.includes('"missing"'))).toBe(true)
  })

  it('rejects a malformed DSH pin', () => {
    const error = failureOf({ dsh: 'latest', profiles: { work: workProfile() } })
    expect(issuesOf(error).map((issue) => issue.path)).toContainEqual(['dsh'])
  })
})

describe('per-profile validation', () => {
  it('keeps a valid sibling when one profile is invalid', () => {
    const config = configOf({
      dsh,
      profiles: {
        work: workProfile(),
        home: defineProfile({ bundles: [bundle('@eedsh/runtime')] }),
      },
    })
    const work = config.profiles.work
    const home = config.profiles.home
    expect(work !== undefined && Result.isSuccess(work)).toBe(true)
    expect(home !== undefined && Result.isFailure(home)).toBe(true)
    if (home !== undefined && Result.isFailure(home)) {
      expect(Schema.isSchemaError(home.failure)).toBe(true)
      expect(home.failure.message).toContain('owned by the materializer')
    }
  })

  it('stores a failure for an invalid default without failing the config', () => {
    const config = configOf({
      dsh,
      defaultProfile: 'home',
      profiles: {
        work: workProfile(),
        home: defineProfile({ bundles: [], layers: [layer('home', [insert({})])] }),
      },
    })
    const home = config.profiles.home
    expect(home !== undefined && Result.isFailure(home)).toBe(true)
    const work = config.profiles.work
    expect(work !== undefined && Result.isSuccess(work)).toBe(true)
  })
})

describe('validateConfigValue', () => {
  it('normalizes a plain config object profile by profile', () => {
    const result = validateConfigValue({
      dsh,
      defaultProfile: 'work',
      profiles: {
        work: workProfile(),
        home: { bundles: [bundle('@deepseek-ai/dsh-base')] },
      },
    })
    if (Result.isFailure(result)) throw new Error(result.failure.message)
    const config = result.success
    expect(planOf(config, 'work').profile.name).toBe('work')
    expect(planOf(config, 'home').profile.name).toBe('home')
    expect(planOf(config, 'home').bundles).toEqual([
      { kind: 'bundle', name: '@deepseek-ai/dsh-base' },
    ])
  })

  it('revalidates profile Results so a forged success cannot bypass the plan', () => {
    const result = validateConfigValue({
      dsh,
      profiles: {
        work: Result.succeed({
          bundles: [bundle('@eedsh/runtime')],
        }),
      },
    })
    if (Result.isFailure(result)) throw new Error(result.failure.message)
    const profile = result.success.profiles.work
    expect(profile !== undefined && Result.isFailure(profile)).toBe(true)
    if (profile !== undefined && Result.isFailure(profile)) {
      expect(profile.failure.message).toContain('owned by the materializer')
    }
  })

  it('accepts a config Result export and revalidates its success value', () => {
    const authored = defineConfig({
      dsh,
      profiles: { work: workProfile() },
    })
    const result = validateConfigValue(authored)
    if (Result.isFailure(result)) throw new Error(result.failure.message)
    expect(planOf(result.success, 'work').profile.name).toBe('work')

    const forged = validateConfigValue(
      Result.succeed({ dsh: 'latest', profiles: { work: workProfile() } }),
    )
    expect(Result.isFailure(forged)).toBe(true)
    if (Result.isFailure(forged)) {
      expect(Schema.isSchemaError(forged.failure)).toBe(true)
      expect(forged.failure.message).toContain('"latest" is not an exact version')
    }
  })

  it('reports a failed config Result as its native schema error', () => {
    const authored = defineConfig({ dsh: 'latest', profiles: { work: workProfile() } })
    if (Result.isSuccess(authored)) throw new Error('expected authoring to fail')
    const result = validateConfigValue(authored)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBe(authored.failure)
      expect(Schema.isSchemaError(result.failure)).toBe(true)
    }
  })

  it('rejects a lone plan export', () => {
    const plan = planOf(configOf({ dsh, profiles: { work: workProfile() } }), 'work')
    const result = validateConfigValue(plan)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(Schema.isSchemaError(result.failure)).toBe(true)
    const resultExport = validateConfigValue(Result.succeed(plan))
    expect(Result.isFailure(resultExport)).toBe(true)
  })

  it('revalidates a plan-shaped profile entry under the config envelope', () => {
    const plan = planOf(configOf({ dsh, profiles: { work: workProfile() } }), 'work')
    const result = validateConfigValue({ dsh, profiles: { work: plan } })
    if (Result.isFailure(result)) throw new Error(result.failure.message)
    const profile = result.success.profiles.work
    expect(profile !== undefined && Result.isSuccess(profile)).toBe(true)
    if (profile !== undefined && Result.isSuccess(profile)) {
      expect(profile.success.profile.name).toBe('work')
      expect(profile.success.dsh).toBe(dsh)
    }
  })
})
