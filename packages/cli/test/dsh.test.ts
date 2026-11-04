import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstallationAnchor } from '@eedsh/runtime/installation-anchor'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import {
  discoverDshInstallation,
  resolveBundleLayers,
  SUPPORTED_DSH_RANGE,
  supportsDshVersion,
  validateDshVersion,
} from '../src/dsh'
import type { DshFailure } from '../src/internal/effect/errors'

const root = process.cwd()
const tempRoot = join(root, 'packages/cli/.tmp')

interface InstallationFixture {
  readonly dir: string
  readonly anchor: string
  readonly bin: string
  readonly version: string
}

async function writeInstallation(
  parent: string,
  name: string,
  version: string,
): Promise<InstallationFixture> {
  const dir = join(parent, name)
  await mkdir(join(dir, 'lib'), { recursive: true })
  const anchor = join(dir, 'package.json')
  const bin = join(dir, 'lib', 'bin.js')
  await writeFile(
    anchor,
    JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: './lib/bin.js' } }, null, 2),
  )
  await writeFile(bin, '#!/usr/bin/env node\n')
  return { dir, anchor, bin, version }
}

async function tempDir(prefix: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  return mkdtemp(join(tempRoot, prefix))
}

function failureOf(result: Result.Result<unknown, DshFailure>): DshFailure {
  if (Result.isSuccess(result)) throw new Error('expected discovery to fail')
  return result.failure
}

function recordedAnchor(
  installation: InstallationFixture,
  extras: Partial<InstallationAnchor> = {},
): InstallationAnchor {
  return {
    format: 1,
    installAnchor: installation.anchor,
    version: installation.version,
    ...extras,
  }
}

/** A launcher that is a regular file, like a pnpm-generated shim. */
async function unmappableLauncher(parent: string): Promise<{ dir: string; launcher: string }> {
  const dir = join(parent, 'bin')
  await mkdir(dir, { recursive: true })
  const launcher = join(dir, 'dsh')
  await writeFile(launcher, '#!/bin/sh\nexec dsh "$@"\n')
  return { dir, launcher }
}

const require = createRequire(import.meta.url)

