import { bundle, generated } from '../support/plan-parts'
import { canonicalJson, type PlanBundle, type ProfilePlan } from '@eedsh/plan'
import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  managedBundleOrder,
  readProfileBundles,
  readProfileDependencies,
  reconcileManifest,
} from '../../src/materialize/manifest'
import { ensureProfileFiles } from '../../src/materialize/profile'
import { memoryFileSystem } from '../support/fakes'
import { planOf } from '../support/plan'

const runtimeSpec = 'link:/repo/packages/runtime'
const generatedSpec = 'link:./.eedsh/generated'

function plan(bundles: readonly PlanBundle[], packages: Record<string, string> = {}): ProfilePlan {
  return planOf({ name: 'work', dsh: '0.2.1-rc.2', bundles, packages })
}

function reconcile(
  value: ProfilePlan,
  options: {
    manifest?: Record<string, unknown>
    previous?: { bundles: readonly string[]; packages: Record<string, string> }
  } = {},
) {
  return reconcileManifest({
    profileName: 'work',
    plan: value,
    manifest: Option.fromUndefinedOr(options.manifest),
    previous: Option.fromUndefinedOr(options.previous),
    runtimeSpec,
    generatedSpec,
  })
}

const BUNDLE = '@deepseek-ai/dsh-base'

describe('managed bundle order', () => {
  it('places the runtime bundle immediately before the generated bundle', () => {
    expect(managedBundleOrder(plan([bundle(BUNDLE)]))).toEqual([
      BUNDLE,
      '@eedsh/runtime',
      '@eedsh/generated',
    ])
  })

  it('honours the positional generated marker', () => {
    const value = plan([bundle('first'), generated(), bundle('second')])
    expect(managedBundleOrder(value)).toEqual([
      'first',
      '@eedsh/runtime',
      '@eedsh/generated',
      'second',
    ])
  })

  it('places the generated bundle last among managed bundles without a marker', () => {
    expect(managedBundleOrder(plan([bundle('first'), bundle('second')]))).toEqual([
      'first',
      'second',
      '@eedsh/runtime',
      '@eedsh/generated',
    ])
  })
})

describe('tolerant profile readers', () => {
  it('reads no bundles when the dsh or profile section is missing or malformed', () => {
    expect(readProfileBundles(Option.none())).toEqual([])
    expect(readProfileBundles(Option.some({}))).toEqual([])
    expect(readProfileBundles(Option.some({ dsh: null }))).toEqual([])
    expect(readProfileBundles(Option.some({ dsh: { profile: 'not-a-record' } }))).toEqual([])
    expect(
      readProfileBundles(Option.some({ dsh: { profile: { bundles: 'not-an-array' } } })),
    ).toEqual([])
  })

  it('keeps string bundles and drops invalid siblings', () => {
    expect(
      readProfileBundles(
        Option.some({
          dsh: { profile: { bundles: [BUNDLE, 1, null, '@edsh/adapted-ptc', ''] } },
        }),
      ),
    ).toEqual([BUNDLE, '@edsh/adapted-ptc', ''])
  })

  it('reads empty dependency sections from a missing or malformed manifest', () => {
    const empty = { dependencies: {}, devDependencies: {}, optionalDependencies: {} }
    expect(readProfileDependencies(Option.none())).toEqual(empty)
    expect(
      readProfileDependencies(
        Option.some({
          dependencies: null,
          devDependencies: ['not-a-record'],
          optionalDependencies: 'not-a-record',
        }),
      ),
    ).toEqual(empty)
  })

  it('keeps string dependencies and drops invalid siblings', () => {
    expect(
      readProfileDependencies(
        Option.some({
          dependencies: { good: '1.0.0', bad: 1, nil: null, empty: '', nested: {} },
          devDependencies: { tool: '^2.0.0', flag: false },
          optionalDependencies: { optional: '3.0.0', list: [] },
        }),
      ),
    ).toEqual({
      dependencies: { good: '1.0.0', empty: '' },
      devDependencies: { tool: '^2.0.0' },
      optionalDependencies: { optional: '3.0.0' },
    })
  })

  it('treats empty records as empty sections', () => {
    expect(readProfileBundles(Option.some({ dsh: { profile: { bundles: [] } } }))).toEqual([])
    expect(readProfileDependencies(Option.some({ dependencies: {} }))).toEqual({
      dependencies: {},
      devDependencies: {},
      optionalDependencies: {},
    })
  })

  it('ignores malformed and empty conflict sections', () => {
    const result = reconcile(plan([bundle(BUNDLE)], { '@scope/plugin': '1.0.0' }), {
      manifest: {
        peerDependencies: { '@scope/plugin': '*' },
        pnpm: 'not-a-record',
        overrides: null,
        resolutions: [],
      },
    })
    expect(result.notices.map((item) => item.message)).toEqual([
      'managed package @scope/plugin is also declared in peerDependencies; the resolved version may differ',
    ])
  })

  it('ignores a malformed or empty pnpm.overrides section', () => {
    const malformed = reconcile(plan([bundle(BUNDLE)], { '@scope/plugin': '1.0.0' }), {
      manifest: { pnpm: { overrides: 'not-a-record' } },
    })
    const empty = reconcile(plan([bundle(BUNDLE)], { '@scope/plugin': '1.0.0' }), {
      manifest: { pnpm: { overrides: {} } },
    })
    expect(malformed.notices).toEqual([])
    expect(empty.notices).toEqual([])
  })
})

