import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { resolveDshInstallation } from '../../src/dsh'

const execFileAsync = promisify(execFile)
const root = process.cwd()

/** The TypeScript version the repository itself pins in its root manifest. */
async function pinnedTypeScriptVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>
  }
  const version = manifest.devDependencies?.typescript
  if (version === undefined) throw new Error('the root package.json pins no typescript')
  return version
}

describe('built CLI integration', () => {
  it('syncs a TypeScript config and produces a dumpable profile', async () => {
    await mkdir(join(root, '.tmp'), { recursive: true })
    const home = await mkdtemp(join(root, '.tmp', 'built-home-'))
    const cli = join(root, 'packages/cli/lib/bin.js')
    const fixture = join(root, 'packages/cli/test/fixtures/built/config.ts')

    const sync = await execFileAsync(process.execPath, [cli, 'sync', '--config', fixture], {
      cwd: root,
      env: { ...process.env, DSH_HOME: home },
    })
    expect(sync.stdout).toContain('published profile built-cli')

    const { binPath } = Result.getOrThrow(resolveDshInstallation())
    const dump = await execFileAsync(
      process.execPath,
      [binPath, '--profile', 'built-cli', '--dump-config'],
      { cwd: home, env: { ...process.env, DSH_HOME: home } },
    )
    expect(dump.stdout).toContain('id: built-row')
    expect(dump.stdout).toContain('marker: built')
  }, 180_000)

  it('attributes preflight warnings with sync --explain', async () => {
    await mkdir(join(root, '.tmp'), { recursive: true })
    const home = await mkdtemp(join(root, '.tmp', 'explain-home-'))
    const cli = join(root, 'packages/cli/lib/bin.js')
    const fixture = join(root, 'packages/cli/test/fixtures/unmatched/config.ts')

    const result = await execFileAsync(
      process.execPath,
      [cli, 'sync', '--explain', '--config', fixture],
      { cwd: root, env: { ...process.env, DSH_HOME: home } },
    )
    const output = `${result.stdout}\n${result.stderr}`
    expect(output).toContain('generated #1 "cli" (config.ts:10:15) [missing-row]:')
    expect(output).toContain('missing-row')
    expect(output).not.toContain('add --explain')
  }, 180_000)

  it("typechecks a temporary project with the project's own compiler", async () => {
    await mkdir(join(root, '.tmp'), { recursive: true })
    const project = await mkdtemp(join(root, '.tmp', 'check-'))
    const cli = join(root, 'packages/cli/lib/bin.js')
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ name: 'check-fixture', private: true, type: 'module' }),
    )
    await writeFile(
      join(project, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'es2024',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          types: [],
        },
        include: ['config.ts'],
      }),
    )
    const configPath = join(project, 'config.ts')
    await writeFile(configPath, "export default { name: 'check-fixture' }\n")
    const home = await mkdtemp(join(root, '.tmp', 'check-home-'))
    const env = { ...process.env, DSH_HOME: home }

    const pinnedTypeScript = await pinnedTypeScriptVersion()
    const clean = await execFileAsync(process.execPath, [cli, 'check', '--config', configPath], {
      cwd: project,
      env,
    })
    expect(clean.stdout).toContain('eedsh: check passed')
    expect(clean.stdout).toContain(`eedsh: TypeScript ${pinnedTypeScript}`)
    expect(clean.stdout).toContain('eedsh: running')

    await writeFile(
      configPath,
      "export default { name: 'check-fixture' }\nconst broken: number = 'not a number'\n",
    )
    const failure = await execFileAsync(process.execPath, [cli, 'check', '--config', configPath], {
      cwd: project,
      env,
    }).then(
      () => {
        throw new Error('eedsh check should have failed')
      },
      (error: { code?: number; stdout?: string; stderr?: string }) => error,
    )
    // tsc reports diagnostics with exit code 2; eedsh forwards it unchanged.
    expect(failure.code).toBe(2)
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
    expect(output).toContain('error TS2322')
    expect(output).toContain('check failed')
  }, 180_000)

  it('initializes, syncs, diagnoses, and runs named profiles from the XDG config', async () => {
    await mkdir(join(root, 'packages/cli/.tmp'), { recursive: true })
    const home = await mkdtemp(join(root, 'packages/cli/.tmp', 'built-init-'))
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: home,
      DSH_HOME: join(home, 'dsh'),
    }
    const cli = join(root, 'packages/cli/lib/bin.js')
    const configPath = join(home, 'eedsh', 'config.ts')

    async function capture(args: string[]): Promise<{ code: number; output: string }> {
      return execFileAsync(process.execPath, [cli, ...args], {
        cwd: root,
        env,
        timeout: 120_000,
      }).then(
        (result) => ({ code: 0, output: `${result.stdout}\n${result.stderr}` }),
        (error: { code?: number; stdout?: string; stderr?: string }) => ({
          code: error.code ?? -1,
          output: `${error.stdout ?? ''}\n${error.stderr ?? ''}`,
        }),
      )
    }

    const init = await execFileAsync(process.execPath, [cli, 'init', '--no-install'], {
      cwd: root,
      env,
      timeout: 120_000,
    })
    expect(init.stdout).toContain(join(home, 'eedsh'))
    expect(init.stdout).toContain('profiles: default')
    expect(init.stdout).toContain('eedsh sync')
    expect(init.stdout).toContain('eedsh check')
    expect(await readFile(configPath, 'utf8')).toContain('defineConfig')

    await writeFile(
      configPath,
      `import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .dsh('0.2.1-rc.2')
  .defaultProfile('work')
  .profile('work', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base').generated()
  })
  .profile('home', (profile) => {
    profile.bundle('@deepseek-ai/dsh-base').generated()
  })
  .build()
`,
    )

    const sync = await execFileAsync(process.execPath, [cli, 'sync'], {
      cwd: root,
      env,
      timeout: 180_000,
    })
    expect(sync.stdout).toContain('profile "work"')
    expect(sync.stdout).toContain('profile "home"')
    expect(sync.stdout).toContain('published profile work')
    expect(sync.stdout).toContain('published profile home')

    const doctor = await capture(['doctor'])
    expect(doctor.output).toContain(join(home, 'dsh', 'profiles', 'work'))
    expect(doctor.output).not.toContain(join(home, 'dsh', 'profiles', 'home'))

    const version = await execFileAsync(
      process.execPath,
      [cli, 'run', '--profile', 'home', '--no-sync', '--', '--version'],
      { cwd: root, env, timeout: 120_000 },
    )
    expect(version.stdout).toContain('0.2.1-rc.2')

    const unknown = await capture(['run', '--profile', 'missing', '--no-sync'])
    expect(unknown.code).toBe(2)
    expect(unknown.output).toContain('missing')
    expect(unknown.output).toContain('work')
    expect(unknown.output).toContain('home')
  }, 300_000)
})
