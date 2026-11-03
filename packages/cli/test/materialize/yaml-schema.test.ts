import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema, isJsExpr } from '../../src/materialize/yaml-schema'

describe('vendored !!js YAML schema', () => {
  it('emits an expression node as a !!js scalar', () => {
    const text = yaml.dump({ disabled: { __jsExpr: "!ctx.get('profileContext')" } }, {
      schema: entryListSchema,
    })
    expect(text).toContain('!!js')
    expect(yaml.load(text, { schema: entryListSchema })).toEqual({
      disabled: { __jsExpr: "!ctx.get('profileContext')" },
    })
  })

  it('parses a !!js scalar back into an expression node', () => {
    const parsed = yaml.load('disabled: !!js "!ctx.get(\'profileContext\')"\n', {
      schema: entryListSchema,
    })
    expect(parsed).toEqual({ disabled: { __jsExpr: "!ctx.get('profileContext')" } })
  })

  it('round-trips a nested patch list', () => {
    const patches = [
      {
        insert: [
          { id: 'row', name: '@scope/plugin', disabled: { __jsExpr: 'flag' } },
        ],
      },
    ]
    const text = yaml.dump(patches, { schema: entryListSchema })
    expect(yaml.load(text, { schema: entryListSchema })).toEqual(patches)
  })

  it('recognizes only values carrying the expression key', () => {
    expect(isJsExpr({ __jsExpr: 'x' })).toBe(true)
    expect(isJsExpr({ expr: 'x' })).toBe(false)
    expect(isJsExpr('__jsExpr')).toBe(false)
    expect(isJsExpr(null)).toBe(false)
  })

  it('keeps the JSON schema for every other value', () => {
    expect(yaml.load('a: 1\nb: [true, null]\n', { schema: entryListSchema })).toEqual({
      a: 1,
      b: [true, null],
    })
  })
})