describe('dsh resolution', () => {
  it('returns a tagged failure for a missing bundle', () => {
    const anchor = require.resolve('@deepseek-ai/dsh/package.json')
    const result = resolveBundleLayers('@scope/definitely-missing-bundle', process.cwd(), anchor)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe('DshResolveFailure')
      expect(result.failure.packageName).toBe('@scope/definitely-missing-bundle')
    }
  })
})
describe('supported DSH range policy', () => {
  it('declares the supported range as ^0.2.1-rc.2', () => {
    expect(SUPPORTED_DSH_RANGE).toBe('^0.2.1-rc.2')
  })

  it('accepts the current release line, including prereleases', () => {
    for (const version of ['0.2.1-rc.2', '0.2.1-rc.5', '0.2.2-alpha.2', '0.2.1', '0.2.2']) {
      expect(supportsDshVersion(version), version).toBe(true)
    }
  })

  it('rejects versions outside the range', () => {
    for (const version of ['0.2.0', '0.2.1-rc.1', '0.3.0', '1.0.0', 'latest', '']) {
      expect(supportsDshVersion(version), version).toBe(false)
    }
  })
})
describe('DSH discovery precedence', () => {
  it('prefers --dsh, then the anchor, then PATH, then the project', async () => {
    const rootDir = await tempDir('discovery-')
    const explicit = await writeInstallation(rootDir, 'explicit', '0.2.1-rc.2')
    const anchor = await writeInstallation(rootDir, 'anchor', '0.2.1-rc.5')
    const pathDir = join(rootDir, 'bin')
    await mkdir(pathDir, { recursive: true })
    const pathInstall = await writeInstallation(rootDir, 'path-install', '0.2.2-alpha.2')
    await symlink(pathInstall.bin, join(pathDir, 'dsh'))
    const project = join(rootDir, 'project')
    await writeInstallation(join(project, 'node_modules', '@deepseek-ai'), 'dsh', '0.2.1')
    const env = {
      PATH: pathDir,
      EEDSH_DSH_ANCHOR: anchor.anchor,
    }

    const withExplicit = discoverDshInstallation({
      explicit: explicit.dir,
      env,
      cwd: project,
    })
    expect(Result.isSuccess(withExplicit)).toBe(true)
    if (Result.isSuccess(withExplicit)) {
      expect(withExplicit.success.version).toBe('0.2.1-rc.2')
      expect(withExplicit.success.source).toBe('explicit')
    }

    const withAnchor = discoverDshInstallation({ env, cwd: project })
    expect(Result.isSuccess(withAnchor)).toBe(true)
    if (Result.isSuccess(withAnchor)) {
      expect(withAnchor.success.version).toBe('0.2.1-rc.5')
      expect(withAnchor.success.source).toBe('anchor')
    }

    const withPath = discoverDshInstallation({ env: { PATH: pathDir }, cwd: project })
    expect(Result.isSuccess(withPath)).toBe(true)
    if (Result.isSuccess(withPath)) {
      expect(withPath.success.version).toBe('0.2.2-alpha.2')
      expect(withPath.success.source).toBe('path')
      expect(withPath.success.binPath).toBe(await realpath(join(pathDir, 'dsh')))
    }

    const withProject = discoverDshInstallation({ env: {}, cwd: project })
    expect(Result.isSuccess(withProject)).toBe(true)
    if (Result.isSuccess(withProject)) {
      expect(withProject.success.version).toBe('0.2.1')
      expect(withProject.success.source).toBe('project')
    }
  })

  it('accepts a package directory or its package.json', async () => {
    const rootDir = await tempDir('discovery-input-')
    const installation = await writeInstallation(rootDir, 'dsh', '0.2.1-rc.2')
    for (const explicit of [installation.dir, installation.anchor]) {
      const result = discoverDshInstallation({ explicit, env: {}, cwd: rootDir })
      expect(Result.isSuccess(result), explicit).toBe(true)
      if (Result.isSuccess(result)) {
        expect(result.success.installAnchor).toBe(installation.anchor)
        expect(result.success.packageDir).toBe(installation.dir)
        expect(result.success.binPath).toBe(installation.bin)
      }
    }
  })

  it('fails an invalid explicit selection instead of falling through to PATH', async () => {
    const rootDir = await tempDir('discovery-invalid-')
    const pathDir = join(rootDir, 'bin')
    await mkdir(pathDir, { recursive: true })
    const pathInstall = await writeInstallation(rootDir, 'path-install', '0.2.1-rc.2')
    await writeFile(join(pathDir, 'dsh'), pathInstall.bin)
    const notDsh = join(rootDir, 'other')
    await mkdir(notDsh, { recursive: true })
    await writeFile(
      join(notDsh, 'package.json'),
      JSON.stringify({ name: 'other', version: '1.0.0' }),
    )

    for (const explicit of [join(rootDir, 'missing'), notDsh]) {
      const failure = failureOf(
        discoverDshInstallation({ explicit, env: { PATH: pathDir }, cwd: rootDir }),
      )
      expect(failure.code).toBe('dsh.anchor_invalid')
      expect(failure.message).toContain(explicit)
    }
  })

  it('reports a tagged not-found failure naming every remedy', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'eedsh-discovery-missing-'))
    const failure = failureOf(discoverDshInstallation({ env: {}, cwd: rootDir }))
    expect(failure.code).toBe('dsh.not_found')
    expect(failure.message).toContain('--dsh')
    expect(failure.message).toContain('EEDSH_DSH_ANCHOR')
    expect(failure.message).toContain('install')
  })

  it('returns one installation object carrying anchor, launcher, version, and source', async () => {
    const rootDir = await tempDir('discovery-shape-')
    const installation = await writeInstallation(rootDir, 'dsh', '0.2.1-rc.2')
    const result = discoverDshInstallation({ explicit: installation.dir, env: {}, cwd: rootDir })
    if (Result.isFailure(result)) throw result.failure
    expect(result.success).toMatchObject({
      version: '0.2.1-rc.2',
      installAnchor: installation.anchor,
      packageDir: installation.dir,
      binPath: installation.bin,
      source: 'explicit',
    })
  })

  it('resolves a PATH launcher with a Windows-style extension', async () => {
    const rootDir = await tempDir('discovery-win-')
    const binDir = join(rootDir, 'bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(
      join(rootDir, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.5' }),
    )
    await mkdir(join(rootDir, 'lib'), { recursive: true })
    await writeFile(join(rootDir, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
    const launcher = join(binDir, 'dsh.CMD')
    await writeFile(launcher, '@echo off\n')
    const result = discoverDshInstallation({
      env: { PATH: binDir, PATHEXT: '.EXE;.CMD' },
      cwd: rootDir,
    })
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success.source).toBe('path')
      expect(result.success.version).toBe('0.2.1-rc.5')
      // The launcher's case depends on the filesystem, so compare case-insensitively
      // the way Windows would.
      expect(result.success.binPath.toLowerCase()).toBe((await realpath(launcher)).toLowerCase())
    }
  })
})

