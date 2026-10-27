import { canonicalJson, hashPlan } from '@eedsh/config'
import { describe, expect, it } from 'vitest'
import { readmePlan } from '../../../../test/support/readme'

/**
 * Canonical JSON and SHA-256 recorded with the pre-Effect validator for the
 * plan the README example produces. Valid plans must keep the same
 * generation digest across the schema migration.
 */
const CANONICAL_JSON =
  '{"bundles":[{"kind":"bundle","name":"@deepseek-ai/dsh-base"},{"kind":"bundle","name":"@deepseek-ai/dsh-web-app"},{"kind":"generated"}],"dsh":"0.2.1-rc.2","format":"eedsh/profile-plan","layers":[{"id":"plugins","patches":[{"insert":[{"config":{"enabled":true},"id":"my-plugin","name":"@scope/my-plugin"}]},{"disabled":true,"id":"repeat-tool-reminder"}]},{"id":"overrides","patches":[{"config":{"model":"deepseek-chat","provider":"deepseek"},"id":"agent-default-model"},{"insert":[{"disabled":{"$eedsh":{"expr":"!ctx.get(\'profileContext\')"}},"id":"plugin-manager","name":"@deepseek-ai/dsh-plugin-manager"}]}]}],"packages":{"@scope/my-plugin":"link:../packages/my-plugin"},"profile":{"name":"work"},"version":1}'

const PLAN_HASH = '2522100ca927c6a7e299b2b954a41e1dc937305feb917ace96e2cfe279a564e0'

describe('plan hash parity', () => {
  it('keeps the canonical JSON and hash of the README example plan', async () => {
    const plan = await readmePlan('Example configuration')
    expect(canonicalJson(plan)).toBe(CANONICAL_JSON)
    expect(hashPlan(plan)).toBe(PLAN_HASH)
  })
})
