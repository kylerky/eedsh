import { bundle, defineProfile, generated, type PlanBundle, type ProfilePlan } from '@eedsh/config'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  managedBundleOrder,
  readPreviousGeneration,
  reconcileManifest,
} from '../../src/materialize/manifest'
import { ensureProfileFiles } from '../../src/materialize/profile'

const runtimeSpec = 'link:/repo/packages/runtime'
const generatedSpec = 'link:./.eedsh/generated'

function plan(bundles: readonly PlanBundle[], packages: Record<string, string> = {}): ProfilePlan {
  return defineProfile({ name: 'work', dsh: '0.2.1-rc.2', bundles, packages })
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
    runtimeSpec,
    generatedSpec,
    ...options,
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

  it('lets the managed specification win on collision', () => {
    const manifest = { dependencies: { '@scope/plugin': '^1.0.0' } }
    const result = reconcile(plan([bundle(BUNDLE)], { '@scope/plugin': '2.0.0' }), { manifest })
    expect(result.dependencies['@scope/plugin']).toBe('2.0.0')
  })

  it('reads previous managed sets from the generation record', () => {
    const record = {
      eedsh: {
        format: 'eedsh/generation',
        version: 1,
        generationId: 'a'.repeat(64),
        bundles: [BUNDLE, '@eedsh/runtime', '@eedsh/generated'],
        packages: { '@eedsh/generated': generatedSpec },
      },
    }
    expect(readPreviousGeneration(record)).toEqual({
      bundles: [BUNDLE, '@eedsh/runtime', '@eedsh/generated'],
      packages: { '@eedsh/generated': generatedSpec },
    })
    expect(readPreviousGeneration({})).toBeUndefined()
    expect(readPreviousGeneration({ eedsh: { format: 'other' } })).toBeUndefined()
  })
})

describe('profile files', () => {
  function memoryIo(initial: Record<string, string> = {}) {
    const files = new Map(Object.entries(initial))
    const dirs: string[] = []
    const io = {
      exists: (path: string) => Effect.succeed(files.has(path)),
      readFile: (path: string) => Effect.succeed(files.get(path) ?? ''),
      writeFileAtomic: (path: string, content: string) =>
        Effect.sync(() => files.set(path, content)),
      ensureDir: (path: string) => Effect.sync(() => dirs.push(path)),
    }
    return { io, files, dirs }
  }

  it('never rewrites an existing profile patch', async () => {
    const existing = '- id: timer\n  config:\n    interval: 1\n'
    const { io, files } = memoryIo({ '/profile/cordis.patch.yml': existing })
    const result = await Effect.runPromise(ensureProfileFiles('/profile', io))
    expect(result.createdPatch).toBe(false)
    expect(files.get('/profile/cordis.patch.yml')).toBe(existing)
  })

  it('creates an empty profile patch when missing', async () => {
    const { io, files } = memoryIo()
    const result = await Effect.runPromise(ensureProfileFiles('/profile', io))
    expect(result.createdPatch).toBe(true)
    expect(files.get('/profile/cordis.patch.yml')?.trim()).toBe('[]')
  })

  it('creates the empty root config and the profile workspace when missing', async () => {
    const { io, files } = memoryIo()
    await Effect.runPromise(ensureProfileFiles('/profile', io))
    expect(files.get('/profile/cordis.yml')?.trim()).toBe('[]')
    expect(files.get('/profile/pnpm-workspace.yaml')).toContain('nodeLinker: hoisted')
  })

  it('does not rewrite existing root and workspace files', async () => {
    const { io, files } = memoryIo({
      '/profile/cordis.yml': '# mine\n[]\n',
      '/profile/pnpm-workspace.yaml': 'packages:\n  - .\n',
    })
    await Effect.runPromise(ensureProfileFiles('/profile', io))
    expect(files.get('/profile/cordis.yml')).toBe('# mine\n[]\n')
    expect(files.get('/profile/pnpm-workspace.yaml')).toBe('packages:\n  - .\n')
  })
})
