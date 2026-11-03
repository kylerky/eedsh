import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type HmrLike,
  type ReconcileOutcome,
  registerGeneratedLayerWatcher,
  type WatcherLogger,
} from '../src/watcher'

const root = process.cwd()
const GENERATED = '.eedsh/generated/package.json'

interface LogLine {
  level: 'info' | 'warn' | 'error'
  message: string
}

function fakeLogger() {
  const lines: LogLine[] = []
  const logger: WatcherLogger = {
    info: (message) => lines.push({ level: 'info', message }),
    warn: (message) => lines.push({ level: 'warn', message }),
    error: (message) => lines.push({ level: 'error', message }),
  }
  return { logger, lines }
}

function fakeHmr(outcome: ReconcileOutcome = { warnings: [], pending: [] }) {
  const watches: { filename: string; refresh: () => Promise<void> }[] = []
  let disposed = 0
  let reconciles = 0
  const hmr: HmrLike = {
    watchConfig: async (filename, refresh) => {
      watches.push({ filename, refresh })
      return async () => {
        disposed += 1
        watches.length = 0
      }
    },
    reconcileProfile: async () => {
      reconciles += 1
      return outcome
    },
  }
  return {
    hmr,
    watches,
    reconciles: () => reconciles,
    disposed: () => disposed,
    latest: () => watches.at(-1),
  }
}

async function tempProfile(): Promise<string> {
  await mkdir(join(root, '.tmp'), { recursive: true })
  const dir = await mkdtemp(join(root, '.tmp', 'runtime-'))
  await mkdir(join(dir, '.eedsh/generated'), { recursive: true })
  return dir
}

async function writeRecord(dir: string, generationId: string, dshVersion?: string): Promise<void> {
  const eedsh = {
    format: 'eedsh/generation',
    generationId,
    ...(dshVersion === undefined ? {} : { dshVersion }),
  }
  await writeFile(
    join(dir, GENERATED),
    `${JSON.stringify({ name: '@eedsh/generated', eedsh }, null, 2)}\n`,
    'utf8',
  )
}

async function writeInstallation(dir: string, version: string): Promise<string> {
  const anchor = join(dir, 'dsh', 'package.json')
  await mkdir(join(dir, 'dsh'), { recursive: true })
  await writeFile(anchor, `${JSON.stringify({ name: '@deepseek-ai/dsh', version })}\n`, 'utf8')
  return anchor
}

async function writeRaw(dir: string, content: string): Promise<void> {
  await writeFile(join(dir, GENERATED), content, 'utf8')
}

describe('generated layer watcher registration', () => {
  it('registers only with profile context and an HMR service', async () => {
    const dir = await tempProfile()
    await writeRecord(dir, 'gen-a')
    const { logger } = fakeLogger()
    const first = fakeHmr()
    expect(await registerGeneratedLayerWatcher({ hmr: first.hmr, logger })).toBeUndefined()
    expect(await registerGeneratedLayerWatcher({ profileContext: { dir }, logger })).toBeUndefined()
    expect(first.watches).toHaveLength(0)

    const second = fakeHmr()
    const dispose = await registerGeneratedLayerWatcher({
      profileContext: { dir },
      hmr: second.hmr,
      logger,
    })
    expect(typeof dispose).toBe('function')
    expect(second.latest()?.filename).toBe(join(dir, GENERATED))
    await dispose?.()
    expect(second.disposed()).toBe(1)
  })
})

