import { type BundleQueryDescriptor, type DshBridge, ResolutionError } from '@eedsh/config'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { resolveDescriptors, resolveOne } from '../src/resolve'
import { devDshInstallation, loadTestBridge } from './support/bridge'
import { realFileSystemValue } from './support/cli'

const installation = devDshInstallation()
const context = {
  installation,
  configDir: process.cwd(),
  env: { DSH_HOME: process.env.DSH_HOME },
}

function query(
  request: Pick<BundleQueryDescriptor, 'row' | 'rows' | 'preset' | 'presets'>,
): BundleQueryDescriptor {
  return { bundle: '@deepseek-ai/dsh-base', root: {}, ...request }
}

async function failureOf(run: () => Promise<unknown>): Promise<ResolutionError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(ResolutionError)
    return error as ResolutionError
  }
  throw new Error('expected a ResolutionError')
}

describe('invocation bundle resolution', () => {
  it('resolves each distinct bundle and root pair once', async () => {
    const bridge = await loadTestBridge()
    let reads = 0
    const counting: DshBridge = {
      ...bridge,
      loadOverlayPatches: (bin, path) => {
        reads += 1
        return bridge.loadOverlayPatches(bin, path)
      },
    }
    const fs = await realFileSystemValue()
    // Measure the baseline for one resolution of the pair.
    const single = await Effect.runPromise(
      resolveOne(fs, bridge, '@deepseek-ai/dsh-base', {}, context),
    )
    const baseline = await Effect.runPromise(Effect.sync(() => single.rows.length))
    expect(baseline).toBeGreaterThan(0)
    reads = 0
    const outcome = await Effect.runPromise(
      resolveDescriptors(fs, counting, [query({ row: 'timer' }), query({ rows: true })], context),
    )
    expect(outcome.table.bundles).toHaveLength(1)
    expect(outcome.traces).toHaveLength(1)
    expect(reads).toBeGreaterThan(0)
    const afterOnce = reads
    reads = 0
    await Effect.runPromise(resolveDescriptors(fs, counting, [query({ rows: true })], context))
    expect(reads).toBe(afterOnce)
  })

  it('validates every requested row and preset id', async () => {
    const bridge = await loadTestBridge()
    const fs = await realFileSystemValue()
    const row = await failureOf(() =>
      Effect.runPromise(resolveDescriptors(fs, bridge, [query({ row: 'missing' })], context)),
    )
    expect(row.code).toBe('resolution.row_not_found')
    expect(row.bundle).toBe('@deepseek-ai/dsh-base')
    expect(row.message).toContain('"missing"')
    const preset = await failureOf(() =>
      Effect.runPromise(resolveDescriptors(fs, bridge, [query({ preset: 'missing' })], context)),
    )
    expect(preset.code).toBe('resolution.preset_not_found')
    expect(preset.message).toContain('"missing"')
  })

  it('rejects two roots before resolving', async () => {
    const bridge = await loadTestBridge()
    const fs = await realFileSystemValue()
    const failure = await failureOf(() =>
      Effect.runPromise(
        resolveDescriptors(
          fs,
          bridge,
          [
            {
              bundle: '@deepseek-ai/dsh-base',
              root: { profile: 'work', packageDir: '/x' },
              rows: true,
            },
          ],
          context,
        ),
      ),
    )
    expect(failure.code).toBe('resolution.root_conflict')
  })

  it('reports a bundle the installation does not ship with the explicit-root remedy', async () => {
    const bridge = await loadTestBridge()
    const fs = await realFileSystemValue()
    const failure = await failureOf(() =>
      Effect.runPromise(
        resolveDescriptors(
          fs,
          bridge,
          [{ bundle: '@fixture/absent', root: {}, rows: true }],
          context,
        ),
      ),
    )
    expect(failure.code).toBe('resolution.bundle_not_found')
    expect(failure.message).toContain('explicit root')
  })

  it('resolves a relative package directory against the config directory', async () => {
    const bridge = await loadTestBridge()
    const fs = await realFileSystemValue()
    const failure = await failureOf(() =>
      Effect.runPromise(
        resolveDescriptors(
          fs,
          bridge,
          [
            {
              bundle: '@fixture/absent',
              root: { packageDir: '../does-not-exist' },
              rows: true,
            },
          ],
          { ...context, configDir: process.cwd() },
        ),
      ),
    )
    expect(failure.code).toBe('resolution.package_dir_missing')
    expect(failure.path).toContain('does-not-exist')
  })

  it('keeps the table empty when there are no descriptors', async () => {
    const bridge = await loadTestBridge()
    const fs = await realFileSystemValue()
    const outcome = await Effect.runPromise(resolveDescriptors(fs, bridge, [], context))
    expect(outcome).toEqual({ table: { bundles: [] }, bundles: [], traces: [] })
  })
})