describe('DSH version validation', () => {
  it('accepts a supported installation and returns it', async () => {
    const rootDir = await tempDir('discovery-version-')
    const installation = await writeInstallation(rootDir, 'dsh', '0.2.2-alpha.2')
    const discovered = discoverDshInstallation({
      explicit: installation.dir,
      env: {},
      cwd: rootDir,
    })
    if (Result.isFailure(discovered)) throw discovered.failure
    const result = validateDshVersion(discovered.success)
    expect(Result.isSuccess(result)).toBe(true)
  })

  it('rejects an unsupported installation with its version and range', async () => {
    const rootDir = await tempDir('discovery-unsupported-')
    const installation = await writeInstallation(rootDir, 'dsh', '0.3.0')
    const discovered = discoverDshInstallation({
      explicit: installation.dir,
      env: {},
      cwd: rootDir,
    })
    if (Result.isFailure(discovered)) throw discovered.failure
    const failure = failureOf(validateDshVersion(discovered.success))
    expect(failure.code).toBe('dsh.unsupported_version')
    expect(failure.version).toBe('0.3.0')
    expect(failure.range).toBe(SUPPORTED_DSH_RANGE)
    expect(failure.message).toContain('0.3.0')
    expect(failure.message).toContain(SUPPORTED_DSH_RANGE)
  })
})

