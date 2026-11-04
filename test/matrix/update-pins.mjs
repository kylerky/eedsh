#!/usr/bin/env node
/**
 * Refresh the frozen install fixtures below `test/matrix/pins`.
 *
 * `ensureDsh` installs every exact pinned version from these package.json and
 * pnpm-lock.yaml pairs with `--frozen-lockfile`. That keeps a pinned matrix case
 * testing the dependency graph it was verified against instead of whatever an
 * upstream semver range resolves to later. Run this script after changing
 * `PINNED_VERSIONS` and commit the regenerated fixtures.
 *
 * Dist-tags (`latest`, `alpha`) intentionally have no fixture: the canary jobs
 * resolve them live to detect upstream changes.
 */
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { PINNED_VERSIONS } from './harness.mjs'

const execFileAsync = promisify(execFile)
const pinsRoot = fileURLToPath(new URL('./pins/', import.meta.url))

/**
 * Resolve one version's full dependency graph and write its lockfile.
 * @param spec - the exact pinned version.
 */
async function updatePin(spec) {
  const work = await mkdtemp(join(tmpdir(), 'eedsh-matrix-pin-'))
  try {
    await writeFile(
      join(work, 'package.json'),
      `${JSON.stringify(
        {
          name: `eedsh-matrix-${spec.replace(/[^A-Za-z0-9.-]/g, '-')}`,
          private: true,
          dependencies: { '@deepseek-ai/dsh': spec },
        },
        null,
        2,
      )}\n`,
    )
    await execFileAsync(
      'pnpm',
      ['install', '--lockfile-only', '--ignore-scripts', '--trust-lockfile'],
      { cwd: work, maxBuffer: 64 * 1024 * 1024, timeout: 900_000 },
    )
    const target = join(pinsRoot, spec)
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    await cp(join(work, 'package.json'), join(target, 'package.json'))
    await cp(join(work, 'pnpm-lock.yaml'), join(target, 'pnpm-lock.yaml'))
    console.log(`updated ${spec}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

for (const spec of PINNED_VERSIONS) await updatePin(spec)
