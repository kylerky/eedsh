import { PLAN_FORMAT, PLAN_VERSION } from '@eedsh/plan'

/** A shape-level bundle selection for schema tests. */
export const bundle = (name: string) => ({ kind: 'bundle', name })

/** A shape-level layer for schema tests. */
export const layer = (id: string, patches: unknown[] = []) => ({ id, patches })

/**
 * A minimally valid plan document with optional overrides.
 * @param overrides - fields to replace.
 * @returns the candidate plan document.
 */
export function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    profile: { name: 'work' },
    bundles: [bundle('@deepseek-ai/dsh-base')],
    layers: [],
    packages: {},
    ...overrides,
  }
}
