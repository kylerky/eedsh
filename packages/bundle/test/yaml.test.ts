import { describe, expect, it } from 'vitest'
import {
  BUNDLE_PATCH_HEADER,
  emitBundlePatch,
  emitPatchesYaml,
  loadPatchesYaml,
  validateBundlePatch,
} from '../src/index'

const patch = [
  {
    insert: [
      { id: 'plugin', name: 'plugin' },
      {
        id: 'group',
        name: 'cordis:group',
        group: true,
        isolate: { label: true },
        config: [{ id: 'child', name: 'child', disabled: { $eedsh: { expr: 'flag' } } }],
      },
    ],
  },
  { id: 'target', config: { value: { $eedsh: { expr: "ctx.get('x')" } } } },
]

describe('bundle patch YAML', () => {
  it('emits DSH !!js scalars without eedsh expression nodes', () => {
    const text = emitPatchesYaml(patch)
    expect(text).toContain('!!js')
    expect(text).not.toContain('$eedsh')
    expect(loadPatchesYaml(text)).toEqual([
      {
        insert: [
          { id: 'plugin', name: 'plugin' },
          {
            id: 'group',
            name: 'cordis:group',
            group: true,
            isolate: { label: true },
            config: [{ id: 'child', name: 'child', disabled: { __jsExpr: 'flag' } }],
          },
        ],
      },
      { id: 'target', config: { value: { __jsExpr: "ctx.get('x')" } } },
    ])
  })

  it('is deterministic and ends with one newline', () => {
    const first = emitBundlePatch(patch)
    const second = emitBundlePatch(patch)
    expect(first).toBe(second)
    expect(first.startsWith(BUNDLE_PATCH_HEADER)).toBe(true)
    expect(first.endsWith('\n')).toBe(true)
  })

  it('rejects a non-array YAML document', () => {
    expect(() => loadPatchesYaml('id: plugin\n')).toThrow(/top-level YAML array/)
  })

  it('validates the patch before emission', () => {
    expect(() => validateBundlePatch([{ insert: [{}] }])).toThrow(/inserted entry needs/)
    expect(() => emitPatchesYaml([{ insert: [{}] }])).toThrow(/inserted entry needs/)
  })
})
