import { createRequire } from 'node:module'
import * as config from '@eedsh/config'
import * as plan from '@eedsh/plan'
import * as runtime from '@eedsh/runtime'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('workspace', () => {
  it('exposes the typed @eedsh/config authoring entry', () => {
    expect(typeof config.defineConfig).toBe('function')
    expect(typeof config.bundle).toBe('function')
    expect(typeof config.js).toBe('function')
    expect(typeof config.group).toBe('function')
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
    expect(plan.PLAN_VERSION).toBe(1)
  })

  it('builds a profile through the fluent surface', () => {
    const result = config
      .defineConfig()
      .dsh('0.2.1-rc.2')
      .profile('work', (profile) => profile.bundle('@deepseek-ai/dsh-base'))
      .build()
    expect(result).not.toBeInstanceOf(Promise)
    if (result._tag !== 'Success') throw new Error('expected a success Result')
    expect(result.success.dsh).toBe('0.2.1-rc.2')
    expect(Object.keys(result.success.profiles)).toEqual(['work'])
  })

  it('exposes the @eedsh/runtime public entry', () => {
    expect(typeof runtime.apply).toBe('function')
    expect(runtime.name).toBe('eedsh-runtime')
  })

  it('resolves the pinned DSH package', () => {
    const packageJson = require('@deepseek-ai/dsh/package.json') as {
      name: string
      version: string
    }
    expect(packageJson.name).toBe('@deepseek-ai/dsh')
    expect(packageJson.version).toBe('0.2.1-rc.2')
  })
})
