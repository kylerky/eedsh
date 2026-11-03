import { describe, expect, it } from 'vitest'
import {
  resolveSourceLocation,
  sourceAcquisitionKind,
  sourceCheckoutDir,
  sourceKey,
  sourceLinkSpec,
  sourceLockPath,
  sourceStatePath,
} from '../../src/provision/source'

describe('source acquisition kind', () => {
  it('reads the git schemes and scp-like forms as git sources', () => {
    for (const from of [
      'https://example.test/acme/bundle.git',
      'http://example.test/acme/bundle.git',
      'git://example.test/acme/bundle.git',
      'ssh://git@example.test/acme/bundle.git',
      'file:///home/me/src/acme-bundle',
      'git@example.test:acme/bundle.git',
    ]) {
      expect(sourceAcquisitionKind(from), from).toBe('git')
    }
  })

  it('reads a plain path as a local checkout', () => {
    for (const from of [
      './dir',
      '../acme-bundle',
      '/home/me/src/acme-bundle',
      '~/src/acme-bundle',
      'bundle',
      'C:\\src\\acme-bundle',
    ]) {
      expect(sourceAcquisitionKind(from), from).toBe('local')
    }
  })

  it('never infers the kind from the directory name', () => {
    expect(sourceAcquisitionKind('./acme-bundle.git')).toBe('local')
    expect(sourceAcquisitionKind('/home/me/bundle.git')).toBe('local')
    // A file URL is explicit even though it names a local directory.
    expect(sourceAcquisitionKind('file:///home/me/bundle.git')).toBe('git')
  })
})

describe('source location resolution', () => {
  const configDir = '/work/profiles/work'

  it('resolves a relative path against the config directory', () => {
    expect(resolveSourceLocation('../acme-bundle', configDir)).toEqual({
      kind: 'local',
      location: '/work/profiles/acme-bundle',
    })
  })

  it('leaves an absolute path alone', () => {
    expect(resolveSourceLocation('/srv/acme-bundle', configDir)).toEqual({
      kind: 'local',
      location: '/srv/acme-bundle',
    })
  })

  it('expands a home-relative path', () => {
    expect(resolveSourceLocation('~/src/acme-bundle', configDir, '/home/me')).toEqual({
      kind: 'local',
      location: '/home/me/src/acme-bundle',
    })
  })

  it('keeps a git location as authored', () => {
    for (const from of [
      'https://example.test/acme/bundle.git',
      'git@example.test:acme/bundle.git',
      'file:///home/me/src/acme-bundle',
    ]) {
      expect(resolveSourceLocation(from, configDir)).toEqual({ kind: 'git', location: from })
    }
  })
})

describe('source identity', () => {
  const home = '/dsh-home'

  it('maps one repository and ref to one checkout directory', () => {
    const first = sourceKey({ from: 'https://example.test/acme/bundle.git', ref: 'main' })
    const second = sourceKey({ from: 'https://example.test/acme/bundle.git', ref: 'main' })
    expect(first).toBe(second)
    expect(sourceCheckoutDir(home, first)).toBe(sourceCheckoutDir(home, second))
  })

  it('gives distinct refs distinct checkout directories', () => {
    const main = sourceKey({ from: 'https://example.test/acme/bundle.git', ref: 'main' })
    const next = sourceKey({ from: 'https://example.test/acme/bundle.git', ref: 'next' })
    expect(main).not.toBe(next)
    expect(sourceCheckoutDir(home, main)).not.toBe(sourceCheckoutDir(home, next))
  })

  it('is stable across invocations and safe as one directory name', () => {
    const key = sourceKey({ from: 'git@example.test:acme/bundle.git', ref: 'v1' })
    expect(key).toBe('bundle-6befbe83f42909a2')
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(key).not.toContain('..')
    expect(key.endsWith('.git')).toBe(false)
  })

  it('drops the .git suffix from the readable part', () => {
    for (const from of [
      'https://example.test/acme/bundle.git',
      'git@example.test:acme/bundle.git',
      'file:///home/me/src/acme-bundle',
    ]) {
      expect(sourceKey({ from })).toMatch(/^(bundle|acme-bundle)-[0-9a-f]{16}$/)
    }
  })

  it('writes the profile link specification with forward slashes', () => {
    expect(sourceLinkSpec('/dsh-home/.local/sources/plugin-abc')).toBe(
      'link:/dsh-home/.local/sources/plugin-abc',
    )
    expect(sourceLinkSpec('C:\\dsh-home\\sources\\plugin-abc')).toBe(
      'link:C:/dsh-home/sources/plugin-abc',
    )
  })

  it('places checkouts, state, and locks below the DSH home .local directory', () => {
    const key = 'bundle-abc'
    expect(sourceCheckoutDir(home, key)).toBe('/dsh-home/.local/sources/bundle-abc')
    expect(sourceStatePath(home, key)).toBe('/dsh-home/.local/state/sources/bundle-abc.json')
    expect(sourceLockPath(home, key)).toBe('/dsh-home/.local/locks/bundle-abc.lock')
  })
})