describe('generated layer watcher reloads', () => {
  let dir: string
  let logs: ReturnType<typeof fakeLogger>

  beforeEach(async () => {
    dir = await tempProfile()
    await writeRecord(dir, 'gen-a')
    logs = fakeLogger()
  })

  it('deduplicates the observed generation id', async () => {
    const fake = fakeHmr()
    await registerGeneratedLayerWatcher({
      profileContext: { dir },
      hmr: fake.hmr,
      logger: logs.logger,
    })
    const refresh = fake.latest()!.refresh

    await refresh()
    expect(fake.reconciles()).toBe(0)

    await writeRecord(dir, 'gen-b')
    await refresh()
    expect(fake.reconciles()).toBe(1)

    await refresh()
    expect(fake.reconciles()).toBe(1)
  })

  it('does nothing when only the TypeScript config changes', async () => {
    const fake = fakeHmr()
    await registerGeneratedLayerWatcher({
      profileContext: { dir },
      hmr: fake.hmr,
      logger: logs.logger,
    })
    await writeFile(join(dir, 'config.ts'), 'export default {}\n', 'utf8')
    await fake.latest()!.refresh()
    expect(fake.reconciles()).toBe(0)
  })

  it('contains a malformed generation record and recovers on the next one', async () => {
    const fake = fakeHmr()
    await registerGeneratedLayerWatcher({
      profileContext: { dir },
      hmr: fake.hmr,
      logger: logs.logger,
    })
    const refresh = fake.latest()!.refresh

    await writeRaw(dir, '{ not json')
    await refresh()
    expect(fake.reconciles()).toBe(0)
    expect(logs.lines.some((line) => line.level === 'error')).toBe(true)

    await writeRecord(dir, 'gen-c')
    await refresh()
    expect(fake.reconciles()).toBe(1)
    expect(logs.lines.some((line) => line.message.includes('gen-c'))).toBe(true)
  })

  it('reports restart-required outcomes instead of claiming a hot reload', async () => {
    const fake = fakeHmr({
      warnings: [],
      pending: [{ url: 'file:///plugin.js', reason: 'host-module' }],
    })
    await registerGeneratedLayerWatcher({
      profileContext: { dir },
      hmr: fake.hmr,
      logger: logs.logger,
    })
    await writeRecord(dir, 'gen-b')
    await fake.latest()!.refresh()

    expect(fake.reconciles()).toBe(1)
    expect(logs.lines.some((line) => line.level === 'warn' && /restart/i.test(line.message))).toBe(
      true,
    )
    expect(logs.lines.some((line) => /applied/i.test(line.message))).toBe(false)
  })

  it('reports a profile-wide restart reason', async () => {
    const fake = fakeHmr({ warnings: [], pending: [], restartReason: 'package-moved' })
    await registerGeneratedLayerWatcher({
      profileContext: { dir },
      hmr: fake.hmr,
      logger: logs.logger,
    })
    await writeRecord(dir, 'gen-b')
    await fake.latest()!.refresh()
    expect(logs.lines.some((line) => /restart/i.test(line.message))).toBe(true)
  })

  it('reports an applied generation and keeps watching', async () => {
    const fake = fakeHmr({ warnings: ['row x is inactive'], pending: [] })
    await registerGeneratedLayerWatcher({
      profileContext: { dir },
      hmr: fake.hmr,
      logger: logs.logger,
    })
    await writeRecord(dir, 'gen-b')
    await fake.latest()!.refresh()
    expect(logs.lines.some((line) => /gen-b applied/i.test(line.message))).toBe(true)
    expect(logs.lines.some((line) => line.message.includes('row x is inactive'))).toBe(true)

    await writeRecord(dir, 'gen-d')
    await fake.latest()!.refresh()
    expect(fake.reconciles()).toBe(2)
  })

  it('keeps watching after a reconciliation failure', async () => {
    let fail = true
    const watches: { refresh: () => Promise<void> }[] = []
    const hmr: HmrLike = {
      watchConfig: async (_filename, refresh) => {
        watches.push({ refresh })
        return async () => {}
      },
      reconcileProfile: async () => {
        if (fail) throw new Error('reconcile exploded')
        return { warnings: [], pending: [] }
      },
    }
    await registerGeneratedLayerWatcher({ profileContext: { dir }, hmr, logger: logs.logger })
    await writeRecord(dir, 'gen-b')
    await watches[0]!.refresh()
    expect(logs.lines.some((line) => line.level === 'error')).toBe(true)

    fail = false
    await writeRecord(dir, 'gen-e')
    await watches[0]!.refresh()
    expect(logs.lines.some((line) => /gen-e applied/i.test(line.message))).toBe(true)
  })
})
describe('runtime manifest', () => {
  it('declares no DSH engine and keeps the Node engine', async () => {
    const { readFile } = await import('node:fs/promises')
    const manifest = JSON.parse(
      await readFile(join(root, 'packages/runtime/package.json'), 'utf8'),
    ) as { engines?: Record<string, string> }
    expect(manifest.engines?.dsh).toBeUndefined()
    expect(manifest.engines?.node).toBeDefined()
  })
})

