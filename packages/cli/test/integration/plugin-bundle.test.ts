/**
 * Plain-DSH acceptance for a plugin bundle generated with `@eedsh/bundle`.
 * The profile selects only the fixture bundle; eedsh's CLI, sync, runtime, and
 * generated layer are not involved.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { composeEntries, loadProfileDirectory, type ProfileLayer } from '@deepseek-ai/dsh-app-boot'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = process.cwd()
const fixture = join(root, 'packages', 'bundle', 'test', 'fixtures', 'plugin-bundle')
const require = createRequire(import.meta.url)
const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
let profileDir: string

beforeAll(async () => {
  await mkdir(join(root, '.tmp'), { recursive: true })
  profileDir = await mkdtemp(join(root, '.tmp', 'plugin-bundle-'))
  const packageDir = join(profileDir, 'node_modules', '@fixture', 'plugin-bundle')
  await mkdir(join(profileDir, 'node_modules', '@fixture'), { recursive: true })
  await cp(fixture, packageDir, { recursive: true })
  await writeFile(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'fixture-profile',
        private: true,
        dsh: { profile: { bundles: ['@fixture/plugin-bundle'] } },
      },
      null,
      2,
    )}\n`,
  )
})

afterAll(async () => {
  await rm(profileDir, { recursive: true, force: true })
})

function flatIds(entries: readonly unknown[]): string[] {
  const ids: string[] = []
  for (const value of entries) {
    if (value === null || typeof value !== 'object') continue
    const entry = value as { id?: unknown; config?: unknown }
    if (typeof entry.id === 'string') ids.push(entry.id)
    if (Array.isArray(entry.config)) ids.push(...flatIds(entry.config))
  }
  return ids
}

describe('plain DSH composes a generated plugin bundle', () => {
  it('loads the committed patch without eedsh and composes its rows', () => {
    const profile = loadProfileDirectory('dsh', profileDir, installAnchor, { userLayer: false })
    expect(profile.skippedBundles).toEqual([])
    expect(profile.layers).toHaveLength(1)
    const layer = profile.layers[0] as ProfileLayer
    expect(layer.packageName).toBe('@fixture/plugin-bundle')
    expect(layer.patchPaths).toEqual([
      join(profileDir, 'node_modules/@fixture/plugin-bundle/cordis.patch.yml'),
    ])
    expect(layer.patches).toHaveLength(5)

    const warnings: string[] = []
    const entries = composeEntries([layer.patches], (message) => warnings.push(message))
    expect(warnings).toEqual([])
    expect(flatIds(entries)).toEqual([
      'fixture-plugin',
      'fixture-tool',
      'fixture-group',
      'fixture-child',
      'fixture-preset',
    ])
    const plugin = entries.find((entry) => entry.id === 'fixture-plugin')
    expect(plugin?.config).toEqual({ enabled: true, marker: 'fixture' })
    const tool = entries.find((entry) => entry.id === 'fixture-tool')
    expect(tool?.disabled).toEqual({ __jsExpr: "process.platform === 'win32'" })
    const group = entries.find((entry) => entry.id === 'fixture-group')
    expect(group).toMatchObject({ group: true, isolate: { fixture: true } })
  })
})
