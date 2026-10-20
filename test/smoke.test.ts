import { createRequire } from 'node:module'
import * as config from '@eedsh/config'
import * as runtime from '@eedsh/runtime'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('workspace', () => {
  it('exposes the @eedsh/config public entry', () => {
    expect(config.packageName).toBe('@eedsh/config')
  })

  it('exposes the @eedsh/runtime public entry', () => {
    expect(runtime.packageName).toBe('@eedsh/runtime')
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
