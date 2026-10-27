import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

const root = process.cwd()
const tempRoot = join(root, 'packages/cli/.tmp')

async function project(prefix: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  return mkdtemp(join(tempRoot, prefix))
}

async function writeMappedProject(prefix: string, profileName: string): Promise<string> {
  const dir = await project(prefix)
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'es2024',
        module: 'preserve',
        moduleResolution: 'bundler',
        baseUrl: '.',
        paths: { '@project/*': ['src/*'] },
      },
      include: ['config.ts', 'src/**/*.ts'],
    }),
  )
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'helper.ts'), `export const profileName = '${profileName}'\n`)
  const configPath = join(dir, 'config.ts')
  await writeFile(
    configPath,
    `import { defineConfig, defineProfile } from '@eedsh/config'
import { profileName } from '@project/helper'

export default defineConfig({
  dsh: '0.2.1-rc.2',
  profiles: { [profileName]: defineProfile({ bundles: [] }) },
})
`,
  )
  return configPath
}

describe('config loader resolution', () => {
  it('resolves path mappings from the config project tsconfig', async () => {
    const configPath = await writeMappedProject('loader-paths-', 'mapped-profile')
    const config = await Effect.runPromise(loadConfig(configPath))
    expect(Object.keys(config.profiles)).toEqual(['mapped-profile'])
  })

  it('ignores caller working-directory path mappings', async () => {
    const projectDir = await project('loader-config-tsconfig-')
    await writeFile(
      join(projectDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['src/*'] } },
        include: ['config.ts', 'src/**/*.ts'],
      }),
    )
    await mkdir(join(projectDir, 'src'), { recursive: true })
    await writeFile(
      join(projectDir, 'src', 'helper.ts'),
      "export const profileName = 'config-project'\n",
    )
    const configPath = join(projectDir, 'config.ts')
    await writeFile(
      configPath,
      `import { defineConfig, defineProfile } from '@eedsh/config'
import { profileName } from '@shared/helper'

export default defineConfig({
  dsh: '0.2.1-rc.2',
  profiles: { [profileName]: defineProfile({ bundles: [] }) },
})
`,
    )

    const callerDir = await project('loader-caller-tsconfig-')
    await writeFile(
      join(callerDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['caller/*'] } },
      }),
    )
    await mkdir(join(callerDir, 'caller'), { recursive: true })
    await writeFile(
      join(callerDir, 'caller', 'helper.ts'),
      "export const profileName = 'caller-project'\n",
    )

    const previous = process.cwd()
    process.chdir(callerDir)
    try {
      const config = await Effect.runPromise(loadConfig(configPath))
      expect(Object.keys(config.profiles)).toEqual(['config-project'])
    } finally {
      process.chdir(previous)
    }
  })

  it('does not inherit caller mappings without a config tsconfig', async () => {
    const projectDir = await project('loader-no-tsconfig-')
    await writeFile(
      join(projectDir, 'helper.ts'),
      "export const profileName = 'relative-profile'\n",
    )
    const configPath = join(projectDir, 'config.ts')
    await writeFile(
      configPath,
      `import { defineConfig, defineProfile } from '@eedsh/config'
import { profileName } from './helper'

export default defineConfig({
  dsh: '0.2.1-rc.2',
  profiles: { [profileName]: defineProfile({ bundles: [] }) },
})
`,
    )

    const callerDir = await project('loader-caller-conflict-')
    await writeFile(
      join(callerDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@eedsh/config': ['./wrong.ts'] } },
      }),
    )
    await writeFile(
      join(callerDir, 'wrong.ts'),
      "export const defineConfig = (): never => { throw new Error('caller mapping applied') }\nexport const defineProfile = (): never => { throw new Error('caller mapping applied') }\n",
    )

    const previous = process.cwd()
    process.chdir(callerDir)
    try {
      const config = await Effect.runPromise(loadConfig(configPath))
      expect(Object.keys(config.profiles)).toEqual(['relative-profile'])
    } finally {
      process.chdir(previous)
    }
  })

  it('re-resolves the tsconfig when the config project changes', async () => {
    const first = await writeMappedProject('loader-a-', 'profile-a')
    const second = await writeMappedProject('loader-b-', 'profile-b')
    const firstConfig = await Effect.runPromise(loadConfig(first))
    expect(Object.keys(firstConfig.profiles)).toEqual(['profile-a'])
    const secondConfig = await Effect.runPromise(loadConfig(second))
    expect(Object.keys(secondConfig.profiles)).toEqual(['profile-b'])
  })
})
