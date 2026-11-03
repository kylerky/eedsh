import { existsSync } from 'node:fs'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { runEedsh } from '../src/cli'
import { loadConfig } from '../src/config'
import {
  initConfigTemplate,
  initPackageManifest,
  initTsconfigTemplate,
  resolveInitDependencySpecs,
  TYPESCRIPT_SPEC,
} from '../src/init'
import { PackageManager } from '../src/internal/effect/services'
import { fakePackageManager, memoryFileSystem } from './support/fakes'

const tempRoot = join(process.cwd(), 'packages/cli/.tmp')
const configDir = '/xdg/eedsh'
const configPath = `${configDir}/config.ts`
const packagePath = `${configDir}/package.json`
const tsconfigPath = `${configDir}/tsconfig.json`

interface HarnessOptions {
  files?: Record<string, string>
  failInstall?: boolean
}

function harness(options: HarnessOptions = {}) {
  const fs = memoryFileSystem(options.files)
  const packages = fakePackageManager(options.failInstall === true ? { fail: true } : {})
  const out: string[] = []
  const err: string[] = []
  const services = () =>
    Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem, fs.fs),
      Layer.succeed(PackageManager, packages.shape),
    )
  return {
    fs,
    packages,
    out,
    err,
    options: {
      env: { XDG_CONFIG_HOME: '/xdg' },
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      initServices: services,
    },
    text: () => ({ out: out.join('\n'), err: err.join('\n') }),
  }
}

function json(value: string | undefined): Record<string, any> {
  if (value === undefined) throw new Error('missing file content')
  return JSON.parse(value) as Record<string, any>
}

describe('init templates', () => {
  it('writes config.ts, package.json, and tsconfig.json', async () => {
    const h = harness()
    expect(await runEedsh(['init', '--no-install'], h.options)).toBe(0)
    expect(h.fs.files.has(configPath)).toBe(true)
    expect(h.fs.files.has(packagePath)).toBe(true)
    expect(h.fs.files.has(tsconfigPath)).toBe(true)
    expect(h.fs.createdDirectories).toContain(configDir)
    expect(h.packages.installs).toEqual([])

    const config = h.fs.files.get(configPath) ?? ''
    expect(config).toContain('defineConfig')
    expect(config).toContain(".profile('default'")
    expect(config).toContain('.generated()')
    expect(config).toContain('.build()')
    expect(config).not.toContain('defineProfile')

    const manifest = json(h.fs.files.get(packagePath))
    expect(manifest.type).toBe('module')
    expect(manifest.private).toBe(true)
    expect(Object.keys(manifest.devDependencies)).toEqual(
      expect.arrayContaining(['@eedsh/config', 'effect', 'typescript']),
    )
  })

  it('writes link specs for an unpublished workspace and exact versions otherwise', () => {
    const specsResult = resolveInitDependencySpecs()
    if (Result.isFailure(specsResult)) throw new Error(specsResult.failure.message)
    const specs = specsResult.success
    expect(specs.config).toMatch(/^link:/)
    expect(specs.effect).toMatch(/^link:/)
    expect(specs.typescript).toBe(TYPESCRIPT_SPEC)

    const published = json(
      initPackageManifest({ config: '1.2.3', effect: '4.0.6', typescript: TYPESCRIPT_SPEC }),
    )
    expect(published.devDependencies['@eedsh/config']).toBe('1.2.3')
    expect(published.devDependencies.effect).toBe('4.0.6')
    expect(published.devDependencies.typescript).toBe(TYPESCRIPT_SPEC)
  })

  it('includes the config in the scaffolded tsconfig', () => {
    const tsconfig = json(initTsconfigTemplate())
    const include: string[] = tsconfig.include
    expect(include.some((pattern) => pattern.includes('*.ts'))).toBe(true)
    expect(
      include.some(
        (pattern) => pattern === 'config.ts' || pattern === '**/*.ts' || pattern === '*.ts',
      ),
    ).toBe(true)
    expect(tsconfig.compilerOptions.strict).toBe(true)
    expect(tsconfig.compilerOptions.noEmit).toBe(true)
    expect(initConfigTemplate()).toContain('@eedsh/config')
  })

  it('installs with pnpm by default', async () => {
    const h = harness()
    expect(await runEedsh(['init'], h.options)).toBe(0)
    expect(h.packages.installs).toEqual([configDir])
  })
})

