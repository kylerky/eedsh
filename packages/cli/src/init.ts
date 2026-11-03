/**
 * `eedsh init`: create the XDG config project. The command resolves the
 * project's dependency specifications from the running CLI, writes the three
 * project files without overwriting existing ones, and optionally installs with
 * pnpm. It never initializes a repository and needs no DSH installation.
 * @module @eedsh/cli/init
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Data, Effect, Layer, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { writeFileAtomic } from './internal/atomic-write'
import type { PackageInstallFailure } from './internal/effect/errors'
import { pnpmPackageManagerLayer } from './internal/effect/layer'
import { PackageManager, type PackageManagerShape } from './internal/effect/services'
import { messageOf } from './internal/error-message'
import { readVersion } from './internal/schema-readers'

/** The single TypeScript version the scaffold declares. */
export const TYPESCRIPT_SPEC = '7.1.0-beta'

/** The profile key the scaffold writes. */
export const INIT_PROFILE_NAME = 'default'

/** Dependency specifications the generated manifest declares. */
export interface InitDependencySpecs {
  /** `@eedsh/config` version, or a workspace link. */
  readonly config: string
  /** `effect` version, or a workspace link. */
  readonly effect: string
  /** The TypeScript version. */
  readonly typescript: string
}

/** A failure while resolving what init writes. */
export class InitError extends Data.TaggedError('InitError')<{
  readonly code: string
  readonly message: string
}> {}

/** The services init needs: file access and package installation. */
export type InitService = FileSystem.FileSystem | PackageManagerShape

function readManifest(path: string): Result.Result<Record<string, unknown>, InitError> {
  return Result.try({
    try: () => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>,
    catch: (cause) =>
      new InitError({
        code: 'init.manifest_unreadable',
        message: `cannot read ${path}: ${messageOf(cause)}`,
      }),
  })
}

/**
 * Resolve the dependency specifications for the generated project. An
 * unpublished workspace (config version 0.0.0) links the CLI's own installed
 * copies, so local development and tests need no registry release; a published
 * CLI writes the exact versions it runs with. TypeScript always comes from
 * {@link TYPESCRIPT_SPEC}.
 * @returns the specs, or a resolution failure.
 */
export function resolveInitDependencySpecs(): Result.Result<InitDependencySpecs, InitError> {
  const require = createRequire(import.meta.url)
  const paths = Result.try({
    try: () => ({
      config: require.resolve('@eedsh/config/package.json'),
      effect: require.resolve('effect/package.json'),
    }),
    catch: (cause) =>
      new InitError({
        code: 'init.dependencies_unresolved',
        message: `cannot resolve the CLI's dependency manifests: ${messageOf(cause)}`,
      }),
  })
  if (Result.isFailure(paths)) return Result.fail(paths.failure)

  const configManifest = readManifest(paths.success.config)
  if (Result.isFailure(configManifest)) return Result.fail(configManifest.failure)
  const effectManifest = readManifest(paths.success.effect)
  if (Result.isFailure(effectManifest)) return Result.fail(effectManifest.failure)

  const configVersion = readVersion(configManifest.success.version)
  const effectVersion = readVersion(effectManifest.success.version)
  if (Option.isNone(configVersion) || Option.isNone(effectVersion)) {
    return Result.fail(
      new InitError({
        code: 'init.dependencies_unresolved',
        message: 'the CLI dependency manifests declare no version',
      }),
    )
  }

  const local = configVersion.value === '0.0.0'
  return Result.succeed({
    config: local ? `link:${dirname(paths.success.config)}` : configVersion.value,
    effect: local ? `link:${dirname(paths.success.effect)}` : effectVersion.value,
    typescript: TYPESCRIPT_SPEC,
  })
}

/**
 * Build the generated `config.ts`. The config declares profiles only; it has
 * no DSH value because discovery selects the user's installation.
 * @returns the module source.
 */
export function initConfigTemplate(): string {
  return `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('${INIT_PROFILE_NAME}', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .bundle('@deepseek-ai/dsh-web-app')
      .generated()
  })
  .build()
`
}

/**
 * Build the generated `package.json`.
 * @param specs - dependency specifications to declare.
 * @returns the manifest source.
 */
export function initPackageManifest(specs: InitDependencySpecs): string {
  return `${JSON.stringify(
    {
      name: 'eedsh-config',
      private: true,
      type: 'module',
      devDependencies: {
        '@eedsh/config': specs.config,
        effect: specs.effect,
        typescript: specs.typescript,
      },
    },
    null,
    2,
  )}\n`
}

/**
 * Build the generated `tsconfig.json`. It targets the same bundler-style
 * resolution the scaffold's imports and `tsc -p` need, and includes every
 * TypeScript file below the project.
 * @returns the tsconfig source.
 */
export function initTsconfigTemplate(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'es2024',
        module: 'preserve',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
      },
      include: ['**/*.ts'],
    },
    null,
    2,
  )}\n`
}

/** Inputs for {@link runInit}. */
export interface InitInput {
  /** Absolute config directory to create. */
  configDir: string
  /** Dependency specifications for the generated manifest. */
  specs: InitDependencySpecs
  /** Run pnpm install after writing the files. */
  install: boolean
  /** Sink for the "kept" report. */
  stdout: (line: string) => void
}

/** What an init run wrote and kept. */
export interface InitResult {
  readonly kept: readonly string[]
  readonly written: readonly string[]
  /** The exact install command for the config directory. */
  readonly installCommand: string
}

/**
 * Create the config project. Existing files are never overwritten; only
 * missing files are written, atomically. The directory is created owner-only
 * when it does not exist. A failed installation leaves every written file in
 * place so the project is repairable by re-running init or installing by hand.
 * @param input - config directory, pin, specs, and install choice.
 * @returns what was written or kept, or the package installation failure.
 */
export function runInit(
  input: InitInput,
): Effect.Effect<InitResult, PackageInstallFailure | PlatformError.PlatformError, InitService> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const packages = yield* PackageManager

    yield* fs.makeDirectory(input.configDir, { recursive: true, mode: 0o700 })

    const files: readonly { name: string; content: string }[] = [
      { name: 'config.ts', content: initConfigTemplate() },
      { name: 'package.json', content: initPackageManifest(input.specs) },
      { name: 'tsconfig.json', content: initTsconfigTemplate() },
    ]
    const kept: string[] = []
    const written: string[] = []
    for (const file of files) {
      const path = join(input.configDir, file.name)
      if (yield* fs.exists(path)) {
        kept.push(file.name)
        input.stdout(`eedsh: kept ${file.name}`)
        continue
      }
      yield* writeFileAtomic(fs, path, file.content)
      written.push(file.name)
    }

    if (input.install) yield* packages.install(input.configDir)

    return {
      kept,
      written,
      installCommand: `cd ${input.configDir} && pnpm install`,
    }
  })
}

/**
 * The live init services: Node file access and pnpm installation. This is a
 * narrow layer; it deliberately omits DSH resolution, preflight, and locking.
 * @returns the init service layer.
 */
export function defaultInitServices(): Layer.Layer<InitService> {
  return Layer.mergeAll(
    NodeServices.layer,
    pnpmPackageManagerLayer.pipe(Layer.provide(NodeServices.layer)),
  )
}
