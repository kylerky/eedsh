import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Cause, Effect, Exit } from 'effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  loadConfig,
  unsupportedConfigExtensionError,
  validateConfigPath,
} from '../src/config'
import { CONFIG_FILENAME, configHome, defaultConfigPath } from '../src/config-path'

const tempRoot = join(process.cwd(), 'packages/cli/.tmp')

async function configDir(source: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  const dir = await mkdtemp(join(tempRoot, 'config-load-'))
  await writeFile(join(dir, 'config.ts'), source)
  return dir
}

const multiProfileSource = `
import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .dsh('0.2.1-rc.2')
  .defaultProfile('home')
  .profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
  })
  .profile('home', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base')
  })
  .build()
`

const soleProfileSource = `
import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .dsh('0.2.1-rc.2')
  .profile('solo', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
  })
  .build()
`

const invalidSiblingSource = `
import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .dsh('0.2.1-rc.2')
  .defaultProfile('work')
  .profile('work', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base')
  })
  .profile('home', (profile) => {
    profile.bundle('@eedsh/runtime')
  })
  .build()
`

const plainConfigSource = `
export default {
  dsh: '0.2.1-rc.2',
  profiles: {
    'plain-export': {
      bundles: [{ kind: 'bundle', name: '@deepseek-ai/dsh-base' }, { kind: 'generated' }],
      layers: [],
      packages: {},
    },
  },
}
`

const lonePlanSource = `
export default {
  format: 'eedsh/profile-plan',
  version: 1,
  profile: { name: 'legacy-plan' },
  dsh: '0.2.1-rc.2',
  bundles: [],
  layers: [],
  packages: {},
}
`

describe('config path validation', () => {
  it('accepts a supported TypeScript config path', () => {
    const result = validateConfigPath('/work/config.ts')
    expect(Result.isSuccess(result)).toBe(true)
  })

  it('returns a tagged failure for a JavaScript config path', () => {
    const result = validateConfigPath('/work/config.js')
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(Error)
      expect(result.failure._tag).toBe('ConfigError')
      expect(result.failure.code).toBe('config.unsupported_extension')
    }
  })

  it('rejects .mts and .mjs config paths', () => {
    for (const path of ['/work/config.mts', '/work/config.mjs']) {
      const result = validateConfigPath(path)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure.code).toBe('config.unsupported_extension')
        expect(result.failure.message).toContain('config.ts')
      }
    }
  })

  it('builds tagged config failures', () => {
    const error = unsupportedConfigExtensionError('/work/config.js')
    expect(error).toBeInstanceOf(ConfigError)
    expect(error._tag).toBe('ConfigError')
    expect(error.code).toBe('config.unsupported_extension')
    expect(error.message).toContain('config.ts')
  })
})

describe('config loading', () => {
  it('loads a fluently built multi-profile config Result', async () => {
    const dir = await configDir(multiProfileSource)
    const config = await Effect.runPromise(loadConfig(join(dir, 'config.ts')))
    expect(config.dsh).toBe('0.2.1-rc.2')
    expect(config.defaultProfile).toBe('home')
    expect(Object.keys(config.profiles)).toEqual(['work', 'home'])
    const home = config.profiles.home
    expect(home !== undefined && Result.isSuccess(home)).toBe(true)
    const work = config.profiles.work
    expect(work !== undefined && Result.isSuccess(work)).toBe(true)
  })

  it('loads a sole-profile fluent config without a default', async () => {
    const dir = await configDir(soleProfileSource)
    const config = await Effect.runPromise(loadConfig(join(dir, 'config.ts')))
    expect(config.defaultProfile).toBeUndefined()
    expect(Object.keys(config.profiles)).toEqual(['solo'])
  })

  it('loads a plain config value and validates its profiles', async () => {
    const dir = await configDir(plainConfigSource)
    const config = await Effect.runPromise(loadConfig(join(dir, 'config.ts')))
    expect(Object.keys(config.profiles)).toEqual(['plain-export'])
    const profile = config.profiles['plain-export']
    expect(profile !== undefined && Result.isSuccess(profile)).toBe(true)
  })

  it('rejects a lone profile plan as a config', async () => {
    const dir = await configDir(lonePlanSource)
    const exit = await Effect.runPromiseExit(loadConfig(join(dir, 'config.ts')))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(Schema.isSchemaError(error)).toBe(true)
      if (Schema.isSchemaError(error)) expect(error.message).toContain('profiles')
    }
  })

  it('keeps an invalid profile as data instead of failing the config', async () => {
    const dir = await configDir(invalidSiblingSource)
    const config = await Effect.runPromise(loadConfig(join(dir, 'config.ts')))
    const work = config.profiles.work
    expect(work !== undefined && Result.isSuccess(work)).toBe(true)
    const home = config.profiles.home
    expect(home !== undefined && Result.isFailure(home)).toBe(true)
    if (home !== undefined && Result.isFailure(home)) {
      expect(home.failure.message).toContain('owned by the materializer')
    }
  })
})

describe('XDG config path', () => {
  it('uses an absolute XDG_CONFIG_HOME', () => {
    const env = { XDG_CONFIG_HOME: join('/xdg', 'home'), HOME: '/home/user' }
    expect(configHome(env)).toBe(join('/xdg', 'home'))
    expect(defaultConfigPath(env)).toBe(join('/xdg', 'home', 'eedsh', CONFIG_FILENAME))
  })

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset, empty, or relative', () => {
    for (const value of [undefined, '', 'relative/dir']) {
      const env = { XDG_CONFIG_HOME: value, HOME: '/home/user' }
      expect(configHome(env)).toBe(join('/home/user', '.config'))
      expect(defaultConfigPath(env)).toBe(join('/home/user', '.config', 'eedsh', CONFIG_FILENAME))
    }
  })

  it('uses USERPROFILE when HOME is absent', () => {
    expect(configHome({ USERPROFILE: '/users/me' })).toBe(join('/users/me', '.config'))
  })

  it('exposes the config filename', () => {
    expect(CONFIG_FILENAME).toBe('config.ts')
  })
})
