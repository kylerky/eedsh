import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDshHome, resolveProfileDir } from '../../src/internal/dsh-home'

describe('local DSH home resolution', () => {
  it('falls back to ~/.dsh when DSH_HOME is unset', () => {
    expect(resolveDshHome(undefined, { HOME: '/home/user' })).toBe(resolve('/home/user', '.dsh'))
  })

  it('treats an empty or whitespace DSH_HOME as unset', () => {
    expect(resolveDshHome(undefined, { HOME: '/home/user', DSH_HOME: '' })).toBe(
      resolve('/home/user', '.dsh'),
    )
    expect(resolveDshHome(undefined, { HOME: '/home/user', DSH_HOME: '   ' })).toBe(
      resolve('/home/user', '.dsh'),
    )
  })

  it('uses an absolute DSH_HOME as is', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: '/srv/dsh-home' })).toBe(resolve('/srv/dsh-home'))
  })

  it('resolves a relative DSH_HOME against the working directory', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: 'relative-home' })).toBe(
      resolve(process.cwd(), 'relative-home'),
    )
  })

  it('expands a tilde prefix against the environment home directory', () => {
    expect(resolveDshHome(undefined, { HOME: '/home/user', DSH_HOME: '~/harness' })).toBe(
      resolve('/home/user', 'harness'),
    )
  })

  it('expands a bare tilde against the environment home directory', () => {
    expect(resolveDshHome(undefined, { HOME: '/home/user', DSH_HOME: '~' })).toBe(
      resolve('/home/user'),
    )
  })

  it('falls back to the OS home for a tilde when HOME is unset', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: '~/harness' })).toBe(resolve(homedir(), 'harness'))
  })

  it('lets an explicit home win over the environment', () => {
    expect(resolveDshHome('/explicit', { DSH_HOME: '/ignored' })).toBe(resolve('/explicit'))
  })
})

describe('local profile path resolution', () => {
  it('places a profile below the given home', () => {
    expect(resolveProfileDir('work', '/srv/dsh-home')).toBe(
      join('/srv/dsh-home', 'profiles', 'work'),
    )
  })

  it('uses DSH_HOME when no home is given', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = '/tmp/eedsh-home'
    try {
      expect(resolveProfileDir('work')).toBe(join(resolve('/tmp/eedsh-home'), 'profiles', 'work'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('rejects names that are not safe path segments', () => {
    for (const name of ['', '.', '..', 'node_modules', 'a/b', 'a\\b']) {
      expect(() => resolveProfileDir(name, '/srv/dsh-home'), name).toThrow(/invalid profile name/)
    }
  })
})
