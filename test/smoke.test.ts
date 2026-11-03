import { createRequire } from 'node:module'
import * as config from '@eedsh/config'
import * as plan from '@eedsh/plan'
import * as runtime from '@eedsh/runtime'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_DSH_RANGE, supportsDshVersion } from '../packages/cli/src/dsh-policy'

const require = createRequire(import.meta.url)

describe('workspace', () => {
  it('exposes the typed @eedsh/config authoring entry', () => {
    expect(typeof config.defineConfig).toBe('function')
    expect(typeof config.bundle).toBe('function')
    expect(typeof config.js).toBe('function')
    expect(typeof config.group).toBe('function')
    expect('dsh' in config.defineConfig()).toBe(false)
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
      'assertPlan',
      'validatePlan',
      'validateConfigValue',
      'ProfilePlanSchema',
      'EedshConfigSchema',
      'PLAN_VERSION',
    ]) {
      expect(symbol in config, `@eedsh/config must not export ${symbol}`).toBe(false)
    }
  })

  it('exposes the @eedsh/plan public entry', () => {
    expect(typeof plan.validatePlan).toBe('function')
    expect(typeof plan.validateConfigValue).toBe('function')
    expect(plan.PLAN_VERSION).toBe(2)
  })

  it('builds a profile through the fluent surface', () => {
    const result = config
      .defineConfig()
      .profile('work', (profile) => profile.bundle('@deepseek-ai/dsh-base'))
      .build()
    expect(result).not.toBeInstanceOf(Promise)
    if (result._tag !== 'Success') throw new Error('expected a success Result')
    expect('dsh' in result.success).toBe(false)
    expect(Object.keys(result.success.profiles)).toEqual(['work'])
  })

  it('exposes the @eedsh/runtime public entry', () => {
    expect(typeof runtime.apply).toBe('function')
    expect(runtime.name).toBe('eedsh-runtime')
  })

  it('resolves a DSH package inside the supported range', () => {
    const packageJson = require('@deepseek-ai/dsh/package.json') as {
      name: string
      version: string
    }
    expect(packageJson.name).toBe('@deepseek-ai/dsh')
    expect(SUPPORTED_DSH_RANGE).toBe('^0.2.1-rc.2')
    expect(supportsDshVersion(packageJson.version)).toBe(true)
    expect(supportsDshVersion('0.3.0')).toBe(false)
  })
})