describe('HMR capability guard', () => {
  it('does not register when watchConfig is missing and reports the capability', async () => {
    const dir = await tempProfile()
    await writeRecord(dir, 'gen-a')
    const { logger, lines } = fakeLogger()
    const hmr = {
      reconcileProfile: async () => ({ warnings: [], pending: [] }),
    } as unknown as HmrLike
    expect(await registerGeneratedLayerWatcher({ profileContext: { dir }, hmr, logger })).toBe(
      undefined,
    )
    expect(lines.some((line) => /watchConfig/.test(line.message))).toBe(true)
    expect(lines.some((line) => line.level === 'error')).toBe(false)
  })

  it('does not register when reconcileProfile is missing and reports the capability', async () => {
    const dir = await tempProfile()
    await writeRecord(dir, 'gen-a')
    const { logger, lines } = fakeLogger()
    const hmr = {
      watchConfig: async () => async () => {},
    } as unknown as HmrLike
    expect(await registerGeneratedLayerWatcher({ profileContext: { dir }, hmr, logger })).toBe(
      undefined,
    )
    expect(lines.some((line) => /reconcileProfile/.test(line.message))).toBe(true)
    expect(lines.some((line) => line.level === 'error')).toBe(false)
  })
})

describe('runtime version drift', () => {
  it('warns when the generation record was published with another DSH', async () => {
    const dir = await tempProfile()
    await writeRecord(dir, 'gen-a', '0.2.1-rc.2')
    const installAnchor = await writeInstallation(dir, '0.2.1-rc.5')
    const { logger, lines } = fakeLogger()
    const fake = fakeHmr()
    await registerGeneratedLayerWatcher({
      profileContext: { dir, installAnchor },
      hmr: fake.hmr,
      logger,
    })
    const warning = lines.find((line) => line.level === 'warn' && /eedsh sync/.test(line.message))
    expect(warning).toBeDefined()
    expect(warning?.message).toContain('0.2.1-rc.2')
    expect(warning?.message).toContain('0.2.1-rc.5')
  })

  it('does not warn when the record and the running installation agree', async () => {
    const dir = await tempProfile()
    await writeRecord(dir, 'gen-a', '0.2.1-rc.5')
    const installAnchor = await writeInstallation(dir, '0.2.1-rc.5')
    const { logger, lines } = fakeLogger()
    const fake = fakeHmr()
    await registerGeneratedLayerWatcher({
      profileContext: { dir, installAnchor },
      hmr: fake.hmr,
      logger,
    })
    expect(lines.some((line) => /drift|eedsh sync/.test(line.message))).toBe(false)
  })

  it('does not claim compatibility or fail when the installation version is unavailable', async () => {
    const dir = await tempProfile()
    await writeRecord(dir, 'gen-a', '0.2.1-rc.2')
    const { logger, lines } = fakeLogger()
    const fake = fakeHmr()
    const dispose = await registerGeneratedLayerWatcher({
      profileContext: { dir, installAnchor: join(dir, 'missing', 'package.json') },
      hmr: fake.hmr,
      logger,
    })
    expect(typeof dispose).toBe('function')
    expect(lines.some((line) => /eedsh sync/.test(line.message))).toBe(false)
    expect(lines.some((line) => line.level === 'error')).toBe(false)
  })
})
