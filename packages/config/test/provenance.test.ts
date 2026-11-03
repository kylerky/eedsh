import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { clearProvenance, configProvenance, defineConfig, type LayerBuilder } from '@eedsh/config'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { addHelperRow } from './fixtures/provenance-helper'

const self = fileURLToPath(import.meta.url)
const helper = fileURLToPath(new URL('./fixtures/provenance-helper.ts', import.meta.url))

function lineOf(file: string, marker: string): number {
  return (
    readFileSync(file, 'utf8')
      .split('\n')
      .findIndex((line) => line.includes(marker)) + 1
  )
}

function buildWith(build: (layer: LayerBuilder) => void) {
  const builder = defineConfig()
  builder.profile('work', (profile) => profile.layer(build))
  return builder.build()
}

describe('patch provenance', () => {
  it('records the file and the call line of a builder call', () => {
    clearProvenance()
    buildWith((layer) => {
      layer.insert({ id: 'row', name: '@scope/plugin' }) // provenance-insert
    })
    const group = configProvenance()?.profiles.work?.[0]
    expect(group?.sites).toHaveLength(1)
    expect(group?.sites[0]?.file).toBe(self)
    expect(group?.sites[0]?.line).toBe(lineOf(self, 'provenance-insert'))
    expect(group?.sites[0]?.column).toBeGreaterThan(0)
  })

  it('attributes a call made through a helper module to the helper', () => {
    clearProvenance()
    buildWith((layer) => addHelperRow(layer))
    const site = configProvenance()?.profiles.work?.[0]?.sites[0]
    expect(site?.file).toBe(helper)
    expect(site?.line).toBe(lineOf(helper, 'provenance-helper-insert'))
  })

  it('records the optional group label without making it an identifier', () => {
    clearProvenance()
    const builder = defineConfig()
    builder.profile('work', (profile) =>
      profile.layer('lsp', (layer) => layer.disable('preset-standard')),
    )
    builder.build()
    const group = configProvenance()?.profiles.work?.[0]
    expect(group?.label).toBe('lsp')
    expect(group?.sites).toHaveLength(1)
  })

  it('keeps only the latest evaluation', () => {
    clearProvenance()
    const first = defineConfig()
    first.profile('work', (profile) => profile.layer((layer) => layer.disable('a')))
    first.build()
    const second = defineConfig()
    second.profile('work', (profile) =>
      profile.layer((layer) => {
        layer.disable('a')
        layer.disable('b')
      }),
    )
    second.build()
    const groups = configProvenance()?.profiles.work
    expect(groups).toHaveLength(1)
    expect(groups?.[0]?.sites).toHaveLength(2)
  })

  it('clears the recorded provenance', () => {
    buildWith((layer) => layer.disable('a'))
    expect(configProvenance()).toBeDefined()
    clearProvenance()
    expect(configProvenance()).toBeUndefined()
  })

  it('never fails evaluation when no site can be determined', () => {
    clearProvenance()
    const previous = Error.stackTraceLimit
    Error.stackTraceLimit = 0
    try {
      expect(Result.isSuccess(buildWith((layer) => layer.disable('a')))).toBe(true)
    } finally {
      Error.stackTraceLimit = previous
    }
    expect(configProvenance()?.profiles.work?.[0]?.sites[0]).toBeUndefined()
  })
})