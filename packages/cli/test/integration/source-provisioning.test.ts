/**
 * End-to-end source provisioning through `eedsh sync`. The config, the git
 * repository, the DSH installation, the profile, and the DSH home are real
 * directories; packages, DSH bundle composition, preflight, and locking are
 * injected fakes. A `file://` declaration is a git source, so the repository is
 * cloned, verified, linked into the profile manifest, and published.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DshBridge } from '@eedsh/config'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Layer } from 'effect'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { runEedsh } from '../../src/cli'
import {
  DshInstallation,
  PackageManager,
  Preflight,
  SyncLock,
} from '../../src/internal/effect/services'
import { sourceKey, sourceLinkSpec } from '../../src/provision/source'
import { fakeDsh, fakePackageManager, fakePreflight, fakeSyncLock } from '../support/fakes'

const root = process.cwd()
const tempRoot = join(root, 'packages/cli/.tmp')
const SOURCE_NAME = '@fixture/source-bundle'
const version = '0.2.1-rc.2'

function sourceConfig(url: string): string {
  return `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('work', (profile) => {
    profile
      .generated()
      .source(${JSON.stringify(SOURCE_NAME)}, { from: ${JSON.stringify(url)}, prepare: [] })
  })
  .build()
`
}

function plainConfig(): string {
  return `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('work', (profile) => {
    profile.generated()
  })
  .build()
`
}

/** A git repository with a built package, committed in place. */
async function writeRepository(parent: string): Promise<string> {
  const repo = join(parent, 'source-repo')
  await mkdir(join(repo, 'lib'), { recursive: true })
  await writeFile(
    join(repo, 'package.json'),
    `${JSON.stringify(
      {
        name: SOURCE_NAME,
        version: '1.0.0',
        main: './lib/index.js',
        exports: { '.': { default: './lib/index.js' } },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(join(repo, 'lib', 'index.js'), 'export const value = 1\n')
  await writeFile(
    join(repo, 'cordis.patch.yml'),
    "- insert:\n    - id: source-row\n      name: '@fixture/source-plugin'\n",
  )
  execFileSync('git', ['init', repo], { encoding: 'utf8' })
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  git('add', '.')
  git('-c', 'user.email=eedsh@example.test', '-c', 'user.name=eedsh', 'commit', '-m', 'init')
  return repo
}

/** A supported DSH installation directory. */
async function writeDsh(parent: string): Promise<string> {
  const dir = join(parent, 'dsh')
  await mkdir(join(dir, 'lib'), { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: './lib/bin.js' } }),
  )
  await writeFile(join(dir, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  return dir
}

describe('source provisioning integration', () => {
  it('clones, verifies, links, and publishes a file URL source', async () => {
    await mkdir(tempRoot, { recursive: true })
    const parent = await mkdtemp(join(tempRoot, 'source-provisioning-'))
    const home = join(parent, 'home')
    const repo = await writeRepository(parent)
    const dshDir = await writeDsh(parent)
    const configDir = join(parent, 'config')
    await mkdir(configDir, { recursive: true })
    const configPath = join(configDir, 'config.ts')
    const url = pathToFileURL(repo).href
    await writeFile(configPath, sourceConfig(url))

    const packages = fakePackageManager()
    const services = () =>
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(PackageManager, packages.shape),
        Layer.succeed(DshInstallation, fakeDsh().shape),
        Layer.succeed(Preflight, fakePreflight().shape),
        Layer.succeed(SyncLock, fakeSyncLock().shape),
      )
    const out: string[] = []
    const err: string[] = []
    const options = {
      env: {
        DSH_HOME: home,
        XDG_CONFIG_HOME: join(parent, 'xdg'),
        HOME: parent,
      },
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      services,
      loadDshBridge: async () => Result.succeed({} as DshBridge),
    }

    expect(await runEedsh(['sync', '--config', configPath, '--dsh', dshDir], options)).toBe(0)
    expect(err.join('\n')).toBe('')

    const key = sourceKey({ from: url })
    const checkoutDir = join(home, '.local', 'sources', key)
    const link = sourceLinkSpec(checkoutDir)
    const profileDir = join(home, 'profiles', 'work')
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(manifest.dependencies[SOURCE_NAME]).toBe(link)
    expect(JSON.parse(await readFile(join(checkoutDir, 'package.json'), 'utf8')).name).toBe(
      SOURCE_NAME,
    )

    const generation = JSON.parse(
      await readFile(join(profileDir, '.eedsh', 'generated', 'package.json'), 'utf8'),
    ) as { eedsh: { generationId: string; packages: Record<string, string> } }
    expect(generation.eedsh.generationId).toMatch(/^[0-9a-f]{64}$/)
    expect(generation.eedsh.packages[SOURCE_NAME]).toBe(link)
    expect(
      existsSync(
        join(profileDir, '.eedsh', 'generated', 'plans', `${generation.eedsh.generationId}.json`),
      ),
    ).toBe(true)

    const state = JSON.parse(
      await readFile(join(home, '.local', 'state', 'sources', `${key}.json`), 'utf8'),
    ) as { commit: string; prepare: unknown[] }
    expect(state.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(state.prepare).toEqual([])

    await new Promise((resolve) => setTimeout(resolve, 10))
    await writeFile(configPath, plainConfig())
    expect(await runEedsh(['sync', '--config', configPath, '--dsh', dshDir], options)).toBe(0)

    const updated = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(updated.dependencies).not.toHaveProperty(SOURCE_NAME)
    expect(existsSync(checkoutDir)).toBe(true)
  })
})
