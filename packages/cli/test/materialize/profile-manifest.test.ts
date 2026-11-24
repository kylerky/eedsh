import { join } from 'node:path'
import { Effect } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { classifyProfileManifest, readProfileManifest } from '../../src/materialize/profile-manifest'
import { memoryFileSystem } from '../support/fakes'

const PROFILE_DIR = '/home/profiles/work'
const MANIFEST_PATH = join(PROFILE_DIR, 'package.json')

function readManifest(fs: ReturnType<typeof memoryFileSystem>) {
  return Effect.runPromise(readProfileManifest(MANIFEST_PATH, fs.fs))
}

describe('profile manifest classification', () => {
  it('classifies a missing document as missing', async () => {
    const fs = memoryFileSystem()
    const value = await readManifest(fs)
    expect(value._tag).toBe('missing')
  })

  it('classifies malformed JSON as invalid with reason unparseable', async () => {
    const fs = memoryFileSystem({ [MANIFEST_PATH]: '{ not json' })
    const value = await readManifest(fs)
    expect(value).toMatchObject({ _tag: 'invalid', reason: 'unparseable', path: MANIFEST_PATH })
    if (value._tag !== 'invalid') throw new Error('expected an invalid manifest')
    expect(value.detail).toContain('not valid JSON')
  })

  it('classifies a non-object document as invalid with reason not-an-object', async () => {
    for (const text of ['[]', 'null', '5', '"text"', 'true']) {
      const fs = memoryFileSystem({ [MANIFEST_PATH]: text })
      const value = await readManifest(fs)
      expect(value).toMatchObject({ _tag: 'invalid', reason: 'not-an-object' })
      if (value._tag !== 'invalid') throw new Error('expected an invalid manifest')
      expect(value.detail).toBe('not a JSON object')
    }
  })

  it('classifies an object document as valid and carries the document', async () => {
    const text = '{"name":"dsh-profile-work","dependencies":{"a":"1.0.0"}}'
    const fs = memoryFileSystem({ [MANIFEST_PATH]: text })
    const value = await readManifest(fs)
    expect(value._tag).toBe('valid')
    if (value._tag !== 'valid') throw new Error('expected a valid manifest')
    expect(value.document).toEqual({ name: 'dsh-profile-work', dependencies: { a: '1.0.0' } })
    expect(value.path).toBe(MANIFEST_PATH)
  })

  it('reports a file-system read failure as a platform failure, not as absence', async () => {
    const fs = memoryFileSystem({ [MANIFEST_PATH]: '{}' })
    const broken = {
      ...fs.fs,
      readFileString: (path: string) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: 'PermissionDenied',
            module: 'FileSystem',
            method: 'readFileString',
            pathOrDescriptor: path,
          }),
        ),
    }
    const error = await Effect.runPromise(
      Effect.result(readProfileManifest(MANIFEST_PATH, broken)),
    )
    expect(Result.isFailure(error)).toBe(true)
    if (Result.isFailure(error)) {
      expect(PlatformError.isPlatformError(error.failure)).toBe(true)
      expect(error.failure.reason._tag).toBe('PermissionDenied')
    }
  })

  it('reads only the provided file system', async () => {
    const fs = memoryFileSystem({ [MANIFEST_PATH]: '{}' })
    const value = await readManifest(fs)
    expect(value._tag).toBe('valid')
  })
})
const BUNDLE = '@deepseek-ai/dsh-base'
const OTHER_BUNDLE = '@edsh/adapted-ptc'

function manifestOf(document: unknown) {
  const value = classifyProfileManifest(document, MANIFEST_PATH)
  if (value._tag !== 'valid') throw new Error(`expected a valid manifest, got ${value._tag}`)
  return value
}

