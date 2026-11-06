import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkBundlePatch } from '@eedsh/bundle'
import { describe, expect, it } from 'vitest'
import definition from '../src/cordis'

describe('runtime bundle patch', () => {
  it('matches the committed generated artifact', () => {
    const result = checkBundlePatch(definition, join(import.meta.dirname, '..', 'cordis.patch.yml'))
    expect(result.ok, result.message).toBe(true)
  })

  it('emits DSH patch data without eedsh expression nodes', () => {
    const text = readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')
    expect(text).toContain("id: '@eedsh/runtime'")
    expect(text).not.toContain('$eedsh')
  })
})