describe('manifest reconciliation', () => {
  it('creates a new profile manifest with managed bundles and dependencies', () => {
    const result = reconcile(plan([bundle(BUNDLE)], { '@scope/plugin': '1.2.3' }))
    expect(result.manifest).toMatchObject({
      name: 'dsh-profile-work',
      private: true,
      dsh: { profile: { bundles: [BUNDLE, '@eedsh/runtime', '@eedsh/generated'] } },
    })
    expect(result.dependencies).toEqual({
      '@scope/plugin': '1.2.3',
      '@eedsh/runtime': runtimeSpec,
      '@eedsh/generated': generatedSpec,
    })
    expect(result.manifest.dependencies).toEqual(result.dependencies)
    expect(result.managedPackages).toEqual({
      '@eedsh/generated': generatedSpec,
      '@eedsh/runtime': runtimeSpec,
      '@scope/plugin': '1.2.3',
    })
  })

  it('exposes an empty notice list for a first reconciliation', () => {
    const result = reconcile(plan([bundle(BUNDLE)]))
    expect(result.notices).toEqual([])
  })

  it('preserves unrelated manifest fields', () => {
    const manifest = {
      name: 'mine',
      private: true,
      description: 'keep me',
      dsh: { profile: { bundles: [] } },
    }
    const result = reconcile(plan([bundle(BUNDLE)]), { manifest })
    expect(result.manifest.name).toBe('mine')
    expect(result.manifest.description).toBe('keep me')
  })

  it('creates the dsh section when the manifest has none', () => {
    const manifest = { name: 'mine', description: 'keep me' }
    const result = reconcile(plan([bundle(BUNDLE)]), { manifest })
    expect(result.manifest.dsh).toEqual({
      profile: { bundles: [BUNDLE, '@eedsh/runtime', '@eedsh/generated'] },
    })
    expect(result.manifest.name).toBe('mine')
    expect(result.manifest.description).toBe('keep me')
  })

  const malformedSections: [string, unknown][] = [
    ['null', null],
    ['an array', []],
    ['a scalar', 'not-a-record'],
  ]

  it.each(malformedSections)('replaces a dsh section that is %s', (_label, value) => {
    const result = reconcile(plan([bundle(BUNDLE)]), { manifest: { dsh: value } })
    expect(result.manifest.dsh).toEqual({
      profile: { bundles: [BUNDLE, '@eedsh/runtime', '@eedsh/generated'] },
    })
  })

  it.each(malformedSections)('replaces a profile section that is %s', (_label, value) => {
    const manifest = { dsh: { runtime: 'keep', profile: value } }
    const result = reconcile(plan([bundle(BUNDLE)]), { manifest })
    expect(result.manifest.dsh).toEqual({
      runtime: 'keep',
      profile: { bundles: [BUNDLE, '@eedsh/runtime', '@eedsh/generated'] },
    })
  })

  it('preserves unrelated fields inside the dsh and profile sections', () => {
    const manifest = {
      dsh: {
        runtime: 'keep',
        profile: { bundles: [], theme: 'dark' },
      },
    }
    const result = reconcile(plan([bundle(BUNDLE)]), { manifest })
    expect(result.manifest.dsh).toEqual({
      runtime: 'keep',
      profile: { theme: 'dark', bundles: [BUNDLE, '@eedsh/runtime', '@eedsh/generated'] },
    })
  })

  it('does not mutate the input manifest', () => {
    const manifest = {
      name: 'mine',
      dsh: {
        runtime: 'keep',
        profile: { bundles: [BUNDLE, '@edsh/adapted-ptc'], theme: 'dark' },
      },
    }
    const before = structuredClone(manifest)
    reconcile(plan([bundle(BUNDLE)]), { manifest })
    expect(manifest).toEqual(before)
  })

  it('reconciles deterministically and reaches a canonical fixed point', () => {
    const manifest = {
      name: 'mine',
      dsh: {
        runtime: 'keep',
        profile: { bundles: [BUNDLE, '@edsh/adapted-ptc'], theme: 'dark' },
      },
    }
    const first = reconcile(plan([bundle(BUNDLE)]), { manifest })
    const repeated = reconcile(plan([bundle(BUNDLE)]), { manifest })
    const fixedPoint = reconcile(plan([bundle(BUNDLE)]), { manifest: first.manifest })
    expect(canonicalJson(repeated.manifest)).toBe(canonicalJson(first.manifest))
    expect(canonicalJson(fixedPoint.manifest)).toBe(canonicalJson(first.manifest))
  })

  it('preserves user-added bundles after the managed bundles', () => {
    const manifest = { dsh: { profile: { bundles: [BUNDLE, '@edsh/adapted-ptc'] } } }
    const previous = {
      bundles: [BUNDLE, '@eedsh/runtime', '@eedsh/generated'],
      packages: {},
    }
    const result = reconcile(plan([bundle(BUNDLE)]), { manifest, previous })
    expect(result.bundles).toEqual([
      BUNDLE,
      '@eedsh/runtime',
      '@eedsh/generated',
      '@edsh/adapted-ptc',
    ])
  })

  it('removes a bundle managed by an earlier generation', () => {
    const manifest = { dsh: { profile: { bundles: [BUNDLE, '@old/bundle'] } } }
    const previous = {
      bundles: [BUNDLE, '@old/bundle', '@eedsh/runtime', '@eedsh/generated'],
      packages: {},
    }
    const result = reconcile(plan([bundle(BUNDLE)]), { manifest, previous })
    expect(result.bundles).not.toContain('@old/bundle')
    expect(result.bundles).toEqual([BUNDLE, '@eedsh/runtime', '@eedsh/generated'])
  })

  it('does not duplicate a bundle that is also listed outside eedsh', () => {
    const manifest = {
      dsh: { profile: { bundles: ['@edsh/adapted-ptc', BUNDLE, '@edsh/adapted-ptc'] } },
    }
    const result = reconcile(plan([bundle(BUNDLE)]), { manifest })
    expect(result.bundles.filter((name) => name === '@edsh/adapted-ptc')).toHaveLength(1)
    expect(result.bundles.at(-1)).toBe('@edsh/adapted-ptc')
  })

  it('preserves user dependencies and removes previously managed ones', () => {
    const manifest = {
      dependencies: {
        '@edsh/adapted-ptc': 'link:/repo/adapted',
        '@eedsh/config': 'link:/repo/config',
      },
    }
    const previous = {
      bundles: [],
      packages: { '@eedsh/config': 'link:/repo/config' },
    }
    const result = reconcile(plan([bundle(BUNDLE)]), { manifest, previous })
    expect(result.dependencies['@edsh/adapted-ptc']).toBe('link:/repo/adapted')
    expect(result.dependencies['@eedsh/config']).toBeUndefined()
    expect(result.dependencies['@eedsh/runtime']).toBe(runtimeSpec)
  })

  it('cleans a managed duplicate out of devDependencies', () => {
    const manifest = {
      dependencies: {},
      devDependencies: { '@scope/plugin': '^1.0.0', '@scope/tool': '^2.0.0' },
    }
    const result = reconcile(plan([bundle(BUNDLE)], { '@scope/plugin': '1.0.0' }), { manifest })
    expect(result.manifest.devDependencies).toEqual({ '@scope/tool': '^2.0.0' })
    expect(result.dependencies['@scope/plugin']).toBe('1.0.0')
  })

  it('cleans a managed duplicate out of optionalDependencies', () => {
    const manifest = {
      optionalDependencies: { '@scope/plugin': '^1.0.0', '@scope/optional': '3.0.0' },
    }
    const result = reconcile(plan([bundle(BUNDLE)], { '@scope/plugin': '1.0.0' }), { manifest })
    expect(result.manifest.optionalDependencies).toEqual({ '@scope/optional': '3.0.0' })
    expect(result.dependencies['@scope/plugin']).toBe('1.0.0')
  })

  it('cleans a previously managed name out of devDependencies', () => {
    const manifest = { devDependencies: { '@scope/old': '1.0.0', '@scope/tool': '2.0.0' } }
    const previous = { bundles: [], packages: { '@scope/old': '1.0.0' } }
    const result = reconcile(plan([bundle(BUNDLE)]), { manifest, previous })
    expect(result.manifest.devDependencies).toEqual({ '@scope/tool': '2.0.0' })
  })

  it('leaves a malformed dependency section untouched', () => {
    const manifest = {
      devDependencies: { '@scope/plugin': 1 },
      optionalDependencies: ['@scope/plugin'],
    }
    const result = reconcile(plan([bundle(BUNDLE)], { '@scope/plugin': '1.0.0' }), { manifest })
    expect(result.manifest.devDependencies).toEqual({ '@scope/plugin': 1 })
    expect(result.manifest.optionalDependencies).toEqual(['@scope/plugin'])
  })

  it('does not create dependency sections that were absent', () => {
    const result = reconcile(plan([bundle(BUNDLE)], { '@scope/plugin': '1.0.0' }))
    expect(result.manifest.devDependencies).toBeUndefined()
    expect(result.manifest.optionalDependencies).toBeUndefined()
  })

  it('keeps unrelated dev dependencies in their original order', () => {
    const manifest = {
      devDependencies: { zebra: '1.0.0', '@scope/plugin': '1.0.0', alpha: '2.0.0' },
    }
    const result = reconcile(plan([bundle(BUNDLE)], { '@scope/plugin': '1.0.0' }), { manifest })
    expect(Object.keys(result.manifest.devDependencies as Record<string, string>)).toEqual([
      'zebra',
      'alpha',
    ])
  })

  it('reports a notice for every managed entry removed from an owned section', () => {
    const manifest = {
      devDependencies: { '@scope/plugin': '1.0.0', '@scope/tool': '2.0.0' },
      optionalDependencies: { '@scope/plugin': '1.0.0' },
    }
    const result = reconcile(plan([bundle(BUNDLE)], { '@scope/plugin': '1.0.0' }), { manifest })
    expect(result.notices).toEqual([
      { severity: 'notice', message: 'removed @scope/plugin from devDependencies' },
      { severity: 'notice', message: 'removed @scope/plugin from optionalDependencies' },
    ])
  })

  it('reports a malformed dependency section as a warning', () => {
    const manifest = { devDependencies: { '@scope/plugin': 1 } }
    const result = reconcile(plan([bundle(BUNDLE)], { '@scope/plugin': '1.0.0' }), { manifest })
    expect(result.notices).toHaveLength(1)
    expect(result.notices[0]?.severity).toBe('warning')
    expect(result.notices[0]?.message).toContain('devDependencies')
    expect(result.notices[0]?.message).toContain('left unchanged')
  })

  it('warns about peer and override conflicts without editing those fields', () => {
    const manifest = {
      peerDependencies: { '@scope/plugin': '*' },
      pnpm: { overrides: { '@scope/plugin': '1.0.0' } },
      overrides: { '@scope/plugin': '^1.0.0' },
      resolutions: { '@scope/plugin': '1.0.0' },
    }
    const result = reconcile(plan([bundle(BUNDLE)], { '@scope/plugin': '1.0.0' }), { manifest })
    expect(result.notices.map((item) => item.severity)).toEqual([
      'warning',
      'warning',
      'warning',
      'warning',
    ])
    for (const field of ['overrides', 'peerDependencies', 'pnpm.overrides', 'resolutions']) {
      expect(
        result.notices.some(
          (item) => item.message.includes('@scope/plugin') && item.message.includes(field),
        ),
      ).toBe(true)
    }
    expect(result.manifest.peerDependencies).toEqual({ '@scope/plugin': '*' })
    expect(result.manifest.pnpm).toEqual({ overrides: { '@scope/plugin': '1.0.0' } })
    expect(result.manifest.overrides).toEqual({ '@scope/plugin': '^1.0.0' })
    expect(result.manifest.resolutions).toEqual({ '@scope/plugin': '1.0.0' })
  })

  it('orders diagnostics by section and package name', () => {
    const manifest = {
      devDependencies: { zebra: '1.0.0', '@scope/plugin': '1.0.0', '@scope/another': '1.0.0' },
      peerDependencies: { '@scope/plugin': '*', '@scope/another': '*' },
    }
    const packages = { '@scope/plugin': '1.0.0', '@scope/another': '1.0.0' }
    const result = reconcile(plan([bundle(BUNDLE)], packages), { manifest })
    expect(result.notices.map((item) => item.message)).toEqual([
      'removed @scope/another from devDependencies',
      'removed @scope/plugin from devDependencies',
      'managed package @scope/another is also declared in peerDependencies; the resolved version may differ',
      'managed package @scope/plugin is also declared in peerDependencies; the resolved version may differ',
    ])
  })

  it('treats a bundle re-added after its removal was published as user-owned', () => {
    // The previous record no longer lists @edsh/adapted-ptc, so re-adding it
    // to the manifest outside eedsh makes it user-owned and protected.
    const manifest = {
      dsh: { profile: { bundles: [BUNDLE, '@edsh/adapted-ptc'] } },
      dependencies: {},
    }
    const previous = { bundles: [BUNDLE, '@eedsh/runtime', '@eedsh/generated'], packages: {} }
    const result = reconcile(plan([bundle(BUNDLE)]), { manifest, previous })
    expect(result.bundles).toEqual([
      BUNDLE,
      '@eedsh/runtime',
      '@eedsh/generated',
      '@edsh/adapted-ptc',
    ])
  })

  it('treats a dependency re-added after its removal was published as user-owned', () => {
    const manifest = { dependencies: { '@edsh/adapted-ptc': 'link:/repo/adapted' } }
    const previous = { bundles: [], packages: { '@eedsh/config': 'link:/repo/config' } }
    const result = reconcile(plan([bundle(BUNDLE)]), { manifest, previous })
    expect(result.dependencies['@edsh/adapted-ptc']).toBe('link:/repo/adapted')
  })

  it('removes a re-added bundle while its removal is still unpublished', () => {
    // The previous record still marks @old/bundle as managed, so the pending
    // removal wins even though the manifest lists it again.
    const manifest = { dsh: { profile: { bundles: [BUNDLE, '@old/bundle'] } } }
    const previous = {
      bundles: [BUNDLE, '@old/bundle', '@eedsh/runtime', '@eedsh/generated'],
      packages: {},
    }
    const result = reconcile(plan([bundle(BUNDLE)]), { manifest, previous })
    expect(result.bundles).not.toContain('@old/bundle')
  })

  it('lets the managed specification win on collision', () => {
    const manifest = { dependencies: { '@scope/plugin': '^1.0.0' } }
    const result = reconcile(plan([bundle(BUNDLE)], { '@scope/plugin': '2.0.0' }), { manifest })
    expect(result.dependencies['@scope/plugin']).toBe('2.0.0')
  })
})

