import { createRequire } from 'node:module'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import {
  resolveBundleLayers,
  resolveDshInstallation,
  SUPPORTED_DSH_RANGE,
  supportsDshVersion,
} from '../src/dsh'

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
describe('supported DSH range policy', () => {
  it('declares the supported range as ^0.2.1-rc.2', () => {
    expect(SUPPORTED_DSH_RANGE).toBe('^0.2.1-rc.2')
  })

  it('accepts the current release line, including prereleases', () => {
    for (const version of ['0.2.1-rc.2', '0.2.1-rc.5', '0.2.2-alpha.2', '0.2.1', '0.2.2']) {
      expect(supportsDshVersion(version), version).toBe(true)
    }
  })

  it('rejects versions outside the range', () => {
    for (const version of ['0.2.0', '0.2.1-rc.1', '0.3.0', '1.0.0', 'latest', '']) {
      expect(supportsDshVersion(version), version).toBe(false)
    }
  })
})
