import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DshBridge } from '@eedsh/config'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from 'effect'
import { describe, expect, it } from 'vitest'
import type {
  BundleResolverShape,
  CliServices,
  InstallationAnchorShape,
} from '../src/internal/effect/services'
import { Output } from '../src/internal/effect/services'
import { type PathEvent, watchConfigDirectory } from '../src/watch'
import { delay, waitFor } from './support/async'
import { devDshInstallation } from './support/bridge'
import {
  captureOutput,
  fakeConfigLoader,
  fakeDshDiscovery,
  forkCli,
  interruptCli,
} from './support/cli'
import { fakeWatcher } from './support/fakes'

const root = process.cwd()
const tempRoot = join(root, 'packages/cli/.tmp')

async function tempDir(prefix: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  return mkdtemp(join(tempRoot, prefix))
}

describe('config directory watcher', () => {
  it('streams add, change, and unlink events and ignores non-config segments', async () => {
    const dir = await tempDir('watch-stream-')
    await writeFile(join(dir, 'config.ts'), 'export default 1\n')
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(dir, '.eedsh'), { recursive: true })
    await mkdir(join(dir, '.git'), { recursive: true })

    const events: PathEvent[] = []
    const ready = await Effect.runPromise(Deferred.make<void>())
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* watchConfigDirectory(dir)
          yield* Deferred.succeed(ready, undefined)
          yield* stream.pipe(Stream.runForEach((event) => Effect.sync(() => events.push(event))))
        }),
      ),
    )
    await Effect.runPromise(Deferred.await(ready))

    await writeFile(join(dir, 'added.ts'), 'export default 2\n')
    expect(
      await waitFor(() =>
        events.some((event) => event.kind === 'add' && event.path.endsWith('added.ts')),
      ),
    ).toBe(true)

    await writeFile(join(dir, 'config.ts'), 'export default 3\n')
    expect(
      await waitFor(() =>
        events.some((event) => event.kind === 'change' && event.path.endsWith('config.ts')),
      ),
    ).toBe(true)

    await unlink(join(dir, 'config.ts'))
    expect(
      await waitFor(() =>
        events.some((event) => event.kind === 'unlink' && event.path.endsWith('config.ts')),
      ),
    ).toBe(true)

    // A native watcher can deliver delayed notifications for writes made just
    // before; settle before writing below the ignored segments.
    await delay(200)
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'export default 4\n')
    await writeFile(join(dir, '.eedsh', 'state.ts'), 'export default 5\n')
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await delay(400)
    expect(
      events.filter((event) =>
        ['node_modules', '.eedsh', '.git'].some((segment) =>
          event.path.split(/[\\/]/).includes(segment),
        ),
      ),
    ).toEqual([])

    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })

  it('releases the watcher and layer on interruption without a diagnostic', async () => {
    const dir = await tempDir('watch-shutdown-')
    const configPath = join(dir, 'config.ts')
    const watcher = fakeWatcher()
    let loads = 0
    const configLoader = fakeConfigLoader(() => {
      loads += 1
      return Effect.succeed({
        config: { profiles: {} },
        provenance: undefined,
        configDir: dir,
        queries: [],
        resolution: { bundles: [] },
        traces: [],
      })
    })
    const bundleResolver: BundleResolverShape = {
      loadBridge: () => Effect.succeed({} as DshBridge),
      resolve: () => Effect.succeed({ table: { bundles: [] }, bundles: [], traces: [] }),
      resolveQuery: () => Effect.die(new Error('query resolution is unused')),
      resolveBundlePatches: () => Effect.succeed([]),
      composeEntries: () => Effect.die(new Error('composition is unused')),
    }
    const anchor: InstallationAnchorShape = {
      read: () => Effect.succeed(undefined),
      write: () => Effect.succeed({ ok: true } as const),
    }
    const out: string[] = []
    const err: string[] = []
    let finalizers = 0
    const countingOutput = Layer.effect(
      Output,
      Effect.acquireRelease(
        Effect.sync(() => captureOutput(out, err)),
        () =>
          Effect.sync(() => {
            finalizers += 1
          }),
      ),
    ) as Layer.Layer<CliServices>

    const fiber = forkCli(['sync', '--config', configPath, '--watch'], {
      environment: {
        env: { DSH_HOME: '/home', XDG_CONFIG_HOME: '/home/xdg' },
        cwd: root,
      },
      discovery: fakeDshDiscovery(devDshInstallation()),
      configLoader,
      bundleResolver,
      anchor,
      watcher: watcher.shape,
      extra: [countingOutput],
    })

    expect(await waitFor(() => loads === 1)).toBe(true)
    expect(watcher.watchCalls).toHaveLength(1)
    expect(watcher.closes).toEqual([])

    const exit = await interruptCli(fiber)

    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(watcher.closes).toEqual([dir])
    expect(finalizers).toBe(1)
    expect(out).toEqual([])
    expect(err).toEqual([])
  })
})
