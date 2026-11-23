import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Cause, Effect, Exit } from 'effect'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  loadConfig as loadConfigUnprovided,
  unsupportedConfigExtensionError,
  validateConfigPath,
} from '../src/config'
import { CONFIG_FILENAME, configHome, defaultConfigPath } from '../src/config-path'
import { bundleResolverLayer } from '../src/internal/effect/layer'

const testResolver = bundleResolverLayer.pipe(Layer.provide(NodeServices.layer))
const loadConfig = (configPath: string) =>
  loadConfigUnprovided(configPath, { installation: devDshInstallation(), env: {} }).pipe(
    Effect.provide(Layer.merge(NodeServices.layer, testResolver)),
  )

import { ResolutionError } from '@eedsh/config'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Layer } from 'effect'
import { BundleResolver } from '../src/internal/effect/services'
import { devDshInstallation } from './support/bridge'
import { fakeBundleResolver } from './support/cli'

const tempRoot = join(process.cwd(), 'packages/cli/.tmp')

async function configDir(source: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  const dir = await mkdtemp(join(tempRoot, 'config-load-'))
  await writeFile(join(dir, 'config.ts'), source)
  return dir
}

const multiProfileSource = `
import { defineConfig } from '@eedsh/config'

export default () => defineConfig()
  .defaultProfile('home')
  .profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
  })
  .profile('home', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base')
  })
`

const soleProfileSource = `
import { defineConfig } from '@eedsh/config'

export default () => defineConfig()
  .profile('solo', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
  })
`

const invalidSiblingSource = `
import { defineConfig } from '@eedsh/config'

export default () => defineConfig()
  .defaultProfile('work')
  .profile('work', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base')
  })
  .profile('home', (profile) => {
    profile.bundle('@eedsh/runtime')
  })
`

const plainConfigSource = `
export default {
  profiles: {
    'plain-export': {
      bundles: [{ kind: 'bundle', name: '@deepseek-ai/dsh-base' }, { kind: 'generated' }],
      layers: [],
      packages: {},
    },
  },
}
`

const missingPresetSource = `
import { bundle, defineConfig } from '@eedsh/config'

export default () =>
  defineConfig()
    .profile('work', (profile) => {
      profile
        .bundle('@deepseek-ai/dsh-base')
        .generated()
        .layer((layer) => layer.insert(bundle('@deepseek-ai/dsh-base').preset('missing')))
    })
`

const missingPresetChildSource = `
import { defineConfig, definePreset } from '@eedsh/config'

definePreset('ptc-fresh').children((children) => {
  children.child('missing')
})

export default () => defineConfig()
`

const sourceConflictSource = `
import { defineConfig } from '@eedsh/config'

export default () => defineConfig()
  .profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .source('@scope/plugin', { from: 'https://example.test/acme/bundle.git' })
      .package('@scope/plugin', '1.0.0')
  })
`

const localRefSource = `
import { defineConfig } from '@eedsh/config'
export default () => defineConfig()
  .profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .source('@scope/plugin', { from: './vendor/acme-bundle', ref: 'main' })
  })
`

const untaggedThrowSource = `
import { defineConfig } from '@eedsh/config'
throw new Error('untagged import boom')

export default () => defineConfig()
`

const lonePlanSource = `
export default {
  format: 'eedsh/profile-plan',
  version: 1,
  profile: { name: 'legacy-plan' },
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
    const { config } = await Effect.runPromise(loadConfig(join(dir, 'config.ts')))
    expect(config.defaultProfile).toBe('home')
    expect(Object.keys(config.profiles)).toEqual(['work', 'home'])
    const home = config.profiles.home
    expect(home !== undefined && Result.isSuccess(home)).toBe(true)
    const work = config.profiles.work
    expect(work !== undefined && Result.isSuccess(work)).toBe(true)
  })

  it('loads a sole-profile fluent config without a default', async () => {
    const dir = await configDir(soleProfileSource)
    const { config } = await Effect.runPromise(loadConfig(join(dir, 'config.ts')))
    expect(config.defaultProfile).toBeUndefined()
    expect(Object.keys(config.profiles)).toEqual(['solo'])
  })

  it('reports a module with no default export as config.missing_default_export', async () => {
    const dir = await configDir(`
import { defineConfig } from '@eedsh/config'
export const factory = () => defineConfig()
`)
    const exit = await Effect.runPromiseExit(loadConfig(join(dir, 'config.ts')))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as ConfigError
      expect(error._tag).toBe('ConfigError')
      expect(error.code).toBe('config.missing_default_export')
      expect(error.message).toContain('must default-export')
    }
  })

  it('calls the factory with the selected version and the config directory', async () => {
    const dir = await configDir(`
import { defineConfig } from '@eedsh/config'
export default (input) =>
  defineConfig().profile('work', (profile) => {
    profile.generated().layer((layer) => layer.insert({ id: 'version-' + input.dshVersion, name: '@scope/version' }))
  })
