/**
 * End-to-end first-sync bootstrap through a pnpm-shaped launcher. The
 * environment cannot install a real global pnpm package without network, so
 * this test uses a recorded pnpm metadata fixture (the install path and JSON
 * shape `pnpm list -g --depth=0 --json` produces) and a pnpm-style regular
 * file shim. The metadata command runs through the normal injectable runner;
 * discovery, anchor validation, anchor writing, and publication are real.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DshBridge } from '@eedsh/config'
import type { InstallationAnchor } from '@eedsh/runtime/installation-anchor'
import { Layer } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { ChildProcessSpawner } from 'effect/process'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { runEedsh } from '../../src/cli'
import type { CommandRunner } from '../../src/command-runner'
import {
  DshInstallation,
  PackageManager,
  Preflight,
  SyncLock,
} from '../../src/internal/effect/services'
import {
  fakeChildProcessSpawner,
  fakeDsh,
  fakePackageManager,
  fakePreflight,
  fakeSyncLock,
  memoryFileSystem,
} from '../support/fakes'

const root = process.cwd()
const fixture = join(root, 'packages/cli/test/fixtures/basic/config.ts')
const version = '0.2.1-rc.2'

async function tempDir(prefix: string): Promise<string> {
  await mkdir(join(root, 'packages/cli/.tmp'), { recursive: true })
  return mkdtemp(join(root, 'packages/cli/.tmp', prefix))
}

async function writeGlobalInstallation(home: string): Promise<{
  dir: string
  launcher: string
}> {
  const dir = join(home, 'pnpm-global', 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(join(dir, 'lib'), { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: './lib/bin.js' } }),
  )
  await writeFile(join(dir, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  const binDir = join(home, 'pnpm-bin')
  await mkdir(binDir, { recursive: true })
  const launcher = join(binDir, 'dsh')
  await writeFile(
    launcher,
    '#!/bin/sh\nexec node "$(dirname "$0")/../pnpm-global/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n',
  )
  return { dir, launcher }
}

describe('first-sync bootstrap integration', () => {
  it('bootstraps a pnpm shim and publishes without --dsh', async () => {
    const home = await tempDir('first-sync-home-')
    const installation = await writeGlobalInstallation(home)
    const calls: { command: string; args: readonly string[] }[] = []
    const runner: CommandRunner = (command, args) => {
      calls.push({ command, args })
      if (args[0] === '--version') return { status: 0, stdout: `${version}\n`, stderr: '' }
      if (command === 'pnpm' && args[0] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              path: join(home, 'pnpm-global'),
              dependencies: {
                '@deepseek-ai/dsh': { version, path: installation.dir },
              },
            },
          ]),
          stderr: '',
        }
      }
      return { status: 1, stdout: '', stderr: 'unavailable' }
    }

    const fs = memoryFileSystem()
    const services = () =>
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, fs.fs),
        Layer.succeed(PackageManager, fakePackageManager().shape),
        Layer.succeed(DshInstallation, fakeDsh().shape),
        Layer.succeed(Preflight, fakePreflight().shape),
        Layer.succeed(SyncLock, fakeSyncLock().shape),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fakeChildProcessSpawner().spawner),
      )
    const out: string[] = []
    const err: string[] = []
    const options = {
      env: {
        DSH_HOME: home,
        PATH: join(home, 'pnpm-bin'),
        XDG_CONFIG_HOME: join(home, 'xdg'),
      },
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      services,
      commandRunner: runner,
      loadDshBridge: async () => Result.succeed({} as DshBridge),
    }

    expect(await runEedsh(['sync', '--config', fixture], options)).toBe(0)
    const manifestPath = join(
      home,
      'profiles',
      'cli-fixture',
      '.eedsh',
      'generated',
      'package.json',
    )
    expect(fs.files.has(manifestPath)).toBe(true)
    expect(out.join('\n')).toContain('published profile cli-fixture')
    expect(err.join('\n')).not.toContain('dsh.launcher_unresolved')

    const anchorPath = join(home, '.local', 'state', 'installation.json')
    expect(existsSync(anchorPath)).toBe(true)
    if (process.platform !== 'win32') expect((await stat(anchorPath)).mode & 0o077).toBe(0)
    const anchor = JSON.parse(await readFile(anchorPath, 'utf8')) as InstallationAnchor
    expect(anchor).toMatchObject({
      format: 1,
      installAnchor: join(installation.dir, 'package.json'),
      version,
      launcher: installation.launcher,
      manager: 'pnpm',
      recordedBy: 'sync',
    })
    expect(calls.filter((call) => call.command === 'pnpm')).toHaveLength(1)
    const managerQueries = () =>
      calls.filter((call) => call.command === 'pnpm' || call.command === 'npm').length
    const queriesAfterFirstSync = managerQueries()
    expect(queriesAfterFirstSync).toBe(2)

    expect(await runEedsh(['sync', '--config', fixture], options)).toBe(0)
    expect(managerQueries()).toBe(queriesAfterFirstSync)
    expect(
      calls.some((call) => call.command === installation.launcher && call.args[0] === '--version'),
    ).toBe(true)
  })
})
