/**
 * Fake invocation resolutions for pure authoring tests. They mirror the rows a
 * real bundle contributes without reading any file, so a test proves the
 * descriptor/build contract independently of CLI resolution IO.
 */
import type { PlanEntry, QueryRoot, ResolutionTable, ResolvedBundle } from '@eedsh/config'

/** One resolved bundle with the fields the table contract requires. */
export function resolvedBundle(
  bundle: string,
  rows: readonly PlanEntry[],
  options: {
    readonly root?: QueryRoot
    readonly version?: string
    readonly packageDir?: string
    readonly origin?: ResolvedBundle['origin']
    readonly profile?: string
  } = {},
): ResolvedBundle {
  const root = options.root ?? {}
  const packageDir = options.packageDir ?? `/fixtures/${bundle}`
  return {
    bundle,
    root,
    packageDir,
    manifestPath: `${packageDir}/package.json`,
    version: options.version ?? '1.0.0',
    origin: options.origin ?? 'active',
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    rows,
  }
}

/** Build one resolution table. */
export function resolutionTable(...bundles: readonly ResolvedBundle[]): ResolutionTable {
  return { bundles }
}

/** The rows the fixture base bundle contributes. */
export const BASE_ROWS: readonly PlanEntry[] = [
  {
    id: 'preset-standard',
    name: '@deepseek-ai/dsh-agent-preset',
    config: { id: 'standard', order: 1, name: 'Standard' },
  },
  { id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' },
]

/** The rows the fixture expressive bundle contributes. */
export const EXPRESSIVE_ROWS: readonly PlanEntry[] = [
  {
    id: 'preset-expressive',
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: 'expressive',
      name: 'Expressive',
      order: 2,
      plugins: [
        {
          id: 'tool-web',
          name: '@deepseek-ai/dsh-tool-web',
          disabled: { $eedsh: { expr: "!ctx.get('profileContext')" } },
        },
        {
          id: 'tool-todo',
          name: '@deepseek-ai/dsh-tool-todo',
          config: { label: { $eedsh: { expr: "ctx.get('profileContext').label" } } },
        },
      ],
    },
  },
]

/** The rows the fixture custom profile bundle contributes. */
export const CUSTOM_ROWS: readonly PlanEntry[] = [{ id: 'custom-row', name: '@fixture/plugin' }]
