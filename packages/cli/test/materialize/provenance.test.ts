import { describe, expect, it } from 'vitest'
import {
  buildProvenanceSidecar,
  provenanceSidecarContent,
  readProvenanceSidecar,
  relativizeSite,
} from '../../src/materialize/provenance'

const configDir = '/repo/config'

describe('provenance sites', () => {
  it('expresses an absolute site relative to the config directory', () => {
    expect(
      relativizeSite({ file: '/repo/config/config.ts', line: 3, column: 5 }, configDir),
    ).toEqual({ file: 'config.ts', line: 3, column: 5 })
  })

  it('keeps a site outside the config directory relative', () => {
    const site = relativizeSite({ file: '/repo/shared/helper.ts', line: 8, column: 2 }, configDir)
    expect(site).toEqual({ file: '../shared/helper.ts', line: 8, column: 2 })
    expect(site?.file.startsWith('/')).toBe(false)
  })

  it('records an unknown site as null and refuses an unusable path', () => {
    expect(relativizeSite(undefined, configDir)).toBeNull()
    expect(relativizeSite({ file: configDir, line: 1, column: 1 }, configDir)).toBeNull()
  })
})

describe('provenance sidecar', () => {
  it('names the generation and records labels with per-patch sites', () => {
    const sidecar = buildProvenanceSidecar({
      generationId: 'a'.repeat(64),
      configDir,
      groups: [
        {
          label: 'lsp',
          sites: [{ file: '/repo/config/config.ts', line: 3, column: 5 }, undefined],
        },
        { label: undefined, sites: [] },
      ],
    })
    expect(sidecar).toEqual({
      format: 'eedsh/provenance',
      version: 1,
      generationId: 'a'.repeat(64),
      groups: [
        {
          position: 1,
          label: 'lsp',
          patches: [{ file: 'config.ts', line: 3, column: 5 }, null],
        },
        { position: 2, patches: [] },
      ],
    })
    expect(
      JSON.parse(
        provenanceSidecarContent({
          generationId: 'a'.repeat(64),
          configDir,
          groups: [],
        }),
      ),
    ).toMatchObject({ format: 'eedsh/provenance', generationId: 'a'.repeat(64) })
  })

  it('reads a valid sidecar and ignores a malformed one', () => {
    const valid = {
      format: 'eedsh/provenance',
      version: 1,
      generationId: 'a'.repeat(64),
      groups: [{ position: 1, label: 'lsp', patches: [null] }],
    }
    expect(readProvenanceSidecar(valid)).toEqual(valid)
    expect(readProvenanceSidecar({ ...valid, version: 2 })).toBeUndefined()
    expect(
      readProvenanceSidecar({ ...valid, groups: [{ position: 0, patches: [] }] }),
    ).toBeUndefined()
    expect(readProvenanceSidecar('not-a-sidecar')).toBeUndefined()
  })
})
