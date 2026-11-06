import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkBundlePatch, loadPatchesYaml, type PatchEntry } from '../src/index'
import definition from './fixtures/plugin-bundle/cordis'

const fixture = join(import.meta.dirname, 'fixtures', 'plugin-bundle')

describe('generated plugin compatibility', () => {
  it('keeps a standard DSH bundle manifest with no eedsh runtime dependency', () => {
    const manifest = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8')) as Record<
      string,
      any
    >
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.dependencies?.['@eedsh/bundle']).toBeUndefined()
    expect(manifest.peerDependencies?.['@eedsh/bundle']).toBeUndefined()
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      expect(name.startsWith('@eedsh/')).toBe(false)
    }
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      expect(name.startsWith('@eedsh/')).toBe(false)
    }
    expect(manifest.dsh?.eedsh).toBeUndefined()
  })

  it('checks the committed artifact against the definition', () => {
    const result = checkBundlePatch(definition, join(fixture, 'cordis.patch.yml'))
    expect(result.ok, result.message).toBe(true)
  })

  it('emits only DSH patch data and preserves rows, groups, presets, and expressions', () => {
    const text = readFileSync(join(fixture, 'cordis.patch.yml'), 'utf8')
    expect(text).not.toContain('$eedsh')
    const patches = loadPatchesYaml(text)
    const flat = patches.flatMap((patch: PatchEntry) =>
      Array.isArray(patch.insert) ? (patch.insert as PatchEntry[]) : [patch],
    )
    expect(flat.map((entry) => entry.id)).toEqual([
      'fixture-plugin',
      'fixture-tool',
      'fixture-group',
      'fixture-preset',
      'fixture-plugin',
    ])
    const group = flat.find((entry) => entry.id === 'fixture-group')
    expect(group).toMatchObject({ group: true, isolate: { fixture: true } })
    expect(Array.isArray(group?.config)).toBe(true)
    const tool = flat.find((entry) => entry.id === 'fixture-tool')
    expect(tool?.disabled).toEqual({ __jsExpr: "process.platform === 'win32'" })
  })
})
