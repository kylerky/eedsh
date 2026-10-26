import { createRequire } from 'node:module'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { resolveBundleLayers, resolveDshInstallation } from '../src/dsh'

const require = createRequire(import.meta.url)

describe('dsh resolution', () => {
  it('returns the installation as a Result', () => {
    const result = resolveDshInstallation()
    expect(Result.isSuccess(result)).toBe(true)
  })

  it('returns a tagged failure for a missing bundle', () => {
    const anchor = require.resolve('@deepseek-ai/dsh/package.json')
    const result = resolveBundleLayers('@scope/definitely-missing-bundle', process.cwd(), anchor)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe('DshResolveFailure')
      expect(result.failure.packageName).toBe('@scope/definitely-missing-bundle')
    }
  })
})
