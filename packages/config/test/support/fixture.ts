import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The process environment as it was before a test suite changed it. */
export const originalEnv = { ...process.env }

/** Paths and package versions the authoring tests resolve against. */
export interface AuthoringFixture {
  readonly root: string
  readonly dshDir: string
  readonly anchor: string
  readonly baseDir: string
  readonly home: string
  readonly workDir: string
  readonly customDir: string
  readonly profileCopy: string
  readonly packageDir: string
  readonly configDir: string
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
}

async function writeBundle(
  baseDir: string,
  name: string,
  version: string,
  patch: string,
): Promise<string> {
  const packageDir = join(baseDir, 'node_modules', ...name.split('/'))
  await writeJson(join(packageDir, 'package.json'), {
    name,
    version,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  await writeFile(join(packageDir, 'cordis.patch.yml'), patch)
  return packageDir
}

/**
 * Create a pinned DSH installation, one profile install, and one vendored
 * package directory for authoring and query tests.
 * @param tempRoot - workspace-relative temporary directory.
 * @returns the fixture paths.
 */
export async function createAuthoringFixture(tempRoot: string): Promise<AuthoringFixture> {
  await mkdir(tempRoot, { recursive: true })
  const root = await mkdtemp(join(tempRoot, 'authoring-'))
  const dshDir = join(root, 'dsh')
  await writeJson(join(dshDir, 'package.json'), {
    name: '@deepseek-ai/dsh',
    version: '0.2.1-rc.2',
    dependencies: { '@fixture/base': '1.0.0' },
  })
  const baseDir = await writeBundle(
    dshDir,
    '@fixture/base',
    '1.0.0',
    `- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        name: Standard
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'
`,
  )
  const home = join(root, 'home')
  const workDir = join(home, 'profiles', 'work')
  await writeJson(join(workDir, 'package.json'), {
    name: 'dsh-profile-work',
    private: true,
    dsh: { profile: { bundles: [] } },
  })
  const customDir = await writeBundle(
    workDir,
    '@fixture/custom',
    '2.0.0',
    `- insert:
    - id: custom-row
      name: '@fixture/plugin'
`,
  )
  const profileCopy = await writeBundle(
    workDir,
    '@fixture/base',
    '9.9.9',
    `- insert:
    - id: profile-copy
      name: '@fixture/profile-copy'
`,
  )
  const packageDir = await writeBundle(
    root,
    '@fixture/vendored',
    '3.0.0',
    `- insert:
    - id: vendored-row
      name: '@fixture/vendored-plugin'
`,
  )
  const configDir = join(root, 'config')
  await mkdir(configDir, { recursive: true })
  return {
    root,
    dshDir,
    anchor: join(dshDir, 'package.json'),
    baseDir,
    home,
    workDir,
    customDir,
    profileCopy,
    packageDir,
    configDir,
  }
}

/**
 * Point the authoring environment at the fixture installation and config file.
 * @param fixture - the created fixture.
 */
export function useFixtureEnv(fixture: AuthoringFixture): void {
  process.env.EEDSH_DSH_ANCHOR = fixture.anchor
  process.env.DSH_HOME = fixture.home
  process.env.EEDSH_CONFIG_DIR = fixture.configDir
}