describe('recorded installation anchor', () => {
  it('resolves an unmappable pnpm shim through a valid recorded anchor', async () => {
    const rootDir = await tempDir('discovery-recorded-')
    const installation = await writeInstallation(rootDir, 'install', '0.2.1-rc.2')
    const bin = await unmappableLauncher(rootDir)
    const record = recordedAnchor(installation, { launcher: bin.launcher, manager: 'pnpm' })
    const probes: string[] = []
    const result = discoverDshInstallation({
      env: { PATH: bin.dir },
      cwd: rootDir,
      readAnchor: () => record,
      probeVersion: (launcher) => {
        probes.push(launcher)
        return '0.2.1-rc.2'
      },
    })
    if (Result.isFailure(result)) throw result.failure
    expect(result.success.version).toBe('0.2.1-rc.2')
    expect(result.success.source).toBe('recorded')
    expect(result.success.installAnchor).toBe(installation.anchor)
    expect(result.success.packageDir).toBe(installation.dir)
    expect(result.success.binPath).toBe(installation.bin)
    expect(probes).toEqual([bin.launcher])
  })

  it('keeps --dsh and EEDSH_DSH_ANCHOR ahead of the record', async () => {
    const rootDir = await tempDir('discovery-recorded-explicit-')
    const explicit = await writeInstallation(rootDir, 'explicit', '0.2.1-rc.2')
    const envAnchor = await writeInstallation(rootDir, 'env-anchor', '0.2.1-rc.5')
    const recorded = await writeInstallation(rootDir, 'recorded', '0.2.2-alpha.2')
    const bin = await unmappableLauncher(rootDir)
    const record = recordedAnchor(recorded, { launcher: bin.launcher })
    const probe = () => {
      throw new Error('the record must not be probed when an explicit selection wins')
    }

    const withExplicit = discoverDshInstallation({
      explicit: explicit.dir,
      env: { PATH: bin.dir, EEDSH_DSH_ANCHOR: envAnchor.anchor },
      cwd: rootDir,
      readAnchor: () => record,
      probeVersion: probe,
    })
    if (Result.isFailure(withExplicit)) throw withExplicit.failure
    expect(withExplicit.success.source).toBe('explicit')
    expect(withExplicit.success.version).toBe('0.2.1-rc.2')

    const withEnvAnchor = discoverDshInstallation({
      env: { PATH: bin.dir, EEDSH_DSH_ANCHOR: envAnchor.anchor },
      cwd: rootDir,
      readAnchor: () => record,
      probeVersion: probe,
    })
    if (Result.isFailure(withEnvAnchor)) throw withEnvAnchor.failure
    expect(withEnvAnchor.success.source).toBe('anchor')
    expect(withEnvAnchor.success.version).toBe('0.2.1-rc.5')
  })

  it('uses the record without a PATH launcher and never probes', async () => {
    const rootDir = await tempDir('discovery-recorded-nopath-')
    const installation = await writeInstallation(rootDir, 'install', '0.2.1-rc.2')
    let probes = 0
    const result = discoverDshInstallation({
      env: {},
      cwd: rootDir,
      readAnchor: () => recordedAnchor(installation),
      probeVersion: () => {
        probes += 1
        return '0.2.1-rc.2'
      },
    })
    if (Result.isFailure(result)) throw result.failure
    expect(result.success.source).toBe('recorded')
    expect(probes).toBe(0)
  })

  it('ignores a stale record and fails the launcher without project fallback', async () => {
    const rootDir = await tempDir('discovery-recorded-stale-')
    const installation = await writeInstallation(rootDir, 'install', '0.2.1-rc.2')
    const project = join(rootDir, 'project')
    await writeInstallation(join(project, 'node_modules', '@deepseek-ai'), 'dsh', '0.2.1-rc.2')
    const bin = await unmappableLauncher(rootDir)
    const record = recordedAnchor(installation, { launcher: join(rootDir, 'elsewhere', 'dsh') })
    let probes = 0
    const failure = failureOf(
      discoverDshInstallation({
        env: { PATH: bin.dir },
        cwd: project,
        readAnchor: () => record,
        probeVersion: () => {
          probes += 1
          return '0.2.1-rc.2'
        },
      }),
    )
    expect(failure.code).toBe('dsh.launcher_unresolved')
    expect(failure.path).toBe(bin.launcher)
    expect(failure.message).toContain(bin.launcher)
    expect(failure.message).toContain('pnpm')
    expect(failure.message).toContain('npm')
    expect(failure.message).toContain('--dsh')
    expect(failure.message).toContain('EEDSH_DSH_ANCHOR')
    expect(failure.message).toContain('eedsh sync')
    expect(probes).toBe(0)
  })

  it('ignores a record whose package no longer exists', async () => {
    const rootDir = await tempDir('discovery-recorded-missing-')
    const bin = await unmappableLauncher(rootDir)
    const failure = failureOf(
      discoverDshInstallation({
        env: { PATH: bin.dir },
        cwd: rootDir,
        readAnchor: () => ({
          format: 1,
          installAnchor: join(rootDir, 'gone', 'package.json'),
          version: '0.2.1-rc.2',
        }),
        probeVersion: () => '0.2.1-rc.2',
      }),
    )
    expect(failure.code).toBe('dsh.launcher_unresolved')
    expect(failure.message).toContain('pnpm and npm only')
  })

  it('does not fall through to a project package when a PATH launcher is unresolved', async () => {
    const rootDir = await tempDir('discovery-recorded-nofallback-')
    await writeInstallation(join(rootDir, 'node_modules', '@deepseek-ai'), 'dsh', '0.2.1-rc.2')
    const bin = await unmappableLauncher(rootDir)
    const failure = failureOf(
      discoverDshInstallation({
        env: { PATH: bin.dir },
        cwd: rootDir,
        readAnchor: () => undefined,
        probeVersion: () => undefined,
      }),
    )
    expect(failure.code).toBe('dsh.launcher_unresolved')
  })

  it('keeps project-local as the last fallback when no launcher and no record exist', async () => {
    const rootDir = await tempDir('discovery-recorded-project-')
    await writeInstallation(join(rootDir, 'node_modules', '@deepseek-ai'), 'dsh', '0.2.1-rc.2')
    const result = discoverDshInstallation({
      env: {},
      cwd: rootDir,
      readAnchor: () => undefined,
      probeVersion: () => {
        throw new Error('no launcher exists to probe')
      },
    })
    if (Result.isFailure(result)) throw result.failure
    expect(result.success.source).toBe('project')
  })

  it('rejects the record when dsh --version differs', async () => {
    const rootDir = await tempDir('discovery-recorded-mismatch-')
    const installation = await writeInstallation(rootDir, 'install', '0.2.1-rc.2')
    const bin = await unmappableLauncher(rootDir)
    const failure = failureOf(
      discoverDshInstallation({
        env: { PATH: bin.dir },
        cwd: rootDir,
        readAnchor: () => recordedAnchor(installation, { launcher: bin.launcher }),
        probeVersion: () => '0.2.1-rc.5',
      }),
    )
    expect(failure.code).toBe('dsh.launcher_unresolved')
    expect(failure.message).toContain('0.2.1-rc.5')
    expect(failure.message).toContain('0.2.1-rc.2')
  })

  it('rejects the record when the launcher probe fails', async () => {
    const rootDir = await tempDir('discovery-recorded-probefail-')
    const installation = await writeInstallation(rootDir, 'install', '0.2.1-rc.2')
    const bin = await unmappableLauncher(rootDir)
    const failure = failureOf(
      discoverDshInstallation({
        env: { PATH: bin.dir },
        cwd: rootDir,
        readAnchor: () => recordedAnchor(installation, { launcher: bin.launcher }),
        probeVersion: () => undefined,
      }),
    )
    expect(failure.code).toBe('dsh.launcher_unresolved')
    expect(failure.message).toContain('dsh --version')
  })

  it('does not probe when no record exists', async () => {
    const rootDir = await tempDir('discovery-recorded-noprobe-')
    const bin = await unmappableLauncher(rootDir)
    let probes = 0
    const failure = failureOf(
      discoverDshInstallation({
        env: { PATH: bin.dir },
        cwd: rootDir,
        readAnchor: () => undefined,
        probeVersion: () => {
          probes += 1
          return undefined
        },
      }),
    )
    expect(failure.code).toBe('dsh.launcher_unresolved')
    expect(probes).toBe(0)
  })
})
