import { canonicalJson } from '@eedsh/plan'
import { describe, expect, it } from 'vitest'
import { readmeExample } from '../../../../test/support/readme'
import { hashPlan } from '../../src/materialize/generated-bundle'
import { planOf } from '../support/plan'

/**
 * Canonical JSON and SHA-256 for the anonymous-group plan the README example
 * produces. The legacy layer identifiers are gone, so this pins the plan
 * contract after the provenance change.
 */
const CANONICAL_JSON =
  '{"bundles":[{"kind":"bundle","name":"@deepseek-ai/dsh-base"},{"kind":"bundle","name":"@deepseek-ai/dsh-web-app"},{"kind":"generated"}],"dsh":"0.2.1-rc.2","format":"eedsh/profile-plan","layers":[{"patches":[{"insert":[{"config":{"enabled":true},"id":"my-plugin","name":"@scope/my-plugin"}]},{"disabled":true,"id":"repeat-tool-reminder"}]},{"patches":[{"config":{"model":"deepseek-chat","provider":"deepseek"},"id":"agent-default-model"},{"insert":[{"disabled":{"$eedsh":{"expr":"!ctx.get(\'profileContext\')"}},"id":"plugin-manager","name":"@deepseek-ai/dsh-plugin-manager"}]}]}],"packages":{"@scope/my-plugin":"link:../packages/my-plugin"},"profile":{"name":"work"},"version":1}'

const PLAN_HASH = '9b8b6b94301912bd5ac87fe8d935a93e112fdf46ec264d0ac7e2156eab305d10'

describe('plan hash parity', () => {
  it('keeps the canonical JSON and hash of the README example plan', async () => {
    const example = await readmeExample('Example configuration')
    const plan = example.plan('work')
    expect(canonicalJson(plan)).toBe(CANONICAL_JSON)
    expect(hashPlan(plan)).toBe(PLAN_HASH)
  })
})

describe('canonical plan hashing', () => {
  it('is stable across key insertion order and changes with content', () => {
    const left = planOf({
      name: 'work',
      dsh: '0.2.1-rc.2',
      packages: { alpha: '1.0.0', beta: '2.0.0' },
    })
    const right = planOf({
      name: 'work',
      dsh: '0.2.1-rc.2',
      packages: { beta: '2.0.0', alpha: '1.0.0' },
    })
    expect(hashPlan(left)).toBe(hashPlan(right))
    const changed = planOf({
      name: 'work',
      dsh: '0.2.2-rc.1',
      packages: { alpha: '1.0.0', beta: '2.0.0' },
    })
    expect(hashPlan(changed)).not.toBe(hashPlan(left))
  })

  it('produces a 64-character hex digest', () => {
    expect(hashPlan(planOf({ name: 'work', dsh: '0.2.1-rc.2' }))).toMatch(/^[0-9a-f]{64}$/)
  })
})
