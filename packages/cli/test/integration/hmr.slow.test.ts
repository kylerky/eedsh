import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProfilePlan } from '@eedsh/plan'
import { Effect } from 'effect'
import * as Result from 'effect/Result'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultServices } from '../../src/cli'
import { type DiscoveredDshInstallation, discoverDshInstallation } from '../../src/dsh'
import { loadDshBridge } from '../../src/dsh-bridge'
import { materialize } from '../../src/materialize/program'
import { delay, waitFor } from '../support/async'
import {
  clearDshBridge,
  clearTestBridge,
  devDshInstallation,
  installTestBridge,
} from '../support/bridge'
import { planOf } from '../support/plan'
import { bundle, disable, generated, layer } from '../support/plan-parts'

const execFileAsync = promisify(execFile)
const root = process.cwd()
let installation: DiscoveredDshInstallation = devDshInstallation()

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function waitForServerUrl(
  output: () => string,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = output().match(/dsh web: (http\S+)/)
    if (match?.[1] !== undefined) return match[1]
    await delay(200)
  }
  return undefined
}

function webPlan(name: string, layers: ProfilePlan['layers']): ProfilePlan {
  return planOf({
    name,
    bundles: [bundle('@deepseek-ai/dsh-base'), bundle('@deepseek-ai/dsh-web-app'), generated()],
    layers,
  })
}

describe('slow Web HMR integration', () => {
  beforeAll(async () => {
    await execFileAsync('pnpm', ['--filter', '@eedsh/runtime', 'build'], {
      cwd: root,
      shell: process.platform === 'win32',
    })
    const matrixDir = process.env.EEDSH_MATRIX_DSH_DIR
    if (matrixDir !== undefined && matrixDir !== '') {
      const nested = join(matrixDir, 'node_modules', '@deepseek-ai', 'dsh')
      const explicit = existsSync(nested) ? nested : matrixDir
      const discovered = discoverDshInstallation({ explicit, env: {}, cwd: root })
      if (Result.isFailure(discovered)) throw discovered.failure
      installation = discovered.success
      clearDshBridge()
      const loaded = await loadDshBridge(installation)
      if (Result.isFailure(loaded)) throw loaded.failure
    } else {
      await installTestBridge(installation.version)
    }
  }, 120_000)

  afterAll(() => {
    clearTestBridge()
  })

  it('reloads a published generation in a running web profile', async () => {
    await mkdir(join(root, '.tmp'), { recursive: true })
    const home = await mkdtemp(join(root, '.tmp', 'hmr-home-'))
    const profileName = 'eedsh-hmr'
    const profileDir = join(home, 'profiles', profileName)
    const port = await freePort()
    const runtimeSpec = `link:${join(root, 'packages/runtime')}`

    const publish = (plan: ProfilePlan) =>
      Effect.runPromise(
        materialize({
          plan,
          profileDir,
          eedshVersion: '0.0.0',
          runtimeSpec,
          generatedSpec: 'link:./.eedsh/generated',
          strict: false,
          explain: false,
        }).pipe(Effect.provide(defaultServices(installation))),
      )

    const first = await publish(webPlan(profileName, []))
    expect(first.changed).toBe(true)

    const { binPath } = installation
    const child = spawn(
      process.execPath,
      [binPath, '--profile', profileName, '--no-open', '--port', String(port)],
      {
        cwd: home,
        env: { ...process.env, DSH_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      output += String(chunk)
    })

    try {
      const url = await waitForServerUrl(() => output, 120_000)
      expect(url, `web profile did not start:\n${output}`).toBeDefined()

      const second = await publish(
        webPlan(profileName, [layer('eedsh', [disable('repeat-tool-reminder')])]),
      )
      expect(second.changed).toBe(true)
      expect(second.generationId).not.toBe(first.generationId)

      const reported = await waitFor(
        () =>
          output.includes(`generation ${second.generationId} applied`) ||
          (output.includes(`generation ${second.generationId}`) &&
            /requires a restart/.test(output)),
        120_000,
        150,
      )
      expect(reported, `watcher did not report the new generation:\n${output}`).toBe(true)
    } finally {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 10_000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }, 300_000)
})
