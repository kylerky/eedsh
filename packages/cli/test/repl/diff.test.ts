import { PLAN_FORMAT, PLAN_VERSION, type ProfilePlan, validatePlan } from '@eedsh/plan'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { diffPlans, type PlanMap } from '../../src/repl/diff'

function insertPatch(id: string) {
  return { insert: [{ id, name: `@scope/${id}` }] }
}

function planWith(layers: readonly unknown[]): ProfilePlan {
  const result = validatePlan({
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    profile: { name: 'work' },
    dsh: '0.2.1-rc.2',
    bundles: [{ kind: 'bundle', name: '@deepseek-ai/dsh-base' }, { kind: 'generated' }],
    layers,
    packages: {},
  })
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}

function map(plan: ProfilePlan): PlanMap {
  return new Map([['work', plan]])
}

function layerLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith('+ layer') || line.startsWith('- layer'))
}

describe('config diff groups', () => {
  it('reports only the group inserted in the middle as added', () => {
    const before = planWith([{ patches: [insertPatch('a')] }, { patches: [insertPatch('c')] }])
    const after = planWith([
      { patches: [insertPatch('a')] },
      { patches: [insertPatch('b')] },
      { patches: [insertPatch('c')] },
    ])
    const lines = diffPlans(map(before), map(after))
    expect(layerLines(lines)).toEqual(['+ layer #2 (profile "work")'])
    expect(lines).toContain('+ row "b" (profile "work" layer #2)')
  })

  it('reports only the group removed from the middle as removed', () => {
    const before = planWith([
      { patches: [insertPatch('a')] },
      { patches: [insertPatch('b')] },
      { patches: [insertPatch('c')] },
    ])
    const after = planWith([{ patches: [insertPatch('a')] }, { patches: [insertPatch('c')] }])
    const lines = diffPlans(map(before), map(after))
    expect(layerLines(lines)).toEqual(['- layer #2 (profile "work")'])
    expect(lines).toHaveLength(1)
  })

  it('pairs repeated identical groups in order', () => {
    const repeated = { patches: [insertPatch('a')] }
    const before = planWith([repeated, repeated])
    const after = planWith([repeated])
    expect(layerLines(diffPlans(map(before), map(after)))).toEqual(['- layer #2 (profile "work")'])
  })

  it('prints a recorded legacy label with the position', () => {
    const before = planWith([])
    const after = planWith([{ id: 'lsp', patches: [insertPatch('a')] }])
    expect(layerLines(diffPlans(map(before), map(after)))).toEqual([
      '+ layer "lsp" (#1) (profile "work")',
    ])
  })
})
