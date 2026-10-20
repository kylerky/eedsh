import { createRequire } from 'node:module'
import * as config from '@eedsh/config'
import * as runtime from '@eedsh/runtime'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('workspace', () => {
  it('exposes the @eedsh/config public entry', () => {
    expect(typeof config.defineProfile).toBe('function')
    expect(config.PLAN_VERSION).toBe(1)
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
