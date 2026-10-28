import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bundle, generated, insert, layer } from '../support/plan-parts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Layer } from 'effect'
import { afterAll, describe, expect, it } from 'vitest'
import { doctor, doctorExitCode, formatDoctorReport } from '../../src/doctor'
import {
  DshInstallation,
  PackageManager,
  Preflight,
  SyncLock,
} from '../../src/internal/effect/services'
import { materialize } from '../../src/materialize/program'
import { fakeDsh, fakePackageManager, fakePreflight, fakeSyncLock } from '../support/fakes'
import { planOf } from '../support/plan'

const root = process.cwd()
const tempRoot = join(root, 'packages/cli/.tmp')
const created: string[] = []

interface RecordShape {
  eedsh: { generationId: string; packages: Record<string, string> }
}

/** Publish a real profile on disk with fake package, DSH, preflight, and lock services. */
async function publish(): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  const profileDir = await mkdtemp(join(tempRoot, 'doctor-'))
  created.push(profileDir)
  const plan = planOf({
    name: 'doctor-it',
    dsh: '0.2.1-rc.2',
    bundles: [bundle('@deepseek-ai/dsh-base'), generated()],
    layers: [layer('it', [insert({ id: 'row', name: '@scope/row' })])],
  })
  const services = Layer.mergeAll(
    Layer.succeed(PackageManager, fakePackageManager().shape),
    Layer.succeed(DshInstallation, fakeDsh().shape),
    Layer.succeed(Preflight, fakePreflight().shape),
    Layer.succeed(SyncLock, fakeSyncLock().shape),
  ).pipe(Layer.provideMerge(NodeServices.layer))
  await Effect.runPromise(
    materialize({
      plan,
      profileDir,
      eedshVersion: '0.0.0',
      runtimeSpec: `link:${join(root, 'packages/runtime')}`,
      generatedSpec: 'link:./.eedsh/generated',
      strict: false,
      explain: false,
    }).pipe(Effect.provide(services)),
  )
  await addInstalledState(profileDir)
  return profileDir
}

/** Write the lockfile and installed packages a clean profile needs. */
async function addInstalledState(profileDir: string): Promise<void> {
  const record = await recordOf(profileDir)
  const entries = Object.entries(record.eedsh.packages)
    .map(([name, spec]) => `      '${name}':\n        specifier: ${spec}`)
    .join('\n')
  await writeFile(
    join(profileDir, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n${entries}\n`,
  )
  for (const name of Object.keys(record.eedsh.packages)) {
    const dir = join(profileDir, 'node_modules', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name, version: '0.0.0' })}\n`)
  }
}

async function recordOf(profileDir: string): Promise<RecordShape> {
  return JSON.parse(
    await readFile(join(profileDir, '.eedsh/generated/package.json'), 'utf8'),
  ) as RecordShape
}

async function diagnose(profileDir: string) {
  const result = await Effect.runPromise(
    doctor({ profileDir }).pipe(Effect.provide(NodeServices.layer)),
  )
  return {
    result,
    code: doctorExitCode(result, false),
    report: formatDoctorReport(result).join('\n'),
  }
}

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('doctor integration', () => {
  it('reports a freshly published profile as clean', async () => {
    const profileDir = await publish()
    const { result, code, report } = await diagnose(profileDir)
    expect(result.findings).toEqual([])
    expect(code).toBe(0)
    expect(report).toContain('clean: 0 errors, 0 warnings')
  })

  it('flags a corrupt generation record and exits 1', async () => {
    const profileDir = await publish()
    await writeFile(join(profileDir, '.eedsh/generated/package.json'), '{ broken')
    const { result, code, report } = await diagnose(profileDir)
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'error', check: 'record' }),
    )
    expect(code).toBe(1)
    expect(report).toContain('error: record:')
  })

  it('warns about a missing authoritative plan and honors --strict', async () => {
    const profileDir = await publish()
    const record = await recordOf(profileDir)
    await rm(join(profileDir, '.eedsh/generated/plans', `${record.eedsh.generationId}.json`))
    const { result, code, report } = await diagnose(profileDir)
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'warning', check: 'plan' }),
    )
    expect(result.errors).toBe(0)
    expect(code).toBe(0)
    expect(doctorExitCode(result, true)).toBe(1)
    expect(report).toContain('warning: plan:')
  })

  it('flags a hand-edited manifest and exits 1', async () => {
    const profileDir = await publish()
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    delete manifest.dependencies['@eedsh/runtime']
    await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const { result, code, report } = await diagnose(profileDir)
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'error', check: 'manifest' }),
    )
    expect(code).toBe(1)
    expect(report).toContain('@eedsh/runtime')
  })

  it('flags a missing lockfile and exits 1', async () => {
    const profileDir = await publish()
    await rm(join(profileDir, 'pnpm-lock.yaml'))
    const { result, code, report } = await diagnose(profileDir)
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'error', check: 'lockfile' }),
    )
    expect(code).toBe(1)
    expect(report).toContain('error: lockfile:')
  })

  it('flags a missing installed package and exits 1', async () => {
    const profileDir = await publish()
    await rm(join(profileDir, 'node_modules/@eedsh/runtime'), { recursive: true, force: true })
    const { result, code, report } = await diagnose(profileDir)
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'error', check: 'installed' }),
    )
    expect(code).toBe(1)
    expect(report).toContain('error: installed:')
  })
})
