import { describe, expect, it } from 'vitest'
import { isSemverRange, versionSatisfies } from '../../src/internal/semver'

describe('semver helper', () => {
  it('accepts a version inside the recorded range', () => {
    expect(versionSatisfies('^1.2.0', '1.9.0')).toBe(true)
    expect(versionSatisfies('~1.2.0', '1.2.9')).toBe(true)
  })

  it('rejects a version outside the recorded range', () => {
    expect(versionSatisfies('^1.2.0', '2.0.0')).toBe(false)
    expect(versionSatisfies('1.0.0', '1.0.1')).toBe(false)
  })

  it('returns undefined for an unparseable version', () => {
    expect(versionSatisfies('^1.0.0', 'not-a-version')).toBeUndefined()
  })

  it('recognizes semver ranges and rejects link, file, and workspace specs', () => {
    expect(isSemverRange('^1.0.0')).toBe(true)
    expect(isSemverRange('1.0.0')).toBe(true)
    expect(isSemverRange('link:./.eedsh/generated')).toBe(false)
    expect(isSemverRange('file:../package')).toBe(false)
    expect(isSemverRange('workspace:*')).toBe(false)
  })
})
