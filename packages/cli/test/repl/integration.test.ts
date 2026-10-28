import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReplSession } from '../../src/repl/session'

const root = process.cwd()
const tempRoot = join(root, 'packages/cli/.tmp')
let work = ''
const sessions: ReplSession[] = []

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
}

async function installPreview(dir: string): Promise<void> {
  const packageDir = join(dir, 'node_modules', '@acme', 'plugin-bundle')
  await mkdir(packageDir, { recursive: true })
  await writeJson(join(packageDir, 'package.json'), {
    name: '@acme/plugin-bundle',
    version: '1.2.3',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writeFile(
    join(packageDir, 'cordis.patch.yml'),
    `- insert:
    - id: acme-row
      name: '@acme/plugin'
`,
  )
}

beforeEach(async () => {
  await mkdir(tempRoot, { recursive: true })
  work = await mkdtemp(join(tempRoot, 'repl-int-'))
})

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  await rm(work, { recursive: true, force: true })
})

describe('preview and authoring integration', () => {
  it('evaluates a saved custom-bundle query through the session preview', async () => {
    const configDir = join(work, 'config')
    await mkdir(join(configDir, 'node_modules', '@eedsh'), { recursive: true })
    await symlink(
      join(root, 'packages/config'),
      join(configDir, 'node_modules', '@eedsh', 'config'),
    )
    await writeJson(join(configDir, 'package.json'), {
      name: 'repl-integration-config',
      private: true,
      type: 'module',
      dependencies: { '@eedsh/config': 'link:../../../packages/config' },
    })
    const profileDir = join(work, 'home', 'profiles', 'work')
    await writeJson(join(profileDir, 'package.json'), {
      name: 'dsh-profile-work',
      private: true,
      dsh: { profile: { bundles: [] } },
    })
    const configPath = join(configDir, 'config.ts')
    const initial = `import { defineConfig, defineProfile, generated } from '@eedsh/config'

export default defineConfig({
  dsh: '0.2.1-rc.2',
  profiles: { work: defineProfile({ bundles: [generated()] }) },
})
`
    await writeFile(configPath, initial)
    const out: string[] = []
    const err: string[] = []
    const session = await ReplSession.create({
      configPath,
      profile: 'work',
      env: { DSH_HOME: join(work, 'home') },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      installPreview,
      cacheRoot: join(work, 'cache'),
      watchConfig: false,
    })
    sessions.push(session)
    expect(session.currentPlan.profile.name).toBe('work')

    const querySource = `import { defineConfig, defineProfile, generated, insert, layer, rows } from '@eedsh/config'

const custom = rows('@acme/plugin-bundle', { profile: 'work' })

export default defineConfig({
  dsh: '0.2.1-rc.2',
  profiles: {
    work: defineProfile({
      bundles: [generated()],
      layers: [layer('custom', [insert(custom)])],
    }),
  },
})
`
    await writeFile(configPath, querySource)
    await session.reload()
    expect(err.join('\n')).toContain('reload failed')

    await session.resolve(['@acme/plugin-bundle@1.2.3'])
    expect(out.join('\n')).toContain('preview: @acme/plugin-bundle@1.2.3')
    expect(out.join('\n')).toContain('profile-root override:')
    expect(out.join('\n')).toMatch(/resolved @acme\/plugin-bundle from the session preview/)
    expect(session.currentPlan.layers[0]?.patches[0]).toMatchObject({
      insert: [{ id: 'acme-row' }],
    })
    expect(await readFile(configPath, 'utf8')).toBe(querySource)
    expect(await readFile(join(profileDir, 'package.json'), 'utf8')).not.toContain('@acme')
  })
})
