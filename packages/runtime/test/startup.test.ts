import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type InstallationAnchor, installationAnchorPath } from '../src/installation-anchor'
import { activateRuntime, type RuntimeContextLike } from '../src/startup'
import type { HmrLike, WatcherLogger } from '../src/watcher'

const root = process.cwd()

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

function fakeHmr() {
  const watches: { filename: string; refresh: () => Promise<void> }[] = []
  const hmr: HmrLike = {
    watchConfig: async (filename, refresh) => {
      watches.push({ filename, refresh })
      return async () => {}
    },
    reconcileProfile: async () => ({ warnings: [], pending: [] }),
  }
  return { hmr, watches }
}

interface FakeContext {
  readonly ctx: RuntimeContextLike
  readonly injections: (readonly string[])[]
  readonly settled: () => Promise<void>
  readonly effects: () => number
}

function fakeContext(services: Record<string, unknown>): FakeContext {
  const injections: (readonly string[])[] = []
  const effects: Promise<unknown>[] = []
  const ctx: RuntimeContextLike = {
    get: (name) => services[name],
    inject: (names, callback) => {
      injections.push(names)
      if (!names.every((name) => services[name] !== undefined)) return
      const scope = {
        get: (name: string) => services[name],
        inject: () => {},
        effect: (run: () => Promise<unknown>) => {
          effects.push(run())
        },
      }
      callback(scope as never)
    },
  }
  return {
    ctx,
    injections,
    effects: () => effects.length,
    settled: async () => {
      await Promise.all(effects)
    },
  }
}

async function tempDir(prefix: string): Promise<string> {
  await mkdir(join(root, '.tmp'), { recursive: true })
  return mkdtemp(join(root, '.tmp', prefix))
}

async function writeInstallation(
  parent: string,
  version: string,
  name = '@deepseek-ai/dsh',
): Promise<string> {
  const dir = join(parent, `dsh-${version}`)
  await mkdir(dir, { recursive: true })
  const anchor = join(dir, 'package.json')
  await writeFile(anchor, JSON.stringify({ name, version }, null, 2), 'utf8')
  return anchor
}

async function readRecord(home: string): Promise<InstallationAnchor> {
  return JSON.parse(await readFile(installationAnchorPath(home), 'utf8')) as InstallationAnchor
}

describe('runtime installation anchor recorder', () => {
  it('writes the anchor on a profile boot with HMR and keeps the watcher', async () => {
    const home = await tempDir('runtime-anchor-hmr-')
    const installAnchor = await writeInstallation(home, '0.2.1-rc.2')
    const profileDir = join(home, 'profiles', 'default')
    await mkdir(join(profileDir, '.eedsh', 'generated'), { recursive: true })
    await writeFile(
      join(profileDir, '.eedsh', 'generated', 'package.json'),
      JSON.stringify({ name: '@eedsh/generated', eedsh: { generationId: 'gen-a' } }),
    )
    const hmr = fakeHmr()
    const { logger, lines } = fakeLogger()
    const fake = fakeContext({
      profileContext: { dir: profileDir, home, installAnchor },
      hmr: hmr.hmr,
    })

    await activateRuntime(fake.ctx, { logger })
    await fake.settled()

    const record = await readRecord(home)
    expect(record).toMatchObject({
      format: 1,
      installAnchor,
      version: '0.2.1-rc.2',
      recordedBy: 'runtime',
    })
    expect(record.recordedAt).toBeDefined()
    expect(fake.injections).toEqual([['hmr']])
    expect(hmr.watches).toHaveLength(1)
    expect(lines.some((line) => line.level === 'error')).toBe(false)
  })

  it('still records the anchor when HMR is absent', async () => {
    const home = await tempDir('runtime-anchor-nohmr-')
    const installAnchor = await writeInstallation(home, '0.2.1-rc.5')
    const fake = fakeContext({
      profileContext: { dir: join(home, 'profiles', 'default'), home, installAnchor },
    })
    const { logger } = fakeLogger()

    await activateRuntime(fake.ctx, { logger })
    await fake.settled()

    const record = await readRecord(home)
    expect(record.version).toBe('0.2.1-rc.5')
    expect(fake.effects()).toBe(0)
  })

  it('writes nothing without profile context', async () => {
    const home = await tempDir('runtime-anchor-nocontext-')
    const fake = fakeContext({})
    const { logger } = fakeLogger()
    await activateRuntime(fake.ctx, { logger })
    await fake.settled()
    expect(existsSync(installationAnchorPath(home))).toBe(false)
    expect(fake.injections).toEqual([['hmr']])
  })

  it('warns and writes nothing for an invalid installAnchor', async () => {
    const home = await tempDir('runtime-anchor-invalid-')
    const other = await writeInstallation(home, '1.0.0', 'not-dsh')
    const { logger, lines } = fakeLogger()
    const fake = fakeContext({
      profileContext: { dir: join(home, 'profiles', 'default'), home, installAnchor: other },
    })

    await activateRuntime(fake.ctx, { logger })
    await fake.settled()

    expect(existsSync(installationAnchorPath(home))).toBe(false)
    expect(lines.some((line) => line.level === 'warn')).toBe(true)
    expect(lines.some((line) => line.level === 'error')).toBe(false)
  })

  it('warns without failing the profile when the anchor write fails', async () => {
    const home = await tempDir('runtime-anchor-writefail-')
    const installAnchor = await writeInstallation(home, '0.2.1-rc.2')
    const notADirectory = join(home, 'occupied')
    await writeFile(notADirectory, 'file', 'utf8')
    const { logger, lines } = fakeLogger()
    const fake = fakeContext({
      profileContext: {
        dir: join(home, 'profiles', 'default'),
        home: notADirectory,
        installAnchor,
      },
    })

    await expect(activateRuntime(fake.ctx, { logger })).resolves.toBe(false)
    await fake.settled()
    expect(lines.some((line) => line.level === 'warn')).toBe(true)
    expect(lines.some((line) => line.level === 'error')).toBe(false)
  })

  it('replaces a previous anchor after an upgrade', async () => {
    const home = await tempDir('runtime-anchor-upgrade-')
    const first = await writeInstallation(home, '0.2.1-rc.2')
    const { logger } = fakeLogger()
    const firstFake = fakeContext({
      profileContext: { dir: join(home, 'profiles', 'default'), home, installAnchor: first },
    })
    await activateRuntime(firstFake.ctx, { logger })
    await firstFake.settled()

    const second = await writeInstallation(home, '0.2.1-rc.5')
    const secondFake = fakeContext({
      profileContext: { dir: join(home, 'profiles', 'default'), home, installAnchor: second },
    })
    await activateRuntime(secondFake.ctx, { logger })
    await secondFake.settled()

    const record = await readRecord(home)
    expect(record.installAnchor).toBe(second)
    expect(record.version).toBe('0.2.1-rc.5')
  })
})