describe('init behavior', () => {
  it('defers installation and prints the install command with --no-install', async () => {
    const h = harness()
    expect(await runEedsh(['init', '--no-install'], h.options)).toBe(0)
    expect(h.packages.installs).toEqual([])
    const text = h.text().out
    expect(text).toContain(`cd ${configDir} && pnpm install`)
    expect(text).toContain(configDir)
    expect(text).toContain('eedsh check')
    expect(text).toContain('eedsh sync')
    expect(text).toContain('eedsh run')
  })

  it('never overwrites an existing config.ts and creates missing files', async () => {
    const mine = '// my profile config\n'
    const h = harness({ files: { [configPath]: mine } })
    expect(await runEedsh(['init', '--no-install'], h.options)).toBe(0)
    expect(h.fs.files.get(configPath)).toBe(mine)
    expect(h.fs.files.has(packagePath)).toBe(true)
    expect(h.fs.files.has(tsconfigPath)).toBe(true)
    expect(h.text().out).toMatch(/kept/i)
    expect(h.text().out).toContain('config.ts')
  })

  it('preserves existing package.json and tsconfig.json', async () => {
    const manifest = '{"name":"mine"}\n'
    const tsconfig = '{"compilerOptions":{}}\n'
    const h = harness({
      files: { [configPath]: '// mine\n', [packagePath]: manifest, [tsconfigPath]: tsconfig },
    })
    expect(await runEedsh(['init', '--no-install'], h.options)).toBe(0)
    expect(h.fs.files.get(packagePath)).toBe(manifest)
    expect(h.fs.files.get(tsconfigPath)).toBe(tsconfig)
  })

  it('does not initialize a repository', async () => {
    const h = harness()
    expect(await runEedsh(['init', '--no-install'], h.options)).toBe(0)
    const paths = [...h.fs.files.keys(), ...h.fs.directories]
    expect(paths.some((path) => path.split('/').includes('.git'))).toBe(false)
  })

  it('keeps the written files and names the step when installation fails', async () => {
    const h = harness({ failInstall: true })
    expect(await runEedsh(['init'], h.options)).toBe(1)
    expect(h.fs.files.has(configPath)).toBe(true)
    expect(h.fs.files.has(packagePath)).toBe(true)
    expect(h.fs.files.has(tsconfigPath)).toBe(true)
    const errors = h.text().err
    expect(errors).toContain(configDir)
    expect(errors.toLowerCase()).toContain('install')
  })

  it('rejects an unknown init option without writing files', async () => {
    const h = harness()
    expect(await runEedsh(['init', '--bogus'], h.options)).toBe(2)
    expect(h.fs.files.size).toBe(0)
    expect(h.fs.createdDirectories).toEqual([])
  })

  it('prints init --help with the deployment flag', async () => {
    const h = harness()
    expect(await runEedsh(['init', '--help'], h.options)).toBe(0)
    const text = h.text().out
    expect(text).toContain('init')
    expect(text).toContain('--no-install')
  })
})

describe('init on a real filesystem', () => {
  it('creates the config directory owner-only and writes a loadable project', async () => {
    const home = await mkdtemp(join(tempRoot, 'init-'))
    const out: string[] = []
    const err: string[] = []
    const code = await runEedsh(['init', '--no-install'], {
      env: { XDG_CONFIG_HOME: home },
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    })
    expect(code).toBe(0)
    const dir = join(home, 'eedsh')
    const mode = (await stat(dir)).mode & 0o777
    expect(mode).toBe(0o700)
    for (const name of ['config.ts', 'package.json', 'tsconfig.json']) {
      expect(existsSync(join(dir, name))).toBe(true)
    }
    expect(existsSync(join(dir, '.git'))).toBe(false)
    expect(await readFile(join(dir, 'config.ts'), 'utf8')).toContain('defineConfig')
    expect(out.join('\n')).toContain(dir)
    expect(err.join('\n')).toBe('')
  })

  it('loads the generated config as an eedsh config', async () => {
    const home = await mkdtemp(join(tempRoot, 'init-load-'))
    const code = await runEedsh(['init', '--no-install'], {
      env: { XDG_CONFIG_HOME: home },
      stdout: () => {},
      stderr: () => {},
    })
    expect(code).toBe(0)
    const { config } = await Effect.runPromise(loadConfig(join(home, 'eedsh', 'config.ts')))
    expect(Object.keys(config.profiles)).toEqual(['default'])
    const profile = config.profiles.default
    expect(profile !== undefined && Result.isSuccess(profile)).toBe(true)
  })

  it('enforces owner-only mode even with a default umask', async () => {
    const home = await mkdtemp(join(tempRoot, 'init-mode-'))
    const code = await runEedsh(['init', '--no-install'], {
      env: { XDG_CONFIG_HOME: home },
      stdout: () => {},
      stderr: () => {},
    })
    expect(code).toBe(0)
    expect((await stat(join(home, 'eedsh'))).mode & 0o077).toBe(0)
  })
})
