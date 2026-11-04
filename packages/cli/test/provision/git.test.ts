import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PlanSource } from '@eedsh/plan'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Layer } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { ChildProcessSpawner } from 'effect/process'
import { describe, expect, it } from 'vitest'
import { SyncLock } from '../../src/internal/effect/services'
import type { ProvisionCommand } from '../../src/provision/command'
import { provisionSource } from '../../src/provision/git'
import type { SourceRecord } from '../../src/provision/record'
import {
  sourceCheckoutDir,
  sourceKey,
  sourceLockPath,
  sourceStatePath,
} from '../../src/provision/source'
import { failureOf } from '../support/effect'
import { fakeChildProcessSpawner, fakeSyncLock, memoryFileSystem } from '../support/fakes'

const home = '/dsh-home'
const configDir = '/work/profiles/work'
const name = '@scope/plugin'
const remote = 'https://example.test/acme/bundle.git'
const commit = 'a'.repeat(40)

const defaults: PlanSource = {
  from: remote,
  ref: 'main',
  prepare: [
    ['pnpm', 'install'],
    ['pnpm', 'run', 'build'],
  ],
}

interface Call {
  readonly command: string
  readonly args: string[]
  readonly cwd: string
}

/** A command seam that records calls and resolves a fixed remote commit. */
function fakeCommand(setup: { failStep?: number } = {}) {
  const calls: Call[] = []
  let preparation = 0
  const command: ProvisionCommand = (executable, args, options) => {
    calls.push({ command: executable, args: [...args], cwd: options.cwd })
    if (executable === 'git' && args[0] === 'ls-remote') {
      return Effect.succeed({ status: 0, stdout: `${commit}\tHEAD\n`, stderr: '' })
    }
    if (executable !== 'git') {
      const index = preparation
      preparation += 1
      if (index === setup.failStep) {
        return Effect.succeed({ status: 1, stdout: '', stderr: 'boom' })
      }
    }
    return Effect.succeed({ status: 0, stdout: '', stderr: '' })
  }
  return { calls, command }
}

/** A command seam whose remote is unreachable. */
function offlineCommand() {
  const calls: Call[] = []
  const command: ProvisionCommand = (executable, args, options) => {
    calls.push({ command: executable, args: [...args], cwd: options.cwd })
    if (executable === 'git' && args[0] === 'ls-remote') {
      return Effect.succeed({
        status: 128,
        stdout: '',
        stderr: 'Could not resolve host: example.test',
      })
    }
    return Effect.succeed({ status: 0, stdout: '', stderr: '' })
  }
  return { calls, command }
}

const checkoutDir = sourceCheckoutDir(home, sourceKey(defaults))
const statePath = sourceStatePath(home, sourceKey(defaults))

/** A valid provisioned package manifest and its main entry. */
function gitFiles(): Record<string, string> {
  return {
    [join(checkoutDir, 'package.json')]: JSON.stringify({ name, main: './lib/index.js' }),
    [join(checkoutDir, 'lib', 'index.js')]: 'export {}\n',
  }
}

/** A record matching the default declaration, with optional overrides. */
function recordOf(overrides: Partial<SourceRecord> = {}): string {
  return JSON.stringify({
    format: 1,
    name,
    from: remote,
    ref: 'main',
    commit,
    prepare: defaults.prepare,
    preparedAt: '2026-11-03T08:00:00.000Z',
    ...overrides,
  })
}

/** A file system already holding one provisioned checkout and record. */
function seeded(overrides: Partial<SourceRecord> = {}) {
  return memoryFileSystem(
    { ...gitFiles(), [statePath]: recordOf(overrides) },
    {
      directories: [checkoutDir],
    },
  )
}

type Lock = ReturnType<typeof fakeSyncLock>

function provide(fs: ReturnType<typeof memoryFileSystem>, lock: Lock = fakeSyncLock()) {
  return Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fs.fs),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fakeChildProcessSpawner().spawner),
    Layer.succeed(SyncLock, lock.shape),
  )
}

interface RunOptions {
  readonly lock?: Lock
  readonly rebuild?: boolean
  readonly noBuild?: boolean
}

function run(
  command: ProvisionCommand,
  fs = memoryFileSystem(gitFiles()),
  declaration: PlanSource = defaults,
  options: RunOptions = {},
) {
  return provisionSource({
    home,
    configDir,
    name,
    declaration,
    command,
    ...(options.rebuild === undefined ? {} : { rebuild: options.rebuild }),
    ...(options.noBuild === undefined ? {} : { noBuild: options.noBuild }),
  }).pipe(Effect.provide(provide(fs, options.lock)))
}

