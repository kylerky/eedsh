import { defineConfig, type ProfileBuilder, SourceDeclarationError } from '@eedsh/config'
import { type ProfilePlan, validatePlan } from '@eedsh/plan'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'

function builtPlan(build: (profile: ProfileBuilder) => void): ProfilePlan {
  const built = defineConfig().profile('work', build).build()
  if (Result.isFailure(built)) throw built.failure
  const plan = built.success.profiles.work
  if (plan === undefined) throw new Error('the profile was not built')
  if (Result.isFailure(plan)) throw plan.failure
  return plan.success
}

const gitSource = { from: 'https://example.test/acme/bundle.git', ref: 'v1.2.3' }

describe('source declarations', () => {
  it('records a declaration in the built plan', () => {
    const plan = builtPlan((profile) => profile.source('@scope/plugin', gitSource))
    expect(plan.sources).toEqual({
      '@scope/plugin': {
        from: gitSource.from,
        ref: 'v1.2.3',
        prepare: [
          ['pnpm', 'install'],
          ['pnpm', 'run', 'build'],
        ],
      },
    })
  })

  it('resolves no preparation steps for a local checkout', () => {
    const plan = builtPlan((profile) =>
      profile.source('@scope/plugin', { from: './vendor/acme-bundle' }),
    )
    expect(plan.sources?.['@scope/plugin']?.prepare).toEqual([])
    expect(plan.sources?.['@scope/plugin']?.ref).toBeUndefined()
  })

  it('keeps declared preparation steps in order', () => {
    const plan = builtPlan((profile) =>
      profile.source('@scope/plugin', {
        from: 'git@example.test:acme/bundle.git',
        prepare: [
          ['pnpm', 'install', '--frozen-lockfile'],
          ['node', 'build.js'],
        ],
      }),
    )
    expect(plan.sources?.['@scope/plugin']?.prepare).toEqual([
      ['pnpm', 'install', '--frozen-lockfile'],
      ['node', 'build.js'],
    ])
  })

  it('records only the authored intent without a derived path or commit', () => {
    const plan = builtPlan((profile) => profile.source('@scope/plugin', gitSource))
    const record = plan.sources?.['@scope/plugin']
    expect(record === undefined ? [] : Object.keys(record).sort()).toEqual([
      'from',
      'prepare',
      'ref',
    ])
  })

  it('keeps the built plan valid', () => {
    const plan = builtPlan((profile) =>
      profile
        .bundle('@deepseek-ai/dsh-base')
        .source('@scope/plugin', { from: 'file:///home/me/src/acme-bundle' }),
    )
    expect(Result.isSuccess(validatePlan(plan))).toBe(true)
  })

  it('rejects a ref on a local checkout and names the field', () => {
    let caught: unknown
    try {
      defineConfig().profile('work', (profile) =>
        profile.source('@scope/plugin', { from: './vendor/acme-bundle', ref: 'main' }),
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SourceDeclarationError)
    if (caught instanceof SourceDeclarationError) {
      expect(caught.code).toBe('source.ref_on_local_checkout')
      expect(caught.packageName).toBe('@scope/plugin')
      expect(caught.message).toContain('ref')
      expect(caught.message).toContain('@scope/plugin')
    }
  })

  it('accepts a ref on a file URL because it names a git source', () => {
    const plan = builtPlan((profile) =>
      profile.source('@scope/plugin', { from: 'file:///home/me/src/acme-bundle', ref: 'main' }),
    )
    expect(plan.sources?.['@scope/plugin']?.ref).toBe('main')
  })

  it('rejects one name declared as both a package and a source in either order', () => {
    const orders = [
      (profile: ProfileBuilder) =>
        profile.source('@scope/plugin', gitSource).package('@scope/plugin', '1.0.0'),
      (profile: ProfileBuilder) =>
        profile.package('@scope/plugin', '1.0.0').source('@scope/plugin', gitSource),
    ]
    for (const declare of orders) {
      expect(() => defineConfig().profile('work', declare)).toThrowError(SourceDeclarationError)
    }
  })

  it('names the package in the package and source conflict', () => {
    let caught: unknown
    try {
      defineConfig().profile('work', (profile) =>
        profile.package('@scope/plugin', '1.0.0').source('@scope/plugin', gitSource),
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SourceDeclarationError)
    if (caught instanceof SourceDeclarationError) {
      expect(caught.code).toBe('source.duplicate_package')
      expect(caught.packageName).toBe('@scope/plugin')
      expect(caught.message).toContain('@scope/plugin')
    }
  })
})
