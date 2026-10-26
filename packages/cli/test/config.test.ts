import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  unsupportedConfigExtensionError,
  validateConfigPath,
} from '../src/config'

describe('config path validation', () => {
  it('accepts a supported TypeScript config path', () => {
    const result = validateConfigPath('/work/eedsh.config.ts')
    expect(Result.isSuccess(result)).toBe(true)
  })

  it('returns a tagged failure for a JavaScript config path', () => {
    const result = validateConfigPath('/work/eedsh.config.js')
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(Error)
      expect(result.failure._tag).toBe('ConfigError')
      expect(result.failure.code).toBe('config.unsupported_extension')
    }
  })

  it('builds tagged config failures', () => {
    const error = unsupportedConfigExtensionError('/work/eedsh.config.js')
    expect(error).toBeInstanceOf(ConfigError)
    expect(error._tag).toBe('ConfigError')
    expect(error.code).toBe('config.unsupported_extension')
    expect(error.message).toContain('eedsh.config.ts')
  })
})