describe('git source preparation', () => {
  it('runs the default steps in order with the checkout as the working directory', async () => {
    const fs = memoryFileSystem(gitFiles())
    const fake = fakeCommand()
    const result = await Effect.runPromise(run(fake.command, fs))

    expect(result.prepared).toBe(true)
    expect(result.commit).toBe(commit)
    expect(result.prepare).toEqual(defaults.prepare)

    const preparation = fake.calls.filter((call) => call.command !== 'git')
    expect(preparation).toEqual([
      { command: 'pnpm', args: ['install'], cwd: checkoutDir },
      { command: 'pnpm', args: ['run', 'build'], cwd: checkoutDir },
    ])
  })

  it('resolves the ref against the remote before preparing', async () => {
    const fake = fakeCommand()
    await Effect.runPromise(run(fake.command))

    expect(fake.calls[0]).toEqual({
      command: 'git',
      args: ['ls-remote', remote, 'main'],
      cwd: configDir,
    })
  })

  it('prepares a fresh checkout once', async () => {
    const fake = fakeCommand()
    await Effect.runPromise(run(fake.command))

    expect(fake.calls.filter((call) => call.args[0] === 'clone')).toHaveLength(1)
    expect(fake.calls.filter((call) => call.args[0] === 'fetch')).toHaveLength(0)
    const preparation = fake.calls.filter((call) => call.command !== 'git')
    expect(preparation).toHaveLength(2)
  })

  it('stops at a failing step and names the step and status', async () => {
    const fs = memoryFileSystem(gitFiles())
    const fake = fakeCommand({ failStep: 0 })
    const failure = await failureOf(run(fake.command, fs))

    expect(failure._tag).toBe('ProvisionFailure')
    expect(failure.code).toBe('provision.command_failed')
    expect(failure.packageName).toBe(name)
    expect(failure.command).toEqual(['pnpm', 'install'])
    expect(failure.status).toBe(1)
    expect(failure.message).toContain('pnpm install')
    expect(failure.message).toContain('status 1')

    const preparation = fake.calls.filter((call) => call.command !== 'git')
    expect(preparation).toEqual([{ command: 'pnpm', args: ['install'], cwd: checkoutDir }])
  })
})

describe('git source staleness', () => {
  it('prepares nothing when the resolved commit is unchanged', async () => {
    const fs = seeded()
    const fake = fakeCommand()
    const result = await Effect.runPromise(run(fake.command, fs))

    expect(result.commit).toBe(commit)
    expect(result.prepared).toBe(false)
    expect(result.changed).toBe(false)
    expect(fake.calls.filter((call) => call.command !== 'git')).toEqual([])
    expect(fake.calls.filter((call) => call.args[0] === 'clone')).toHaveLength(0)
    expect(fake.calls.filter((call) => call.args[0] === 'fetch')).toHaveLength(0)
    expect(fake.calls.filter((call) => call.args[0] === 'reset')).toHaveLength(0)
    expect(fs.writeCount()).toBe(0)
  })

  it('fetches, resets, and prepares again when the ref moved', async () => {
    const previous = 'b'.repeat(40)
    const fs = seeded({ commit: previous })
    const fake = fakeCommand()
    const result = await Effect.runPromise(run(fake.command, fs))

    expect(result.commit).toBe(commit)
    expect(result.prepared).toBe(true)
    expect(result.changed).toBe(true)
    expect(fake.calls.filter((call) => call.command === 'git').map((call) => call.args)).toEqual([
      ['ls-remote', remote, 'main'],
      ['fetch', '--force', '--tags', 'origin'],
      ['reset', '--hard', commit],
    ])
    expect(fake.calls.filter((call) => call.command !== 'git')).toHaveLength(2)
    expect(JSON.parse(fs.files.get(statePath) ?? '{}')).toMatchObject({ commit })
  })

  it('prepares again when the declared steps changed but the commit did not', async () => {
    const fs = seeded({ prepare: [['pnpm', 'install', '--frozen-lockfile']] })
    const fake = fakeCommand()
    const result = await Effect.runPromise(run(fake.command, fs))

    expect(result.prepared).toBe(true)
    expect(result.changed).toBe(true)
    expect(fake.calls.filter((call) => call.args[0] === 'fetch')).toHaveLength(0)
    expect(fake.calls.filter((call) => call.args[0] === 'reset')).toHaveLength(0)
    expect(fake.calls.filter((call) => call.command !== 'git')).toEqual([
      { command: 'pnpm', args: ['install'], cwd: checkoutDir },
      { command: 'pnpm', args: ['run', 'build'], cwd: checkoutDir },
    ])
  })
})

