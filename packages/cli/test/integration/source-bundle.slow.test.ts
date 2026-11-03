/**
 * End-to-end slow coverage for a real source bundle. The fixture repository
 * gitignores its build output, so the sync must clone it, run the declared
 * defaults (install and build), verify the built entry points, link the
 * checkout into the profile, and let the bundle's patch layer compose through
 * the installed DSH composer.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DshBridge } from '@eedsh/config'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Layer } from 'effect'
import * as Result from 'effect/Result'
import * as yaml from 'js-yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runEedsh } from '../../src/cli'
import {
  DshInstallation,
  PackageManager,
  Preflight,
  SyncLock,
} from '../../src/internal/effect/services'
import { composePreflightLayers, type PreflightLayer } from '../../src/preflight'
import { sourceCheckoutDir, sourceKey } from '../../src/provision/source'
import { clearTestBridge, installTestBridge } from '../support/bridge'
import { fakeDsh, fakePackageManager, fakePreflight, fakeSyncLock } from '../support/fakes'
import { createSourceRepository, SOURCE_BUNDLE_NAME } from '../support/source-fixture'

const root = process.cwd()
const tempRoot = join(root, 'packages/cli/.tmp')
const version = '0.2.1-rc.2'

function sourceBundleConfig(url: string): string {
  return `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('work', (profile) => {
    profile
      .bundle(${JSON.stringify(SOURCE_BUNDLE_NAME)})
      .source(${JSON.stringify(SOURCE_BUNDLE_NAME)}, { from: ${JSON.stringify(url)} })
      .generated()
      .layer('configured', (layer) => {
        layer.override('source-bundle-panel', { label: 'configured' })
      })
  })
  .build()
`
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

beforeAll(async () => {
  await installTestBridge()
})

afterAll(() => {
  clearTestBridge()
})

describe('source bundle slow integration', () => {
  it('provisions, builds, links, and composes a real source bundle', async () => {
    await mkdir(tempRoot, { recursive: true })
    const parent = await mkdtemp(join(tempRoot, 'source-bundle-'))
    const home = join(parent, 'home')
    const repository = await createSourceRepository(parent)
    const dshDir = await writeDsh(parent)

    const committed = await readFile(join(repository.dir, 'package.json'), 'utf8')
    expect(committed).toContain('"build": "node build.mjs"')
    expect(existsSync(join(repository.dir, 'lib'))).toBe(false)

    const configDir = join(parent, 'config')
    await mkdir(configDir, { recursive: true })
    const configPath = join(configDir, 'config.ts')
    await writeFile(configPath, sourceBundleConfig(repository.url))

    const services = () =>
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(PackageManager, fakePackageManager().shape),
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

    const key = sourceKey({ from: repository.url })
    const checkoutDir = sourceCheckoutDir(home, key)
    const link = `link:${checkoutDir}`
    const profileDir = join(home, 'profiles', 'work')

    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies[SOURCE_BUNDLE_NAME]).toBe(link)
    expect(manifest.dsh.profile.bundles).toContain(SOURCE_BUNDLE_NAME)

    // Preparation built the gitignored output in the checkout.
    expect(existsSync(join(checkoutDir, 'lib', 'index.js'))).toBe(true)
    expect(existsSync(join(checkoutDir, 'lib', 'client.js'))).toBe(true)
    const packageManifest = JSON.parse(
      await readFile(join(checkoutDir, 'package.json'), 'utf8'),
    ) as {
      name: string
      dsh: { client: unknown }
    }
    expect(packageManifest.name).toBe(SOURCE_BUNDLE_NAME)
    expect(packageManifest.dsh.client).toBeDefined()

    const generation = JSON.parse(
      await readFile(join(profileDir, '.eedsh', 'generated', 'package.json'), 'utf8'),
    ) as { eedsh: { generationId: string } }
    expect(generation.eedsh.generationId).toMatch(/^[0-9a-f]{64}$/)

    // The fixture's bundle patch composes with the profile's configuration.
    const bundlePatches = yaml.load(
      await readFile(join(checkoutDir, 'cordis.patch.yml'), 'utf8'),
    ) as Record<string, unknown>[]
    const plan = JSON.parse(await readFile(join(profileDir, '.eedsh', 'plan.json'), 'utf8')) as {
      layers: { patches: Record<string, unknown>[] }[]
    }
    const layers: PreflightLayer[] = [
      { label: `bundle:${SOURCE_BUNDLE_NAME}`, patches: bundlePatches },
      {
        label: 'generated #1',
        patches: plan.layers[0]?.patches ?? [],
        generated: { position: 1, label: 'configured', sites: [] },
      },
    ]
    const composition = composePreflightLayers(layers)
    expect(composition.warnings).toEqual([])
    expect(composition.entries.find((entry) => entry.id === 'source-bundle-panel')).toMatchObject({
      id: 'source-bundle-panel',
      name: '@fixture/source-bundle-plugin',
      config: { label: 'configured' },
    })
  })
})