describe('profile files', () => {
  it('never rewrites an existing profile patch', async () => {
    const existing = '- id: timer\n  config:\n    interval: 1\n'
    const fs = memoryFileSystem({ '/profile/cordis.patch.yml': existing })
    const result = await Effect.runPromise(ensureProfileFiles('/profile', fs.fs))
    expect(result.createdPatch).toBe(false)
    expect(fs.files.get('/profile/cordis.patch.yml')).toBe(existing)
  })

  it('creates an empty profile patch when missing', async () => {
    const fs = memoryFileSystem()
    const result = await Effect.runPromise(ensureProfileFiles('/profile', fs.fs))
    expect(result.createdPatch).toBe(true)
    expect(fs.files.get('/profile/cordis.patch.yml')?.trim()).toBe('[]')
  })

  it('creates the empty root config and the profile workspace when missing', async () => {
    const fs = memoryFileSystem()
    await Effect.runPromise(ensureProfileFiles('/profile', fs.fs))
    expect(fs.files.get('/profile/cordis.yml')?.trim()).toBe('[]')
    expect(fs.files.get('/profile/pnpm-workspace.yaml')).toContain('nodeLinker: hoisted')
  })

  it('does not rewrite existing root and workspace files', async () => {
    const fs = memoryFileSystem({
      '/profile/cordis.yml': '# mine\n[]\n',
      '/profile/pnpm-workspace.yaml': 'packages:\n  - .\n',
    })
    await Effect.runPromise(ensureProfileFiles('/profile', fs.fs))
    expect(fs.files.get('/profile/cordis.yml')).toBe('# mine\n[]\n')
    expect(fs.files.get('/profile/pnpm-workspace.yaml')).toBe('packages:\n  - .\n')
  })
})
