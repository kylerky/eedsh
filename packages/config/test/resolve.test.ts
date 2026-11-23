import { AuthoringDefect, bundle, defineConfig, type ResolutionTable } from '@eedsh/config'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { BASE_ROWS, CUSTOM_ROWS, resolutionTable, resolvedBundle } from './support/table'

function planOf(built: ReturnType<ReturnType<typeof defineConfig>['build']>) {
  if (Result.isFailure(built)) throw built.failure
  const plan = built.success.profiles.work
  if (plan === undefined || Result.isFailure(plan)) throw plan?.failure
  return plan.success
}

describe('query roots are recorded, not resolved', () => {
  it('records the selected root for a profile query', () => {
    const builder = defineConfig().profile('work', (profile) => {
      profile
        .generated()
        .layer((layer) => layer.insert(bundle('@fixture/custom').fromProfile('work').rows()))
    })
    expect(builder.queries()).toEqual([
      {
        bundle: '@fixture/custom',
        root: { profile: 'work' },
        rows: true,
      },
    ])
  })

  it('records a relative package directory as written', () => {
    const builder = defineConfig().profile('work', (profile) => {
      profile
        .generated()
        .layer((layer) =>
          layer.insert(
            bundle('@fixture/vendored')
              .fromPackageDir('../node_modules/@fixture/vendored')
              .row('vendored-row'),
          ),
        )
    })
    expect(builder.queries()[0]).toEqual({
      bundle: '@fixture/vendored',
      root: { packageDir: '../node_modules/@fixture/vendored' },
      row: 'vendored-row',
    })
  })

  it('keeps the invocation installation as the default root', () => {
    const builder = defineConfig().profile('work', (profile) => {
      profile.generated().layer((layer) => layer.insert(bundle('@fixture/base').preset('standard')))
    })
    expect(builder.queries()).toEqual([{ bundle: '@fixture/base', root: {}, preset: 'standard' }])
  })
})

describe('build over the invocation resolution', () => {
  it('resolves a profile-rooted row from its own table entry', () => {
    const built = defineConfig()
      .profile('work', (profile) => {
        profile
          .generated()
          .layer((layer) =>
            layer.insert(bundle('@fixture/custom').fromProfile('work').row('custom-row')),
          )
      })
      .build(
        resolutionTable(
          resolvedBundle('@fixture/custom', CUSTOM_ROWS, {
            root: { profile: 'work' },
            origin: 'profile',
            profile: 'work',
          }),
        ),
      )
    const patch = planOf(built).layers[0]?.patches[0] as
      | { insert?: readonly Record<string, unknown>[] }
      | undefined
    expect(patch?.insert?.map((row) => row.id)).toEqual(['custom-row'])
  })

  it('does not fall back to another root when the table lacks the descriptor root', () => {
    const table: ResolutionTable = resolutionTable(
      resolvedBundle('@fixture/custom', CUSTOM_ROWS, { root: {}, origin: 'active' }),
    )
    expect(() =>
      defineConfig()
        .profile('work', (profile) => {
          profile
            .generated()
            .layer((layer) =>
              layer.insert(bundle('@fixture/custom').fromProfile('work').row('custom-row')),
            )
        })
        .build(table),
    ).toThrowError(AuthoringDefect)
  })

  it('expands every collection entry in authored order', () => {
    const built = defineConfig()
      .profile('work', (profile) => {
        profile.generated().layer((layer) => layer.insert(bundle('@fixture/base').rows()))
      })
      .build(resolutionTable(resolvedBundle('@fixture/base', BASE_ROWS)))
    const patch = planOf(built).layers[0]?.patches[0] as
      | { insert?: readonly Record<string, unknown>[] }
      | undefined
    expect(patch?.insert?.map((row) => row.id)).toEqual(['preset-standard', 'timer'])
  })

  it('returns the native schema failure without throwing on invalid config data', () => {
    const built = defineConfig()
      .profile('a/b', (profile) => profile.bundle('@deepseek-ai/dsh-base'))
      .build()
    expect(Result.isFailure(built)).toBe(true)
    expect(() => defineConfig().build()).not.toThrow()
  })
})
