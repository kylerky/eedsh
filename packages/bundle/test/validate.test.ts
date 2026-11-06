import { describe, expect, it } from 'vitest'
import { BundlePatchError, validateBundlePatch } from '../src/index'

describe('bundle patch validation', () => {
  it('accepts inserted rows, groups, expressions, and unmatched targets', () => {
    expect(() =>
      validateBundlePatch([
        { insert: [{ id: 'row', name: 'row' }] },
        { insert: [{ id: 'group', name: 'cordis:group', group: true }] },
        { id: 'missing-target', disabled: true },
        { id: 'expression', config: { value: { $eedsh: { expr: 'flag' } } } },
      ]),
    ).not.toThrow()
  })

  it('rejects a non-array patch list', () => {
    expect(() => validateBundlePatch({ insert: [] })).toThrow(BundlePatchError)
    expect(() => validateBundlePatch({ insert: [] })).toThrow(/top-level array/)
  })

  it('rejects an inserted entry without a name or group flag', () => {
    expect(() => validateBundlePatch([{ insert: [{}] }])).toThrow(/inserted entry needs/)
    expect(() => validateBundlePatch([{ insert: [{ disabled: true }] }])).toThrow(
      /inserted entry needs/,
    )
  })

  it('rejects a targeted patch without an id', () => {
    expect(() => validateBundlePatch([{ disabled: true }])).toThrow(/non-empty id/)
    expect(() => validateBundlePatch([{ id: '  ', disabled: true }])).toThrow(/non-empty id/)
  })

  it('rejects invalid names, group flags, and disabled values', () => {
    expect(() => validateBundlePatch([{ insert: [{ name: 1 }] }])).toThrow(/name must be/)
    expect(() => validateBundlePatch([{ insert: [{ name: 'x', group: 'yes' }] }])).toThrow(
      /group must be/,
    )
    expect(() => validateBundlePatch([{ id: 'x', disabled: 1 }])).toThrow(/disabled must be/)
  })

  it('rejects non-JSON values and malformed expression nodes', () => {
    expect(() => validateBundlePatch([{ id: 'x', config: { fn: () => 1 } }])).toThrow(
      /unsupported function/,
    )
    expect(() => validateBundlePatch([{ id: 'x', config: { value: undefined } }])).toThrow(
      /unsupported undefined/,
    )
    expect(() => validateBundlePatch([{ id: 'x', config: { $eedsh: { expr: 1 } } }])).toThrow(
      /\$eedsh/,
    )
    expect(() =>
      validateBundlePatch([{ id: 'x', config: { $eedsh: { expr: 'x' }, extra: 1 } }]),
    ).toThrow(/\$eedsh/)
  })

  it('rejects circular config objects', () => {
    const config: Record<string, unknown> = {}
    config.self = config
    expect(() => validateBundlePatch([{ id: 'x', config }])).toThrow(/circular reference/)
  })

  it('reports the location of each issue', () => {
    try {
      validateBundlePatch([{ insert: [{ id: 'x' }] }])
      throw new Error('expected validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(BundlePatchError)
      const bundleError = error as BundlePatchError
      expect(bundleError.issues[0]?.path).toEqual([0, 'insert', 0])
    }
  })
})
