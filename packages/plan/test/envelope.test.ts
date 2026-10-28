import {
  type EedshConfig,
  EedshConfigSchema,
  type ProfilePlan,
  validateConfigValue,
  validatePlan,
} from '@eedsh/plan'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const dsh = '0.2.1-rc.2'

/** A plain profile descriptor, valid under the plan contract. */
function workProfile(): Record<string, unknown> {
  return {
    bundles: [{ kind: 'bundle', name: '@deepseek-ai/dsh-base' }, { kind: 'generated' }],
    layers: [
      {
        id: 'work',
        patches: [{ insert: [{ id: 'work-row', name: '@scope/work-row' }] }],
      },
    ],
  }
}

/** A plain profile descriptor without layers. */
function homeProfile(): Record<string, unknown> {
  return { bundles: [{ kind: 'bundle', name: '@deepseek-ai/dsh-base' }] }
}

/** A complete plan document for the given profile key. */
function planDocument(name: string): Record<string, unknown> {
  return {
    format: 'eedsh/profile-plan',
    version: 1,
    profile: { name },
    dsh,
    bundles: [{ kind: 'bundle', name: '@deepseek-ai/dsh-base' }],
    layers: [],
    packages: {},
  }
}

function planOf(config: EedshConfig, name: string): ProfilePlan {
  const result = config.profiles[name]
  if (result === undefined) throw new Error(`missing profile ${name}`)
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}

describe('validateConfigValue', () => {
  it('normalizes a plain config object profile by profile', () => {
    const result = validateConfigValue({
      dsh,
      defaultProfile: 'work',
      profiles: {
        work: workProfile(),
        home: { bundles: [{ kind: 'bundle', name: '@deepseek-ai/dsh-base' }] },
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
          bundles: [{ kind: 'bundle', name: '@eedsh/runtime' }],
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
    const authored = Result.succeed({
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
    const invalid = validateConfigValue({ dsh: 'latest', profiles: { work: workProfile() } })
    if (Result.isSuccess(invalid)) throw new Error('expected validation to fail')
    const result = validateConfigValue(Result.fail(invalid.failure))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBe(invalid.failure)
      expect(Schema.isSchemaError(result.failure)).toBe(true)
    }
  })

  it('rejects a lone plan export', () => {
    const validated = validatePlan(planDocument('work'))
    if (Result.isFailure(validated)) throw new Error(validated.failure.message)
    const plan = validated.success
    const result = validateConfigValue(plan)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(Schema.isSchemaError(result.failure)).toBe(true)
    const resultExport = validateConfigValue(Result.succeed(plan))
    expect(Result.isFailure(resultExport)).toBe(true)
  })

  it('revalidates a plan-shaped profile entry under the config envelope', () => {
    const validated = validatePlan(planDocument('work'))
    if (Result.isFailure(validated)) throw new Error(validated.failure.message)
    const result = validateConfigValue({ dsh, profiles: { work: validated.success } })
    if (Result.isFailure(result)) throw new Error(result.failure.message)
    const profile = result.success.profiles.work
    expect(profile !== undefined && Result.isSuccess(profile)).toBe(true)
    if (profile !== undefined && Result.isSuccess(profile)) {
      expect(profile.success.profile.name).toBe('work')
      expect(profile.success.dsh).toBe(dsh)
    }
  })

  it('exposes the strict envelope schema without decoding profiles', () => {
    const decoded = Schema.decodeUnknownResult(EedshConfigSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })({ dsh, profiles: { work: homeProfile() } })
    expect(Result.isSuccess(decoded)).toBe(true)
  })
})
