import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect } from 'effect'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { type DiscoveryContext, discoverDshInstallation } from '../src/dsh'
import { loadDshBridge } from '../src/dsh-bridge'

/** Discovery seams for a test that selects the installation explicitly. */
const offlineContext: DiscoveryContext = {
  readAnchor: () => Effect.succeed(undefined),
  probeVersion: () => Effect.succeed(undefined),
}

const CAPABILITIES = [
  'resolveProfileDir',
  'resolveBundleDir',
  'readProfileManifest',
  'bundlePatchFiles',
  'loadOverlayPatches',
  'composeEntries',
] as const

async function fakeInstallation(
  capabilities: readonly string[] = CAPABILITIES,
  version = '0.2.1-rc.5',
): Promise<{ anchor: string; packageDir: string; binPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'eedsh-bridge-install-'))
  await mkdir(join(dir, 'lib'), { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version }, null, 2),
  )
  await writeFile(join(dir, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  const boot = join(dir, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  await mkdir(boot, { recursive: true })
  await writeFile(
    join(boot, 'package.json'),
    JSON.stringify({
      name: '@deepseek-ai/dsh-app-boot',
      version,
      type: 'module',
      main: 'index.js',
    }),
  )
  const exports = capabilities
    .map((name) => `export function ${name}() { return '${name}' }`)
    .join('\n')
  await writeFile(join(boot, 'index.js'), `${exports}\n`)
  return {
    anchor: join(dir, 'package.json'),
    packageDir: dir,
    binPath: join(dir, 'lib', 'bin.js'),
  }
}

async function installationOf(capabilities?: readonly string[], version?: string) {
  const fake = await fakeInstallation(capabilities, version)
  const discovered = await Effect.runPromise(
    discoverDshInstallation(
      {
        explicit: fake.packageDir,
        env: {},
        cwd: fake.packageDir,
      },
      offlineContext,
    ).pipe(Effect.provide(NodeServices.layer)),
  )
  if (Result.isFailure(discovered)) throw discovered.failure
  return discovered.success
}

describe('DSH capability bridge', () => {
  it('loads app-boot from the selected installation and returns the bridge value', async () => {
    const installation = await installationOf(undefined, '0.2.1-rc.5')
    const loaded = await loadDshBridge(installation)
    expect(Result.isSuccess(loaded)).toBe(true)
    if (Result.isFailure(loaded)) throw loaded.failure
    expect(loaded.success.version).toBe('0.2.1-rc.5')
    expect(loaded.success.installation.installAnchor).toBe(installation.installAnchor)
    for (const capability of CAPABILITIES) {
      expect(typeof (loaded.success as unknown as Record<string, unknown>)[capability]).toBe(
        'function',
      )
    }
  })

  it('validates all six required capabilities and names a missing one', async () => {
    const installation = await installationOf(
      CAPABILITIES.filter((name) => name !== 'composeEntries'),
    )
    const loaded = await loadDshBridge(installation)
    expect(Result.isFailure(loaded)).toBe(true)
    if (Result.isFailure(loaded)) {
      expect(loaded.failure.code).toBe('dsh.capability_missing')
      expect(loaded.failure.capability).toBe('composeEntries')
      expect(loaded.failure.message).toContain('composeEntries')
    }
  })

  it('fails when the installation does not ship app-boot', async () => {
    const installation = await installationOf([])
    const boot = join(installation.packageDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
    await writeFile(
      join(boot, 'package.json'),
      JSON.stringify({
        name: '@deepseek-ai/dsh-app-boot',
        version: '0.2.1-rc.5',
        main: 'missing.js',
      }),
    )
    const { rm } = await import('node:fs/promises')
    await rm(join(boot, 'index.js'), { force: true })
    const loaded = await loadDshBridge(installation)
    expect(Result.isFailure(loaded)).toBe(true)
    if (Result.isFailure(loaded)) expect(loaded.failure.code).toBe('dsh.bridge_unavailable')
  })

  it('installs no process-global bridge state', async () => {
    const installation = await installationOf()
    expect(Result.isSuccess(await loadDshBridge(installation))).toBe(true)
    const slot = Symbol.for('@eedsh/config.dsh-bridge')
    expect((globalThis as Record<PropertyKey, unknown>)[slot]).toBeUndefined()
  })

  it('returns the exact selected version to the caller', async () => {
    const installation = await installationOf(undefined, '0.2.2-alpha.2')
    const loaded = await loadDshBridge(installation)
    if (Result.isFailure(loaded)) throw loaded.failure
    expect(loaded.success.version).toBe('0.2.2-alpha.2')
  })
})