`)
    const loaded = await Effect.runPromise(loadConfig(join(dir, 'config.ts')))
    expect(loaded.configDir).toBe(dir)
    const plan = loaded.config.profiles.work
    expect(plan !== undefined && Result.isSuccess(plan)).toBe(true)
    if (plan === undefined || Result.isFailure(plan)) return
    const inserted = plan.success.layers[0]?.patches[0]?.insert as
      | readonly Record<string, unknown>[]
      | undefined
    expect(inserted?.[0]?.id).toBe(`version-${devDshInstallation().version}`)
  })

  it('rejects a non-function default export with config.invalid_default_export', async () => {
    const dir = await configDir(plainConfigSource)
    const exit = await Effect.runPromiseExit(loadConfig(join(dir, 'config.ts')))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as ConfigError
      expect(error._tag).toBe('ConfigError')
      expect(error.code).toBe('config.invalid_default_export')
      expect(error.message).toContain('ConfigBuilder')
    }
  })

  it('rejects a lone profile plan as a non-factory export', async () => {
    const dir = await configDir(lonePlanSource)
    const exit = await Effect.runPromiseExit(loadConfig(join(dir, 'config.ts')))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as ConfigError
      expect(error.code).toBe('config.invalid_default_export')
    }
  })

  it('keeps an invalid profile as data instead of failing the config', async () => {
    const dir = await configDir(invalidSiblingSource)
    const { config } = await Effect.runPromise(loadConfig(join(dir, 'config.ts')))
    const work = config.profiles.work
    expect(work !== undefined && Result.isSuccess(work)).toBe(true)
    const home = config.profiles.home
    expect(home !== undefined && Result.isFailure(home)).toBe(true)
    if (home !== undefined && Result.isFailure(home)) {
      expect(home.failure.message).toContain('owned by the materializer')
    }
  })
})

describe('resolution stops the build', () => {
  it('does not call the terminal build when resolution fails', async () => {
    const dir = await configDir(`
import { bundle, defineConfig } from '@eedsh/config'

export default () => {
  const builder = defineConfig().profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .generated()
      .layer((layer) => layer.insert(bundle('@deepseek-ai/dsh-base').preset('missing')))
  })
  builder.build = () => {
    throw new Error('the terminal build must not run')
  }
  return builder
}
`)
    const resolver = fakeBundleResolver({
      resolutionFailure: new ResolutionError({
        code: 'resolution.preset_not_found',
        bundle: '@deepseek-ai/dsh-base',
        message: 'bundle "@deepseek-ai/dsh-base" declares no preset "missing"',
      }),
    })
    const exit = await Effect.runPromiseExit(
      loadConfigUnprovided(join(dir, 'config.ts'), {
        installation: devDshInstallation(),
        env: {},
      }).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, Layer.succeed(BundleResolver, resolver))),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    const error = Cause.squash(exit.cause) as ResolutionError
    expect(error._tag).toBe('ResolutionError')
    expect(error.code).toBe('resolution.preset_not_found')
    expect(String(error.message)).not.toContain('terminal build')
  })
})

describe('authoring failures during import', () => {
  async function failureOf(source: string): Promise<unknown> {
    const dir = await configDir(source)
    const exit = await Effect.runPromiseExit(loadConfig(join(dir, 'config.ts')))
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return undefined
    return Cause.squash(exit.cause)
  }

  it('preserves a missing preset as a resolution failure', async () => {
    const error = (await failureOf(missingPresetSource)) as Record<string, unknown>
    expect(error._tag).toBe('ResolutionError')
    expect(error.code).toBe('resolution.preset_not_found')
    expect(String(error.message)).toContain('"missing"')
    expect(String(error.message)).toContain('@deepseek-ai/dsh-base')
  })

  it('preserves a missing preset child as a preset-definition failure', async () => {
    const error = (await failureOf(missingPresetChildSource)) as Record<string, unknown>
    expect(error._tag).toBe('PresetDefinitionError')
    expect(error.code).toBe('preset.child_not_found')
    expect(error.presetId).toBe('ptc-fresh')
    expect(error.rowId).toBe('preset-ptc-fresh')
    expect(error.childId).toBe('missing')
    expect(String(error.message)).toContain('"ptc-fresh"')
    expect(String(error.message)).toContain('"preset-ptc-fresh"')
    expect(String(error.message)).toContain('"missing"')
  })

  it('preserves a package and source conflict as a source-declaration failure', async () => {
    const error = (await failureOf(sourceConflictSource)) as Record<string, unknown>
    expect(error._tag).toBe('SourceDeclarationError')
    expect(error.code).toBe('source.duplicate_package')
    expect(String(error.message)).toContain('@scope/plugin')
    expect(String(error.message)).not.toContain('cannot import')
  })

  it('preserves a ref on a local checkout as a source-declaration failure', async () => {
    const error = (await failureOf(localRefSource)) as Record<string, unknown>
    expect(error._tag).toBe('SourceDeclarationError')
    expect(error.code).toBe('source.ref_on_local_checkout')
    expect(String(error.message)).toContain('ref')
    expect(String(error.message)).not.toContain('cannot import')
  })

  it('keeps an untagged import failure a config import failure', async () => {
    const error = (await failureOf(untaggedThrowSource)) as Record<string, unknown>
    expect(error._tag).toBe('ConfigError')
    expect(error.code).toBe('config.import_failed')
    expect(String(error.message)).toContain('untagged import boom')
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
