import {
  activeDshBridge,
  clearDshBridge,
  defineConfig,
  dshVersion,
  installDshBridge,
  ResolutionError,
  type DshBridge,
} from '@eedsh/config'
import * as Result from 'effect/Result'
import { afterEach, describe, expect, it } from 'vitest'

const required = {
  resolveProfileDir: () => '/tmp/profile',
  resolveBundleDir: () => '/tmp/bundle',
  readProfileManifest: () => ({}),
  bundlePatchFiles: () => [],
  loadOverlayPatches: () => [],
  composeEntries: () => [],
}

function bridge(version: string): DshBridge {
  return {
    version,
    installation: {
      installAnchor: '/tmp/dsh/package.json',
      packageDir: '/tmp/dsh',
      binPath: '/tmp/dsh/lib/bin.js',
    },
    ...required,
  }
}

afterEach(() => {
  clearDshBridge()
})

describe('dshVersion()', () => {
  it('returns the selected installation version synchronously', () => {
    installDshBridge(bridge('0.2.1-rc.5'))
    const value = dshVersion()
    expect(value).toBe('0.2.1-rc.5')
    expect(value).not.toBeInstanceOf(Promise)
  })

  it('returns the running version regardless of plan or config data', () => {
    installDshBridge(bridge('0.2.2-alpha.2'))
    const built = defineConfig()
      .profile('work', (profile) => profile.bundle('@deepseek-ai/dsh-base'))
      .build()
    expect(Result.isSuccess(built)).toBe(true)
    expect(dshVersion()).toBe('0.2.2-alpha.2')
    if (Result.isSuccess(built)) {
      const plan = built.success.profiles.work
      if (plan !== undefined && Result.isSuccess(plan)) {
        expect(JSON.stringify(plan.success)).not.toContain('0.2.2-alpha.2')
      }
    }
  })

  it('fails loudly without a bridge and names the remedies', () => {
    let error: unknown
    try {
      dshVersion()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ResolutionError)
    const failure = error as ResolutionError
    expect(failure.code).toBe('resolution.bridge_missing')
    expect(failure.message).toContain('eedsh sync')
    expect(failure.message).toContain('eedsh run')
    expect(failure.message).toContain('--dsh')
  })

  it('exposes and clears the active bridge', () => {
    const value = bridge('0.2.1-rc.2')
    installDshBridge(value)
    expect(activeDshBridge()).toBe(value)
    clearDshBridge()
    expect(activeDshBridge()).toBeUndefined()
  })
})
