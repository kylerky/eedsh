import { createRequire } from 'node:module'
import * as config from '@eedsh/config'
import * as plan from '@eedsh/plan'
import * as runtime from '@eedsh/runtime'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('workspace', () => {
  it('exposes the @eedsh/config authoring entry', () => {
    expect(typeof config.defineProfile).toBe('function')
    expect(typeof config.defineConfig).toBe('function')
    expect(typeof config.bundle).toBe('function')
    expect('assertPlan' in config).toBe(false)
    for (const symbol of ['validateConfigValue', 'validatePlan', 'PLAN_VERSION']) {
      expect(symbol in config, `@eedsh/config must not export ${symbol}`).toBe(false)
    }
  })

  it('exposes the @eedsh/plan public entry', () => {
    expect(typeof plan.validatePlan).toBe('function')
    expect(typeof plan.validateConfigValue).toBe('function')
    expect(plan.PLAN_VERSION).toBe(1)
  })

  it('returns a profile descriptor from defineProfile', () => {
    const definition = config.defineProfile({})
    expect(definition).toEqual({ bundles: [], layers: [], packages: {} })
    expect(definition).not.toBeInstanceOf(Promise)
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
