import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Build the workspace packages once before any test file runs. Several tests
 * import the built `@eedsh/config` entry and the built CLI binary; building in a
 * per-file hook races with parallel workers that import those artifacts while
 * tsdown cleans `lib/`.
 */
export default async function setup(): Promise<void> {
  await execFileAsync('pnpm', ['-r', 'build'], {
    cwd: process.cwd(),
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
}
