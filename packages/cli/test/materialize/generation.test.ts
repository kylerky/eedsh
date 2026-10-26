import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  GENERATED_PACKAGE_NAME,
  GENERATION_FORMAT,
  GENERATION_VERSION,
  type GenerationLayer,
} from '../../src/materialize/generated-bundle'
import {
  classifyGenerationRecord,
  lookupGenerationRecord,
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
