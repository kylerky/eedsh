/**
 * External-DSH compatibility matrix harness. It installs one isolated DSH
 * version per case, publishes a profile through `eedsh sync --dsh`, boots the
 * selected launcher for `--dump-config`, evaluates `dshVersion()`, and checks
 * the generation record, plan, generated manifest, and runtime drift warning.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = new URL('../..', import.meta.url).pathname
const cliPath = join(root, 'packages/cli/lib/bin.js')
const fixture = join(root, 'packages/cli/test/fixtures/basic/config.ts')
const runtimeWatcher = join(root, 'packages/runtime/src/watcher.ts')

/** The DSH versions every release must keep working. */
export const PINNED_VERSIONS = ['0.2.1-rc.2', '0.2.1-rc.5', '0.2.2-alpha.2']

/**
 * Resolve the matrix cache. An explicit EEDSH_MATRIX_CACHE wins; the default is
 * below the workspace's ignored .tmp directory.
 * @returns the absolute cache directory.
 */
export function matrixCacheRoot() {
  return process.env.EEDSH_MATRIX_CACHE ?? join(root, '.tmp', 'matrix')
}

function cleanEnv(extra = {}) {
  const env = { ...process.env }
  delete env.EEDSH_DSH_ANCHOR
  delete env.DSH_HOME
  delete env.EEDSH_CONFIG_DIR
  delete env.EEDSH_PROFILE_ROOT_OVERRIDE
  return { ...env, ...extra }
}

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? cleanEnv(),
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeout ?? 900_000,
    })
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    const detail = (stderr || stdout || error.message || String(error)).trim().slice(-4000)
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
}

/**
 * Install or reuse one isolated DSH installation.
 * @param spec - an exact version or a dist-tag such as `latest`.
 * @returns the installation paths and exact manifest version.
 */
export async function ensureDsh(spec) {
  const cache = matrixCacheRoot()
  await mkdir(cache, { recursive: true })
  const dir = join(cache, spec.replace(/[^A-Za-z0-9.-]/g, '_'))
  const anchor = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (!existsSync(anchor)) {
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: `eedsh-matrix-${spec.replace(/[^A-Za-z0-9.-]/g, '-')}`,
        private: true,
      }),
    )
    await run('pnpm', ['add', `@deepseek-ai/dsh@${spec}`, '--trust-lockfile', '--ignore-scripts'], {
      cwd: dir,
    })
  }
  const manifest = JSON.parse(await readFile(anchor, 'utf8'))
  if (typeof manifest.version !== 'string') {
    throw new Error(`${anchor} declares no version`)
  }
  const packageDir = dirname(anchor)
  return {
    spec,
    version: manifest.version,
    packageDir,
    installAnchor: anchor,
    binPath: join(packageDir, 'lib', 'bin.js'),
  }
}

async function checkDrift(dsh) {
  const { createGenerationWatcher } = await import(pathToFileURL(runtimeWatcher).href)
  const dir = await mkdtemp(join(tmpdir(), 'eedsh-matrix-drift-'))
  try {
    const manifestPath = join(dir, 'package.json')
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        name: '@eedsh/generated',
        eedsh: {
          format: 'eedsh/generation',
          generationId: 'a'.repeat(64),
          dshVersion: '0.2.0',
        },
      })}\n`,
    )
    const logs = []
    const logger = {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    }
    const watcher = createGenerationWatcher({
      manifestPath,
      hmr: {
        watchConfig: async () => async () => {},
        reconcileProfile: async () => ({ warnings: [], pending: [] }),
      },
      logger,
      runningDshVersion: dsh.version,
    })
    await watcher.initialize()
    return {
      ok: logs.some(
        ([level, message]) =>
          level === 'warn' && message.includes(dsh.version) && message.includes('eedsh sync'),
      ),
      logs,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Run every matrix check for one DSH version.
 * @param spec - exact version or dist-tag.
 * @returns one result record; `ok` is false when any required check failed.
 */
export async function checkDsh(spec) {
  const dsh = await ensureDsh(spec)
  const home = await mkdtemp(join(tmpdir(), 'eedsh-matrix-home-'))
  const env = cleanEnv({ DSH_HOME: home, XDG_CONFIG_HOME: join(home, 'xdg') })
  const checks = {}
  try {
    const sync = await run(
      process.execPath,
      [cliPath, 'sync', '--strict', '--dsh', dsh.packageDir, '--config', fixture],
      { env },
    )
    checks.sync = /published profile cli-fixture|unchanged profile cli-fixture/.test(sync.stdout)
    checks.preflight = sync.stdout.includes('published profile cli-fixture')

    const dump = await run(
      process.execPath,
      [dsh.binPath, '--profile', 'cli-fixture', '--dump-config'],
      { env, cwd: home },
    )
    checks.dumpConfig = dump.stdout.includes('cli-row')

    const repl = await run(
      process.execPath,
      [cliPath, 'repl', '--eval', 'dshVersion()', '--dsh', dsh.packageDir, '--config', fixture],
      { env },
    )
    checks.dshVersion = repl.stdout.includes(dsh.version)

    const recordPath = join(home, 'profiles', 'cli-fixture', '.eedsh', 'generated', 'package.json')
    const record = JSON.parse(await readFile(recordPath, 'utf8'))
    checks.recordVersion = record.eedsh?.dshVersion === dsh.version
    checks.noEngines = record.engines === undefined

    const plan = JSON.parse(
      await readFile(join(home, 'profiles', 'cli-fixture', '.eedsh', 'plan.json'), 'utf8'),
    )
    checks.planV2 = plan.version === 2 && !('dsh' in plan)

    const drift = await checkDrift(dsh)
    checks.runtimeDrift = drift.ok

    checks.slowHmr = 'separate: pnpm test:slow with EEDSH_MATRIX_DSH_DIR against this installation'
    return {
      spec,
      version: dsh.version,
      ok: Object.entries(checks).every(([check, value]) => check === 'slowHmr' || value === true),
      checks,
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * Run the whole matrix.
 * @param versions - specs to check; defaults to the pinned versions.
 * @returns one result per spec.
 */
export async function runMatrix(versions = PINNED_VERSIONS) {
  if (!existsSync(cliPath)) {
    throw new Error('build the CLI first: pnpm build:packages')
  }
  const results = []
  for (const spec of versions) {
    results.push(await checkDsh(spec))
  }
  return results
}
