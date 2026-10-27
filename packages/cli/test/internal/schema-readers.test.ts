import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  readLockfileEntry,
  readOptionalString,
  readRecord,
  readStringArray,
  readStringRecord,
  readVersion,
} from '../../src/internal/schema-readers'

describe('readStringArray', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not-an-array'],
    ['a number', 42],
    ['a boolean', true],
    ['an object', { 0: 'a' }],
  ])('falls back to an empty array for %s', (_label, value) => {
    expect(readStringArray(value)).toEqual([])
  })

  it('keeps every string and drops invalid siblings', () => {
    expect(readStringArray(['a', 1, null, undefined, '', { value: 'b' }, 'b'])).toEqual([
      'a',
      '',
      'b',
    ])
  })

  it('returns a new array without mutating the input', () => {
    const input = ['a', 'b']
    const result = readStringArray(input)
    expect(result).toEqual(['a', 'b'])
    expect(result).not.toBe(input)
  })
})

describe('readStringRecord', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not-a-record'],
    ['an array', ['a']],
    ['a number', 7],
  ])('falls back to an empty record for %s', (_label, value) => {
    expect(readStringRecord(value)).toEqual({})
  })

  it('keeps string values and drops invalid siblings', () => {
    expect(readStringRecord({ good: '1.0.0', bad: 1, nil: null, empty: '', other: {} })).toEqual({
      good: '1.0.0',
      empty: '',
    })
  })

  it('accepts an empty record', () => {
    expect(readStringRecord({})).toEqual({})
  })

  it('keeps a missing key absent and drops a wrong value', () => {
    expect(readStringRecord({ good: '1.0.0' })).toEqual({ good: '1.0.0' })
    expect(readStringRecord({ good: 1 })).toEqual({})
  })

  it('returns a new record without mutating the input', () => {
    const input = { a: '1.0.0' }
    const result = readStringRecord(input)
    expect(result).toEqual({ a: '1.0.0' })
    expect(result).not.toBe(input)
  })
})

describe('readRecord', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not-a-record'],
    ['an array', ['a']],
    ['a number', 7],
  ])('falls back to an empty record for %s', (_label, value) => {
    expect(readRecord(value)).toEqual({})
  })

  it('keeps arbitrary values without narrowing them', () => {
    const value = { text: 'a', count: 1, nested: { enabled: true }, list: [1, null] }
    expect(readRecord(value)).toEqual(value)
  })

  it('accepts an empty record', () => {
    expect(readRecord({})).toEqual({})
  })

  it('falls back safely for a missing value and a malformed container', () => {
    expect(readRecord(undefined)).toEqual({})
    expect(readRecord('not-a-record')).toEqual({})
  })
})

describe('readOptionalString', () => {
  it('returns a present string, including an empty one', () => {
    expect(readOptionalString('1.2.3')).toEqual(Option.some('1.2.3'))
    expect(readOptionalString('')).toEqual(Option.some(''))
  })

  it.each([
    ['undefined (missing)', undefined],
    ['null', null],
    ['a number', 42],
    ['an array', ['a']],
    ['an object', { value: 'a' }],
  ])('returns none for %s', (_label, value) => {
    expect(readOptionalString(value)).toEqual(Option.none())
  })
})

describe('readVersion', () => {
  it('returns a present version, including an empty one', () => {
    expect(readVersion('1.2.3')).toEqual(Option.some('1.2.3'))
    expect(readVersion('')).toEqual(Option.some(''))
  })

  it.each([
    ['undefined (missing)', undefined],
    ['null', null],
    ['a number', 1],
    ['a boolean', false],
    ['an object', { version: '1.2.3' }],
    ['an array', ['1.2.3']],
  ])('returns none for %s', (_label, value) => {
    expect(readVersion(value)).toEqual(Option.none())
  })
})

describe('readLockfileEntry', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not-an-entry'],
    ['an array', ['1.0.0']],
    ['a number', 1],
  ])('falls back to an absent entry for %s', (_label, value) => {
    expect(readLockfileEntry(value)).toEqual({ specifier: Option.none(), version: Option.none() })
  })

  it('reads both optional fields and ignores extra fields', () => {
    expect(
      readLockfileEntry({ specifier: '^1.0.0', version: '1.2.3(peer@2.0.0)', extra: true }),
    ).toEqual({
      specifier: Option.some('^1.0.0'),
      version: Option.some('1.2.3(peer@2.0.0)'),
    })
  })

  it('keeps a valid version when the specifier is malformed', () => {
    expect(readLockfileEntry({ specifier: 42, version: '1.2.3' })).toEqual({
      specifier: Option.none(),
      version: Option.some('1.2.3'),
    })
  })

  it('keeps a valid specifier when the version is malformed', () => {
    expect(readLockfileEntry({ specifier: '^1.0.0', version: null })).toEqual({
      specifier: Option.some('^1.0.0'),
      version: Option.none(),
    })
  })

  it('accepts a partial entry and an empty entry', () => {
    expect(readLockfileEntry({ specifier: '^1.0.0' })).toEqual({
      specifier: Option.some('^1.0.0'),
      version: Option.none(),
    })
    expect(readLockfileEntry({})).toEqual({ specifier: Option.none(), version: Option.none() })
  })
})

describe('tolerant reader boundaries', () => {
  const hostileValues: readonly unknown[] = [
    undefined,
    null,
    '',
    'text',
    0,
    1.5,
    true,
    [],
    [1, null, 'text'],
    {},
    { value: 1 },
    new Date(0),
    Symbol('value'),
    1n,
    () => undefined,
  ]

  it('never throws for malformed values', () => {
    for (const value of hostileValues) {
      expect(() => readStringArray(value)).not.toThrow()
      expect(() => readStringRecord(value)).not.toThrow()
      expect(() => readRecord(value)).not.toThrow()
      expect(() => readOptionalString(value)).not.toThrow()
      expect(() => readVersion(value)).not.toThrow()
      expect(() => readLockfileEntry(value)).not.toThrow()
    }
  })
})
