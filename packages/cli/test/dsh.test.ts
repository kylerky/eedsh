import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import {
  discoverDshInstallation,
  resolveBundleLayers,
  resolveDshInstallation,
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

async function writeInstallation(parent: string, name: string, version: string): Promise<InstallationFixture> {
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

const require = createRequire(import.meta.url)

describe('dsh resolution', () => {
  it('returns the installation as a Result', () => {
    const result = resolveDshInstallation()
    expect(Result.isSuccess(result)).toBe(true)
  })

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
    await writeFile(join(notDsh, 'package.json'), JSON.stringify({ name: 'other', version: '1.0.0' }))

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
      expect(result.success.binPath).toBe(await realpath(launcher))
    }
  })
})

describe('DSH version validation', () => {
  it('accepts a supported installation and returns it', async () => {
    const rootDir = await tempDir('discovery-version-')
    const installation = await writeInstallation(rootDir, 'dsh', '0.2.2-alpha.2')
    const discovered = discoverDshInstallation({ explicit: installation.dir, env: {}, cwd: rootDir })
    if (Result.isFailure(discovered)) throw discovered.failure
    const result = validateDshVersion(discovered.success)
    expect(Result.isSuccess(result)).toBe(true)
  })

  it('rejects an unsupported installation with its version and range', async () => {
    const rootDir = await tempDir('discovery-unsupported-')
    const installation = await writeInstallation(rootDir, 'dsh', '0.3.0')
    const discovered = discoverDshInstallation({ explicit: installation.dir, env: {}, cwd: rootDir })
    if (Result.isFailure(discovered)) throw discovered.failure
    const failure = failureOf(validateDshVersion(discovered.success))
    expect(failure.code).toBe('dsh.unsupported_version')
    expect(failure.version).toBe('0.3.0')
    expect(failure.range).toBe(SUPPORTED_DSH_RANGE)
    expect(failure.message).toContain('0.3.0')
    expect(failure.message).toContain(SUPPORTED_DSH_RANGE)
  })
})