describe('local checkout provisioning', () => {
  it('reads a checkout with no steps and never writes to it', async () => {
    const root = await mkdtemp(join(process.cwd(), 'packages/cli/.tmp', 'provision-local-'))
    const checkout = join(root, 'acme-bundle')
    await mkdir(join(checkout, 'lib'), { recursive: true })
    await writeFile(
      join(checkout, 'package.json'),
      JSON.stringify({ name, main: './lib/index.js' }, null, 2),
    )
    const file = join(checkout, 'lib', 'index.js')
    await writeFile(file, 'export {}\n')
    const before = await stat(file)
    const manifest = await readFile(join(checkout, 'package.json'), 'utf8')

    const calls: Call[] = []
    const command: ProvisionCommand = (executable, args, options) => {
      calls.push({ command: executable, args: [...args], cwd: options.cwd })
      return Effect.succeed({ status: 0, stdout: '', stderr: '' })
    }
    const result = await Effect.runPromise(
      provisionSource({
        home: join(root, 'home'),
        configDir: root,
        name,
        declaration: { from: checkout, prepare: [] },
        command,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, Layer.succeed(SyncLock, fakeSyncLock().shape)),
        ),
      ),
    )

    expect(result.kind).toBe('local')
    expect(result.prepared).toBe(false)
    expect(calls).toEqual([])
    const after = await stat(file)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.mode).toBe(before.mode)
    expect(await readFile(join(checkout, 'package.json'), 'utf8')).toBe(manifest)
    expect(existsSync(join(root, 'home', '.local'))).toBe(false)
  })
})

describe('provisioning controls', () => {
  it('--rebuild forces preparation for an unchanged source', async () => {
    const fs = seeded()
    const fake = fakeCommand()
    const result = await Effect.runPromise(run(fake.command, fs, defaults, { rebuild: true }))

    expect(result.prepared).toBe(true)
    expect(result.changed).toBe(true)
    expect(fake.calls.filter((call) => call.args[0] === 'fetch')).toHaveLength(0)
    expect(fake.calls.filter((call) => call.args[0] === 'reset')).toHaveLength(0)
    expect(fake.calls.filter((call) => call.command !== 'git')).toHaveLength(2)
  })

  it('--no-build fails naming the source and the commands it would run', async () => {
    const fs = seeded({ commit: 'b'.repeat(40) })
    const fake = fakeCommand()
    const failure = await failureOf(run(fake.command, fs, defaults, { noBuild: true }))

    expect(failure._tag).toBe('ProvisionFailure')
    expect(failure.code).toBe('provision.no_build')
    expect(failure.packageName).toBe(name)
    expect(failure.message).toContain(name)
    expect(failure.message).toContain('pnpm install')
    expect(failure.message).toContain('pnpm run build')
    expect(fake.calls.filter((call) => call.command !== 'git')).toEqual([])
    expect(fake.calls.filter((call) => call.args[0] === 'fetch')).toHaveLength(0)
    expect(fake.calls.filter((call) => call.args[0] === 'reset')).toHaveLength(0)
  })

  it('--no-build succeeds when nothing needs preparation', async () => {
    const fs = seeded()
    const fake = fakeCommand()
    const result = await Effect.runPromise(run(fake.command, fs, defaults, { noBuild: true }))

    expect(result.prepared).toBe(false)
    expect(fake.calls.filter((call) => call.command !== 'git')).toEqual([])
  })
})

describe('per-source lock', () => {
  it('serializes provisioning on the per-source lock', async () => {
    const lock = fakeSyncLock()
    const fs = seeded()
    const key = sourceKey(defaults)
    const path = sourceLockPath(home, key)
    const held = await Effect.runPromise(lock.shape.acquire(path))

    const blocked = fakeCommand()
    const failure = await failureOf(run(blocked.command, fs, defaults, { lock }))
    expect(failure._tag).toBe('SyncLocked')
    expect(failure.lockPath).toBe(path)
    expect(blocked.calls).toEqual([])
    await Effect.runPromise(held.release)

    const fake = fakeCommand()
    const result = await Effect.runPromise(run(fake.command, fs, defaults, { lock }))
    expect(result.prepared).toBe(false)
    expect(lock.isHeld()).toBe(false)
    expect(lock.acquires).toContain(path)
  })

  it('derives one lock path per source key', () => {
    const other = { ...defaults, ref: 'next' }
    expect(sourceLockPath(home, sourceKey(defaults))).not.toBe(
      sourceLockPath(home, sourceKey(other)),
    )
    expect(sourceLockPath(home, sourceKey(defaults))).toBe(
      join(home, '.local', 'locks', `${sourceKey(defaults)}.lock`),
    )
  })
})

describe('offline acquisition', () => {
  it('keeps the recorded commit and warns when the remote is unreachable', async () => {
    const fs = seeded()
    const offline = offlineCommand()
    const result = await Effect.runPromise(run(offline.command, fs))

    expect(result.commit).toBe(commit)
    expect(result.prepared).toBe(false)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain(remote)
    expect(result.warnings[0]).toContain(commit)
    expect(offline.calls).toEqual([
      { command: 'git', args: ['ls-remote', remote, 'main'], cwd: configDir },
    ])
  })

  it('fails naming the source when the remote is unreachable and nothing is provisioned', async () => {
    const offline = offlineCommand()
    const failure = await failureOf(run(offline.command, memoryFileSystem()))

    expect(failure._tag).toBe('ProvisionFailure')
    expect(failure.code).toBe('provision.fetch_failed')
    expect(failure.packageName).toBe(name)
    expect(failure.message).toContain(name)
    expect(failure.message).toContain(remote)
  })
})
