import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  GENERATED_PACKAGE_NAME,
  GENERATION_FORMAT,
  GENERATION_VERSION,
  type GenerationLayer,
  GenerationLayerSchema,
  GenerationManifestSchema,
  GenerationRecordSchema,
} from '../../src/materialize/generated-bundle'
import {
  classifyGenerationRecord,
  lookupGenerationRecord,
  missingGenerationRecord,
} from '../../src/materialize/generation-record'
import { memoryFileSystem } from '../support/fakes'

const RECORD_PATH = '/home/profiles/work/.eedsh/generated/package.json'
const BUNDLE = '@deepseek-ai/dsh-base'

function layerList(): GenerationLayer[] {
  return [{ id: 'cli', file: `patches/${'c'.repeat(64)}/cli.yml`, hash: 'b'.repeat(64) }]
}

function generatedManifest(record: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: GENERATED_PACKAGE_NAME,
    version: '0.0.0',
    private: true,
    eedsh: {
      format: GENERATION_FORMAT,
      version: GENERATION_VERSION,
      generationId: 'c'.repeat(64),
      planHash: 'a'.repeat(64),
      eedshVersion: '0.0.0',
      dshVersion: '0.2.1-rc.2',
      layers: layerList(),
      bundles: [BUNDLE, '@eedsh/runtime', '@eedsh/generated'],
      packages: {
        '@scope/plugin': '1.0.0',
        '@eedsh/runtime': 'link:/repo/runtime',
        '@eedsh/generated': 'link:./.eedsh/generated',
      },
      ...record,
    },
  }
}

function lookup(files: Record<string, string> = {}) {
  const fs = memoryFileSystem(files)
  return Effect.runPromise(lookupGenerationRecord(RECORD_PATH, fs.fs))
}

describe('generation record lookup', () => {
  it('reports a missing record when the generated manifest does not exist', async () => {
    expect(await lookup()).toEqual({ _tag: 'missing' })
  })

  it('reports an unparseable record without failing the effect', async () => {
    const result = await lookup({ [RECORD_PATH]: '{ not json' })
    expect(result).toEqual({
      _tag: 'invalid',
      path: RECORD_PATH,
      reason: 'unparseable',
      adoptable: true,
      detail: expect.any(String),
    })
  })

  it('rejects a generated manifest written by another tool', () => {
    const result = classifyGenerationRecord(
      { ...generatedManifest(), name: '@someone/else' },
      RECORD_PATH,
    )
    expect(result).toMatchObject({
      _tag: 'invalid',
      path: RECORD_PATH,
      reason: 'name',
      adoptable: true,
    })
  })

  it('rejects a foreign generation format', () => {
    const result = classifyGenerationRecord(
      generatedManifest({ format: 'other/format' }),
      RECORD_PATH,
    )
    expect(result).toMatchObject({ _tag: 'invalid', reason: 'format', adoptable: true })
  })

  it('refuses a newer record version with an upgrade instruction', () => {
    const result = classifyGenerationRecord(
      generatedManifest({ version: GENERATION_VERSION + 1 }),
      RECORD_PATH,
    )
    expect(result).toMatchObject({ _tag: 'invalid', reason: 'version', adoptable: false })
    if (result._tag !== 'invalid') expect.unreachable('expected an invalid record')
    expect(result.detail).toContain('upgrade eedsh')
  })

  it.each([
    ['bundles', { bundles: [] }],
    ['packages', { packages: {} }],
    ['generation id', { generationId: '' }],
    ['plan hash', { planHash: 'not-a-hash' }],
    ['layers', { layers: 'nope' }],
  ])('rejects a record with invalid %s', (label, overrides) => {
    const result = classifyGenerationRecord(generatedManifest(overrides), RECORD_PATH)
    expect(result._tag).toBe('invalid')
    if (result._tag !== 'invalid') expect.unreachable('expected an invalid record')
    expect(result.reason).not.toBe('unparseable')
    expect(label.length).toBeGreaterThan(0)
  })

  it('rejects a record that drops the runtime or generated bundle', () => {
    const result = classifyGenerationRecord(
      generatedManifest({ bundles: [BUNDLE, '@eedsh/runtime'] }),
      RECORD_PATH,
    )
    expect(result).toMatchObject({ _tag: 'invalid', reason: 'bundles', adoptable: true })
  })

  it('rejects a JSON document that is not an object', () => {
    const result = classifyGenerationRecord([], RECORD_PATH)
    expect(result).toMatchObject({ _tag: 'invalid', reason: 'unparseable', adoptable: true })
  })

  it('accepts a complete record and exposes its managed sets', () => {
    const result = classifyGenerationRecord(generatedManifest(), RECORD_PATH)
    if (result._tag !== 'valid') expect.unreachable('expected a valid record')
    expect(result.record.generationId).toBe('c'.repeat(64))
    expect(result.record.planHash).toBe('a'.repeat(64))
    expect(result.record.bundles).toEqual([BUNDLE, '@eedsh/runtime', '@eedsh/generated'])
    expect(result.previous).toEqual({
      bundles: [BUNDLE, '@eedsh/runtime', '@eedsh/generated'],
      packages: {
        '@scope/plugin': '1.0.0',
        '@eedsh/runtime': 'link:/repo/runtime',
        '@eedsh/generated': 'link:./.eedsh/generated',
      },
    })
  })
})
function generationRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: GENERATION_FORMAT,
    version: GENERATION_VERSION,
    generationId: 'c'.repeat(64),
    planHash: 'a'.repeat(64),
    eedshVersion: '0.0.0',
    dshVersion: '0.2.1-rc.2',
    layers: layerList(),
    bundles: [BUNDLE, '@eedsh/runtime', '@eedsh/generated'],
    packages: {
      '@scope/plugin': '1.0.0',
      '@eedsh/runtime': 'link:/repo/runtime',
      '@eedsh/generated': 'link:./.eedsh/generated',
    },
    ...overrides,
  }
}

