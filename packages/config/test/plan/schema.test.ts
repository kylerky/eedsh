import {
  canonicalJson,
  hashPlan,
  PLAN_FORMAT,
  PLAN_VERSION,
  type ProfilePlan,
  ProfilePlanSchema,
} from '@eedsh/config'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import { describe, expect, it } from 'vitest'

const bundle = (name: string) => ({ kind: 'bundle', name })
const layer = (id: string, patches: unknown[] = []) => ({ id, patches })

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    profile: { name: 'work' },
    dsh: '0.2.1-rc.2',
    bundles: [bundle('@deepseek-ai/dsh-base')],
    layers: [],
    packages: {},
    ...overrides,
  }
}

/** The strict plan entry point: every issue, excess properties rejected. */
const decode = Schema.decodeUnknownResult(ProfilePlanSchema, {
  errors: 'all',
  onExcessProperty: 'error',
})

/** One located issue, flattened to a plain path and message. */
interface FlatIssue {
  readonly path: ReadonlyArray<PropertyKey>
  readonly message: string
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

function issuesOf(value: unknown): ReadonlyArray<FlatIssue> {
  const result = decode(value)
  if (Result.isSuccess(result)) throw new Error('expected decoding to fail')
  return formatIssues(result.failure.issue).issues.map((issue) => ({
    path: (issue.path ?? []).map((segment) =>
      typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment,
    ),
    message: issue.message,
  }))
}

function pathsOf(value: unknown): ReadonlyArray<ReadonlyArray<PropertyKey>> {
  return issuesOf(value).map((issue) => issue.path)
}

describe('plan schema decoding', () => {
  it('decodes a minimal valid plan', () => {
    const result = decode(plan())
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    const value = result.success
    expect(value.format).toBe(PLAN_FORMAT)
    expect(value.version).toBe(PLAN_VERSION)
    expect(value.profile).toEqual({ name: 'work' })
    expect(value.dsh).toBe('0.2.1-rc.2')
    expect(value.bundles).toEqual([bundle('@deepseek-ai/dsh-base')])
    expect(value.layers).toEqual([])
    expect(value.packages).toEqual({})
  })

  it('decodes nested bundles, layers, patches, and packages', () => {
    const result = decode(
      plan({
        bundles: [bundle('@deepseek-ai/dsh-base'), { kind: 'generated' }, bundle('@scope/extra')],
        layers: [
          layer('base', [
            { insert: [{ id: 'timer', name: '@scope/timer' }] },
            { id: 'agent-default-model', config: { provider: 'deepseek' } },
          ]),
        ],
        packages: { '@scope/plugin': 'link:../plugin' },
      }),
    )
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    expect(result.success.layers[0]?.id).toBe('base')
    expect(result.success.layers[0]?.patches).toHaveLength(2)
    expect(result.success.packages).toEqual({ '@scope/plugin': 'link:../plugin' })
  })

  it('rejects unknown fields through decodePlan and strips them through the raw schema', () => {
    const value = plan({ extra: true })
    expect(Result.isFailure(decode(value))).toBe(true)
    const lenient = Schema.decodeUnknownResult(ProfilePlanSchema)(value)
    expect(Result.isSuccess(lenient)).toBe(true)
    if (Result.isSuccess(lenient)) expect('extra' in lenient.success).toBe(false)
  })

  it('rejects wrong field types and identifies the field', () => {
    const cases: ReadonlyArray<[Record<string, unknown>, ReadonlyArray<PropertyKey>]> = [
      [{ version: '1' }, ['version']],
      [{ dsh: 1 }, ['dsh']],
      [{ layers: {} }, ['layers']],
      [{ profile: { name: 42 } }, ['profile', 'name']],
      [{ bundles: [{ kind: 'bundle', name: 'x', source: 3 }] }, ['bundles', 0, 'source']],
      [{ packages: { '@scope/plugin': 1 } }, ['packages', '@scope/plugin']],
    ]
    for (const [overrides, path] of cases) {
      const issues = issuesOf(plan(overrides))
      expect(issues.length).toBeGreaterThan(0)
      expect(issues.map((issue) => issue.path)).toContainEqual(path)
      expect(issues.every((issue) => issue.message.length > 0)).toBe(true)
    }
  })

  it('rejects unknown plan fields at every level', () => {
    const cases: ReadonlyArray<[Record<string, unknown>, ReadonlyArray<PropertyKey>]> = [
      [{ extra: true }, ['extra']],
      [{ profile: { name: 'work', extra: true } }, ['profile', 'extra']],
      [{ bundles: [{ kind: 'bundle', name: 'x', extra: true }] }, ['bundles', 0, 'extra']],
      [{ layers: [{ id: 'base', patches: [], extra: true }] }, ['layers', 0, 'extra']],
    ]
    for (const [overrides, path] of cases) {
      const issues = issuesOf(plan(overrides))
      expect(pathsOf(plan(overrides))).toContainEqual(path)
      expect(issues.some((issue) => issue.message === 'Expected no excess property')).toBe(true)
    }
  })

  it('rejects missing required fields with their location', () => {
    const withoutDsh = plan()
    delete withoutDsh.dsh
    const withoutBundles = plan()
    delete withoutBundles.bundles
    const cases: ReadonlyArray<[Record<string, unknown>, ReadonlyArray<PropertyKey>]> = [
      [withoutDsh, ['dsh']],
      [withoutBundles, ['bundles']],
      [{ profile: {} }, ['profile', 'name']],
      [{ layers: [{ patches: [] }] }, ['layers', 0, 'id']],
    ]
    for (const [value, path] of cases) {
      const issues = issuesOf(value)
      expect(issues.map((issue) => issue.path)).toContainEqual(path)
      expect(issues.some((issue) => issue.message === 'Missing key' || issue.message.startsWith('Expected'))).toBe(true)
    }
  })
})

function expectRejected(value: unknown, path: ReadonlyArray<PropertyKey>, message?: RegExp): void {
  const issues = issuesOf(value)
  expect(issues.map((issue) => issue.path)).toContainEqual(path)
  expect(issues.every((issue) => issue.message.length > 0)).toBe(true)
  if (message !== undefined) {
    expect(issues.some((issue) => message.test(issue.message))).toBe(true)
  }
}

describe('plan policy', () => {
  it('accepts safe profile names and rejects unsafe ones', () => {
    for (const name of ['work', 'team-work']) {
      expect(Result.isSuccess(decode(plan({ profile: { name } })))).toBe(true)
    }
    for (const name of [' work', 'work ', '.', '..', 'node_modules', 'a/b', 'a\\b']) {
      expectRejected(plan({ profile: { name } }), ['profile', 'name'])
    }
  })

  it('requires an exact DSH pin', () => {
    for (const dsh of ['0.2.1-rc.2', '1.0.0', '0.2.1-beta.1']) {
      expect(Result.isSuccess(decode(plan({ dsh })))).toBe(true)
    }
    for (const dsh of ['latest', '^0.2.1', '0.2', 'v0.2.1', '0.2.1 ']) {
      expectRejected(plan({ dsh }), ['dsh'], /exact version/)
    }
  })

  it('rejects empty, unsafe, and duplicate layer ids', () => {
    for (const id of ['base', 'plugins-2']) {
      expect(Result.isSuccess(decode(plan({ layers: [layer(id)] })))).toBe(true)
    }
    for (const id of ['', ' ', '../escape', 'Base', 'base--x', '-base', 'base-']) {
      expectRejected(plan({ layers: [layer(id)] }), ['layers', 0, 'id'])
    }
    const issues = issuesOf(plan({ layers: [layer('base'), layer('base')] }))
    expect(issues.map((issue) => issue.path)).toContainEqual(['layers', 1, 'id'])
    expect(issues.some((issue) => issue.message.includes('layers[0].id'))).toBe(true)
  })

  it('rejects duplicate bundle names', () => {
    const issues = issuesOf(plan({ bundles: [bundle('@scope/one'), bundle('@scope/one')] }))
    expect(issues.map((issue) => issue.path)).toContainEqual(['bundles', 1, 'name'])
    expect(issues.some((issue) => issue.message.includes('bundles[0].name'))).toBe(true)
  })

  it('accepts one generated marker and rejects several', () => {
    const withMarker = [bundle('@deepseek-ai/dsh-base'), { kind: 'generated' }]
    expect(Result.isSuccess(decode(plan({ bundles: withMarker })))).toBe(true)
    const issues = issuesOf(plan({ bundles: [{ kind: 'generated' }, { kind: 'generated' }] }))
    expect(issues.map((issue) => issue.path)).toContainEqual(['bundles', 1])
    expect(issues.some((issue) => issue.message.includes('at most one generated marker'))).toBe(
      true,
    )
  })

  it('rejects reserved bundle and package names', () => {
    for (const name of ['@eedsh/runtime', '@eedsh/generated']) {
      expectRejected(
        plan({ bundles: [bundle(name)] }),
        ['bundles', 0, 'name'],
        /owned by the materializer/,
      )
    }
    expectRejected(
      plan({ packages: { '@eedsh/generated': 'link:./generated' } }),
      ['packages', '@eedsh/generated'],
      /owned by the materializer/,
    )
    expectRejected(plan({ packages: { '@eedsh/runtime': '1.0.0' } }), [
      'packages',
      '@eedsh/runtime',
    ])
  })

  it('rejects invalid package specifications', () => {
    expectRejected(plan({ packages: { '@scope/plugin': '' } }), ['packages', '@scope/plugin'])
    expectRejected(plan({ packages: { '  ': '1.0.0' } }), ['packages', '  '])
  })

  it('enforces patch rules', () => {
    const cases: ReadonlyArray<[unknown, ReadonlyArray<PropertyKey>, RegExp]> = [
      [{ insert: {} }, ['layers', 0, 'patches', 0, 'insert'], /insert must be an array/],
      [{ insert: ['not-an-entry'] }, ['layers', 0, 'patches', 0, 'insert', 0], /JSON object/],
      [
        { insert: [{ id: 'row' }] },
        ['layers', 0, 'patches', 0, 'insert', 0],
        /name or group: true/,
      ],
      [{ name: 'row' }, ['layers', 0, 'patches', 0], /needs a non-empty id/],
      [{ id: 'row', name: 42 }, ['layers', 0, 'patches', 0, 'name'], /name must be a string/],
      [{ id: 'row', group: 'yes' }, ['layers', 0, 'patches', 0, 'group'], /boolean or null/],
      [{ id: 'row', disabled: 1 }, ['layers', 0, 'patches', 0, 'disabled'], /boolean or null/],
    ]
    for (const [patch, path, message] of cases) {
      expectRejected(plan({ layers: [layer('base', [patch])] }), path, message)
    }
  })

  it('accepts valid inserts, group entries, and disable patches', () => {
    const value = plan({
      layers: [
        layer('base', [
          { insert: [{ id: 'row', name: '@scope/plugin', config: { enabled: true } }] },
          { insert: [{ id: 'group-row', group: true, config: [] }] },
          { id: 'row', disabled: true },
          { id: 'row', disabled: null },
          { id: 'row', config: { enabled: false } },
        ]),
      ],
    })
    const result = decode(value)
    expect(Result.isSuccess(result)).toBe(true)
  })
})

class CustomValue {
  readonly kind = 'custom'
}

const patchInLayer = (patch: unknown) => plan({ layers: [layer('base', [patch])] })

describe('JSON compatibility and expression nodes', () => {
  it('rejects non-JSON values and names their location', () => {
    const cases: ReadonlyArray<[unknown, PropertyKey, RegExp]> = [
      [{ fn: () => 1 }, 'fn', /unsupported function/],
      [{ token: Symbol('x') }, 'token', /unsupported symbol/],
      [{ big: 1n }, 'big', /unsupported bigint/],
      [{ missing: undefined }, 'missing', /unsupported undefined/],
      [{ ratio: Number.POSITIVE_INFINITY }, 'ratio', /unsupported number/],
      [{ ratio: Number.NaN }, 'ratio', /unsupported number/],
      [{ custom: new CustomValue() }, 'custom', /unsupported object of type CustomValue/],
    ]
    for (const [value, key, message] of cases) {
      expectRejected(
        patchInLayer({ id: 'timer', config: value }),
        ['layers', 0, 'patches', 0, 'config', key],
        message,
      )
    }
  })

  it('rejects a non-JSON value outside plugin config', () => {
    expectRejected(
      patchInLayer({ id: 'timer', extra: () => 1 }),
      ['layers', 0, 'patches', 0, 'extra'],
      /unsupported function/,
    )
  })

  it('rejects a circular reference at the repeated location', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expectRejected(
      patchInLayer({ id: 'timer', config: circular }),
      ['layers', 0, 'patches', 0, 'config', 'self'],
      /circular reference/,
    )
  })

  it('rejects malformed expression nodes at the expression location', () => {
    for (const value of [
      { $eedsh: { expr: 42 } },
      { $eedsh: { expr: 'ok', extra: true } },
      { $eedsh: 'not-an-expression' },
      { $eedsh: { expr: 'ok' }, sibling: true },
    ]) {
      expectRejected(
        patchInLayer({ id: 'timer', config: { expression: value } }),
        ['layers', 0, 'patches', 0, 'config', 'expression'],
        /expected exactly/,
      )
    }
  })

  it('accepts JSON values and well-formed expression nodes', () => {
    const result = decode(
      patchInLayer({
        id: 'timer',
        config: {
          nested: { deep: [1, 2, { ok: true, none: null }] },
          expression: { $eedsh: { expr: "!ctx.get('profileContext')" } },
        },
      }),
    )
    expect(Result.isSuccess(result)).toBe(true)
  })
  it('rejects class instances at plan positions', () => {
    class BundleValue {
      readonly kind = 'bundle'
      readonly name = '@scope/bundle'
    }
    class LayerValue {
      readonly id = 'base'
      readonly patches: unknown[] = []
    }
    class PatchValue {
      readonly id = 'row'
    }
    class ProfileValue {
      readonly name = 'work'
    }
    expectRejected(plan({ bundles: [new BundleValue()] }), ['bundles', 0], /JSON object/)
    expectRejected(plan({ layers: [new LayerValue()] }), ['layers', 0], /JSON object/)
    expectRejected(
      plan({ layers: [layer('base', [new PatchValue()])] }),
      ['layers', 0, 'patches', 0],
      /JSON object/,
    )
    expectRejected(plan({ profile: new ProfileValue() }), ['profile'], /JSON object/)
    expectRejected(new ProfileValue(), [], /plan must be a JSON object/)
  })
})

describe('canonical plan hashing', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it('is stable across key insertion order and changes with content', () => {
    const left = decodeOrThrow(plan({ packages: { alpha: '1.0.0', beta: '2.0.0' } }))
    const right = decodeOrThrow(plan({ packages: { beta: '2.0.0', alpha: '1.0.0' } }))
    expect(hashPlan(left)).toBe(hashPlan(right))
    const changed = decodeOrThrow(plan({ dsh: '0.2.2-rc.1' }))
    expect(hashPlan(changed)).not.toBe(hashPlan(left))
  })

  it('produces a 64-character hex digest', () => {
    expect(hashPlan(decodeOrThrow(plan()))).toMatch(/^[0-9a-f]{64}$/)
  })
})

function decodeOrThrow(value: unknown): ProfilePlan {
  return Result.getOrThrow(decode(value))
}

describe('profile plan typing', () => {
  it('exposes the derived plan shape through the public type', () => {
    const value: ProfilePlan['profile'] = { name: 'work' }
    expect(value.name).toBe('work')
  })
})
