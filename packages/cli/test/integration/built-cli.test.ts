import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Result from 'effect/Result'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
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
  beforeAll(async () => {
    await execFileAsync('pnpm', ['-r', 'build'], { cwd: root })
  }, 180_000)

  it('syncs a TypeScript config and produces a dumpable profile', async () => {
    await mkdir(join(root, '.tmp'), { recursive: true })
    const home = await mkdtemp(join(root, '.tmp', 'built-home-'))
    const cli = join(root, 'packages/cli/lib/bin.js')
    const fixture = join(root, 'packages/cli/test/fixtures/built/eedsh.config.ts')

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
    const fixture = join(root, 'packages/cli/test/fixtures/unmatched/eedsh.config.ts')

    const result = await execFileAsync(
      process.execPath,
      [cli, 'sync', '--explain', '--config', fixture],
      { cwd: root, env: { ...process.env, DSH_HOME: home } },
    )
    const output = `${result.stdout}\n${result.stderr}`
    expect(output).toContain('generated:cli:')
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
        include: ['eedsh.config.ts'],
      }),
    )
    const configPath = join(project, 'eedsh.config.ts')
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
})