function decodeFailure(schema: Parameters<typeof Schema.decodeUnknownResult>[0], value: unknown) {
  return Schema.decodeUnknownResult(schema)(value)._tag === 'Failure'
}

describe('generation schema contract', () => {
  it('decodes a complete generation record unchanged', () => {
    const record = generationRecord()
    expect(Schema.decodeUnknownSync(GenerationRecordSchema)(record)).toEqual(record)
  })

  it('decodes a complete layer unchanged', () => {
    const layer = layerList()[0]
    expect(Schema.decodeUnknownSync(GenerationLayerSchema)(layer)).toEqual(layer)
  })

  it('ignores extra manifest and metadata fields', () => {
    const record = generationRecord()
    const decoded = Schema.decodeUnknownSync(GenerationManifestSchema)({
      ...generatedManifest(),
      version: '9.9.9',
      extra: 'ignored',
      eedsh: { ...record, extra: 'ignored' },
    })
    expect(decoded).toEqual({ name: GENERATED_PACKAGE_NAME, eedsh: record })
  })

  it.each([
    ['a non-object root', []],
    ['a missing manifest name', { eedsh: generationRecord() }],
    ['a missing record', { name: GENERATED_PACKAGE_NAME }],
    ['a non-object record', { name: GENERATED_PACKAGE_NAME, eedsh: [] }],
  ])('rejects %s', (_label, value) => {
    expect(decodeFailure(GenerationManifestSchema, value)).toBe(true)
  })

  it.each([
    ['an empty layer id', generationRecord({ layers: [{ ...layerList()[0], id: '' }] })],
    ['a scalar layer', generationRecord({ layers: ['nope'] })],
    ['a missing layer field', generationRecord({ layers: [{ id: 'cli', file: 'cli.yml' }] })],
    ['an empty bundle list', generationRecord({ bundles: [] })],
    ['an empty bundle name', generationRecord({ bundles: [BUNDLE, ''] })],
    [
      'a bundle list missing the runtime',
      generationRecord({ bundles: [BUNDLE, '@eedsh/generated'] }),
    ],
    ['an empty package map', generationRecord({ packages: {} })],
    ['an empty package key', generationRecord({ packages: { '': '1.0.0' } })],
    ['an empty package specification', generationRecord({ packages: { '@scope/plugin': '' } })],
    ['a non-string package specification', generationRecord({ packages: { '@scope/plugin': 1 } })],
    ['an empty generation id', generationRecord({ generationId: '' })],
    ['a malformed plan hash', generationRecord({ planHash: 'not-a-hash' })],
    ['a string record version', generationRecord({ version: '1' })],
  ])('rejects %s', (_label, value) => {
    expect(decodeFailure(GenerationRecordSchema, value)).toBe(true)
  })
})
describe('generation reader parity matrix', () => {
  const cases: [string, unknown, string, boolean, string][] = [
    ['a non-object root', 'not-a-record', 'unparseable', true, 'the document is not a JSON object'],
    [
      'another package name',
      { ...generatedManifest(), name: '@someone/else' },
      'name',
      true,
      'the generated package is named @someone/else instead of "@eedsh/generated"',
    ],
    [
      'a missing generation record',
      { name: GENERATED_PACKAGE_NAME },
      'format',
      true,
      'the manifest has no eedsh generation record',
    ],
    [
      'a foreign generation format',
      generatedManifest({ format: 'other/format' }),
      'format',
      true,
      'the generation format is other/format instead of "eedsh/generation"',
    ],
    [
      'missing package provenance versions',
      generatedManifest({ eedshVersion: undefined }),
      'format',
      true,
      'the record is missing its eedsh or dsh version',
    ],
    [
      'a missing dsh version',
      generatedManifest({ dshVersion: undefined }),
      'format',
      true,
      'the record is missing its eedsh or dsh version',
    ],
    [
      'a string record version',
      generatedManifest({ version: '2' }),
      'version',
      true,
      'record format version 2 is not the supported version 1',
    ],
    [
      'a fractional record version',
      generatedManifest({ version: 1.5 }),
      'version',
      false,
      'record format version 1.5 is newer than the supported version 1; upgrade eedsh',
    ],
    [
      'a newer record version',
      generatedManifest({ version: GENERATION_VERSION + 1 }),
      'version',
      false,
      'record format version 2 is newer than the supported version 1; upgrade eedsh',
    ],
    [
      'an empty generation id',
      generatedManifest({ generationId: '' }),
      'generation-id',
      true,
      'the generation identifier is missing or empty',
    ],
    [
      'a malformed plan hash',
      generatedManifest({ planHash: 'not-a-hash' }),
      'plan-hash',
      true,
      'the plan hash is not a 64-character SHA-256 hex digest',
    ],
    [
      'a non-array layer list',
      generatedManifest({ layers: 'nope' }),
      'layers',
      true,
      'the layer list is missing or malformed',
    ],
    [
      'a non-object layer entry',
      generatedManifest({ layers: [null] }),
      'layers',
      true,
      'the layer list is missing or malformed',
    ],
    [
      'an empty layer field',
      generatedManifest({ layers: [{ ...layerList()[0], id: '' }] }),
      'layers',
      true,
      'the layer list is missing or malformed',
    ],
    [
      'an empty bundle list',
      generatedManifest({ bundles: [] }),
      'bundles',
      true,
      'the managed bundle list must be a non-empty list of bundle names',
    ],
    [
      'an empty bundle name',
      generatedManifest({ bundles: [BUNDLE, ''] }),
      'bundles',
      true,
      'the managed bundle list must be a non-empty list of bundle names',
    ],
    [
      'a bundle list missing the runtime',
      generatedManifest({ bundles: [BUNDLE, '@eedsh/generated'] }),
      'bundles',
      true,
      'the managed bundle list does not include "@eedsh/runtime" and "@eedsh/generated"',
    ],
    [
      'an empty package map',
      generatedManifest({ packages: {} }),
      'packages',
      true,
      'the managed package map must be a non-empty record of package specifications',
    ],
    [
      'an empty package key',
      generatedManifest({ packages: { '': '1.0.0' } }),
      'packages',
      true,
      'the managed package map must be a non-empty record of package specifications',
    ],
    [
      'a non-string package specification',
      generatedManifest({ packages: { '@scope/plugin': 1 } }),
      'packages',
      true,
      'the managed package map must be a non-empty record of package specifications',
    ],
  ]

  it.each(cases)('classifies %s', (_label, value, reason, adoptable, detail) => {
    expect(classifyGenerationRecord(value, RECORD_PATH)).toEqual({
      _tag: 'invalid',
      path: RECORD_PATH,
      reason,
      detail,
      adoptable,
    })
  })

  it('classifies a missing record as adoptable', () => {
    expect(missingGenerationRecord(RECORD_PATH)).toEqual({
      _tag: 'invalid',
      path: RECORD_PATH,
      reason: 'missing',
      detail: 'the generated package manifest does not exist',
      adoptable: true,
    })
  })

  it('ignores extra fields while accepting a valid record', () => {
    const result = classifyGenerationRecord(
      { ...generatedManifest({ extra: 'ignored' }), extra: 'ignored' },
      RECORD_PATH,
    )
    expect(result._tag).toBe('valid')
    if (result._tag !== 'valid') expect.unreachable('expected a valid record')
    expect(result.record).not.toHaveProperty('extra')
  })
})
