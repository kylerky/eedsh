import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Layer } from 'effect'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import { resolveDshInstallation } from '../../src/dsh'
import { liveServiceLayer } from '../../src/internal/effect/layer'
import { materialize } from '../../src/materialize/program'
import { preflightLayer } from '../../src/preflight'
import { planOf } from '../support/plan'
import { bundle, generated, insert, layer, override } from '../support/plan-parts'

const execFileAsync = promisify(execFile)
const root = process.cwd()

describe('bootable profile integration', () => {
  it('composes generated rows and keeps the profile override on top', async () => {
    await mkdir(join(root, '.tmp'), { recursive: true })
    const home = await mkdtemp(join(root, '.tmp', 'dsh-home-'))
    const profileName = 'eedsh-integration'
    const profileDir = join(home, 'profiles', profileName)
    await mkdir(profileDir, { recursive: true })
    await writeFile(
      join(profileDir, 'cordis.patch.yml'),
      '- id: agent-default-model\n  config:\n    marker: user\n',
      'utf8',
    )

    const plan = planOf({
      name: profileName,
      bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
      layers: [
        layer('integration', [
          insert({ id: 'eedsh-it-a', name: '@scope/eedsh-it-a' }),
          insert({ id: 'eedsh-it-b', name: '@scope/eedsh-it-b' }),
          override('agent-default-model', { marker: 'generated' }),
        ]),
      ],
    })

    const services = Layer.mergeAll(
      liveServiceLayer,
      preflightLayer.pipe(Layer.provide(liveServiceLayer)),
    ).pipe(Layer.provideMerge(NodeServices.layer))
    const result = await Effect.runPromise(
      materialize({
        plan,
        profileDir,
        eedshVersion: '0.0.0',
        runtimeSpec: `link:${join(root, 'packages/runtime')}`,
        generatedSpec: 'link:./.eedsh/generated',
        strict: true,
        explain: false,
      }).pipe(Effect.provide(services)),
    )
    expect(result.changed).toBe(true)

    const { binPath } = Result.getOrThrow(resolveDshInstallation())
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, '--profile', profileName, '--dump-config'],
      { cwd: home, env: { ...process.env, DSH_HOME: home } },
    )

    const first = stdout.indexOf('id: eedsh-it-a')
    const second = stdout.indexOf('id: eedsh-it-b')
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(-1)
    expect(first).toBeLessThan(second)
    expect(stdout).toContain('marker: user')
    expect(stdout).not.toContain('marker: generated')
  }, 180_000)
})