describe('profile manifest typed view', () => {
  it('reads the managed bundle list', () => {
    const view = manifestOf({ dsh: { profile: { bundles: [BUNDLE, OTHER_BUNDLE] } } })
    expect(view.bundles).toEqual({
      state: 'valid',
      names: [BUNDLE, OTHER_BUNDLE],
      unreadable: [],
    })
  })

  it('classifies a bundle list with non-string entries as partially readable', () => {
    const view = manifestOf({ dsh: { profile: { bundles: [BUNDLE, 1, null, OTHER_BUNDLE, ''] } } })
    expect(view.bundles).toEqual({
      state: 'partially-readable',
      names: [BUNDLE, OTHER_BUNDLE, ''],
      unreadable: [1, 2],
    })
  })

  it('classifies a missing or malformed bundle list', () => {
    expect(manifestOf({}).bundles).toEqual({ state: 'absent', names: [], unreadable: [] })
    expect(manifestOf({ dsh: { profile: {} } }).bundles).toEqual({
      state: 'absent',
      names: [],
      unreadable: [],
    })
    expect(manifestOf({ dsh: { profile: { bundles: 'not-an-array' } } }).bundles).toEqual({
      state: 'malformed',
      names: [],
      unreadable: [],
    })
  })

  it('reads the three install-relevant dependency sections', () => {
    const view = manifestOf({
      dependencies: { '@scope/plugin': '1.0.0' },
      devDependencies: { '@scope/tool': '^2.0.0' },
      optionalDependencies: { '@scope/optional': '3.0.0' },
    })
    expect(view.dependencies).toEqual({
      state: 'valid',
      specs: { '@scope/plugin': '1.0.0' },
      entries: { '@scope/plugin': '1.0.0' },
      unreadable: [],
    })
    expect(view.devDependencies.specs).toEqual({ '@scope/tool': '^2.0.0' })
    expect(view.optionalDependencies.specs).toEqual({ '@scope/optional': '3.0.0' })
  })

  it('classifies absent and empty dependency sections', () => {
    const empty = { state: 'absent', specs: {}, entries: {}, unreadable: [] }
    const view = manifestOf({})
    expect(view.dependencies).toEqual(empty)
    expect(view.devDependencies).toEqual(empty)
    expect(view.optionalDependencies).toEqual(empty)
    expect(manifestOf({ dependencies: {} }).dependencies).toEqual({
      state: 'valid',
      specs: {},
      entries: {},
      unreadable: [],
    })
  })

  it('names every unreadable dependency entry and keeps the readable ones', () => {
    const view = manifestOf({
      dependencies: { good: '1.0.0', bad: 1, nil: null, empty: '', nested: {} },
    })
    expect(view.dependencies).toEqual({
      state: 'partially-readable',
      specs: { good: '1.0.0', empty: '' },
      entries: { good: '1.0.0', bad: 1, nil: null, empty: '', nested: {} },
      unreadable: ['bad', 'nil', 'nested'],
    })
  })

  it('classifies a malformed section without blocking the others', () => {
    const view = manifestOf({
      dependencies: [],
      devDependencies: { '@scope/tool': '^2.0.0' },
      optionalDependencies: 'not-a-record',
    })
    expect(view.dependencies).toEqual({
      state: 'malformed',
      specs: {},
      entries: {},
      unreadable: [],
    })
    expect(view.devDependencies.state).toBe('valid')
    expect(view.devDependencies.specs).toEqual({ '@scope/tool': '^2.0.0' })
    expect(view.optionalDependencies.state).toBe('malformed')
  })

  it('reads the conflict sections tolerantly', () => {
    const view = manifestOf({
      dependencies: { '@scope/plugin': '1.0.0' },
      peerDependencies: { '@scope/plugin': '*', '@scope/peer': '1' },
      pnpm: { overrides: { '@scope/plugin': '1.0.0' } },
      overrides: { zebra: '1', '@scope/plugin': '^1.0.0' },
      resolutions: { '@scope/plugin': '1.0.0' },
    })
    expect(view.conflicts).toEqual({
      peerDependencies: ['@scope/peer', '@scope/plugin'],
      pnpmOverrides: ['@scope/plugin'],
      overrides: ['@scope/plugin', 'zebra'],
      resolutions: ['@scope/plugin'],
    })
  })

  it('ignores malformed and absent conflict sections', () => {
    const view = manifestOf({ pnpm: 'not-a-record', overrides: null, resolutions: [] })
    expect(view.conflicts).toEqual({
      peerDependencies: [],
      pnpmOverrides: [],
      overrides: [],
      resolutions: [],
    })
  })

  it('treats a non-object dsh or profile section as empty and preserves the document', () => {
    const absent = manifestOf({ name: 'keep', dependencies: {}, dsh: null })
    expect(absent.bundles.state).toBe('absent')
    expect(absent.document).toEqual({ name: 'keep', dependencies: {}, dsh: null })
    expect(manifestOf({ dsh: [] }).bundles.state).toBe('absent')
    expect(manifestOf({ dsh: { runtime: 'keep', profile: 'not-a-record' } }).bundles.state).toBe(
      'absent',
    )
    expect(manifestOf({ dsh: { profile: [] } }).bundles.state).toBe('absent')
  })
})
describe('profile manifest preservation', () => {
  it('preserves unmanaged fields and their key order', () => {
    const document = {
      zeta: 1,
      scripts: { build: 'tsc' },
      dsh: { profile: { theme: 'dark', bundles: [BUNDLE] }, runtime: 'keep' },
      alpha: true,
      dependencies: { zebra: '1.0.0', alpha: '2.0.0' },
    }
    const view = manifestOf(document)
    expect(view.document).toEqual(document)
    expect(Object.keys(view.document)).toEqual([
      'zeta',
      'scripts',
      'dsh',
      'alpha',
      'dependencies',
    ])
    expect(Object.keys(view.dependencies.entries)).toEqual(['zebra', 'alpha'])
    expect(view.bundles.names).toEqual([BUNDLE])
  })

  it('performs no writes while reading', async () => {
    const text = `${JSON.stringify({ name: 'mine', dependencies: { a: '1' } }, null, 2)}\n`
    const fs = memoryFileSystem({ [MANIFEST_PATH]: text })
    const before = new Map(fs.files)
    const value = await readManifest(fs)
    expect(value._tag).toBe('valid')
    expect(fs.writeCount()).toBe(0)
    expect(fs.writeOrder).toEqual([])
    expect(fs.renameOrder).toEqual([])
    expect(new Map(fs.files)).toEqual(before)
  })
})
