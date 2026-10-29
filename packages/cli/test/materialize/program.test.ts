import { canonicalJson } from '@eedsh/plan'
import { describe, expect, it } from 'vitest'
import {
  BUNDLE,
  basePlan,
  failureOf,
  harness,
  MANIFEST_PATH,
  managedManifest,
  PROFILE_DIR,
  RECORD_PATH,
} from '../support/materialize'

describe('materialization notices', () => {
  it('returns an empty notice list for a normal first publish', async () => {
    const h = harness()
    const result = await h.run()
    expect(result.notices).toEqual([])
    expect(result.changed).toBe(true)
  })
})

describe('generation-record trust', () => {
  it('treats a valid record with unchanged inputs as unchanged', async () => {
    const h = harness()
    const first = await h.run()
    const second = await h.run()
    expect(second.changed).toBe(false)
    expect(second.generationId).toBe(first.generationId)
  })

  it('exposes a failing materialization for tests that need one', async () => {
    const h = harness({ installFail: true })
    const error = failureOf(await h.runExit())
    expect(error).toMatchObject({ _tag: 'PackageInstallFailure' })
  })
})

describe('authoritative plan verification', () => {
  function planFileFor(generationId: string): string {
    return `${PROFILE_DIR}/.eedsh/generated/plans/${generationId}.json`
  }

  it('republishes the same generation when the authoritative plan is missing', async () => {
    const h = harness()
    const first = await h.run()
    const installs = h.packages.installs.length
    const preflights = h.preflight.calls.length
    const planPath = planFileFor(first.generationId)
    expect(h.fs.files.has(planPath)).toBe(true)
    h.fs.files.delete(planPath)

    const second = await h.run()
    expect(second.changed).toBe(true)
    expect(second.generationId).toBe(first.generationId)
    expect(h.fs.files.get(planPath)).toBe(canonicalJson(basePlan()))
    expect(h.packages.installs.length).toBe(installs)
    expect(h.preflight.calls.length).toBe(preflights + 1)
  })

  it('republishes the same generation when the authoritative plan differs', async () => {
    const h = harness()
    const first = await h.run()
    const planPath = planFileFor(first.generationId)
    h.fs.files.set(planPath, '{"tampered":true}')

    const second = await h.run()
    expect(second.changed).toBe(true)
    expect(second.generationId).toBe(first.generationId)
    expect(h.fs.files.get(planPath)).toBe(canonicalJson(basePlan()))
  })

  it('treats an intact authoritative plan as unchanged', async () => {
    const h = harness()
    const first = await h.run()
    const second = await h.run()
    expect(second.changed).toBe(false)
    expect(h.fs.files.get(planFileFor(first.generationId))).toBe(canonicalJson(basePlan()))
  })
})

describe('plan mirror verification', () => {
  function mirrorPath(): string {
    return `${PROFILE_DIR}/.eedsh/plan.json`
  }

  it('republishes the same generation when the mirror is missing', async () => {
    const h = harness()
    const first = await h.run()
    const mirror = h.fs.files.get(mirrorPath())
    expect(mirror).toBe(`${canonicalJson(basePlan())}\n`)
    h.fs.files.delete(mirrorPath())

    const second = await h.run()
    expect(second.changed).toBe(true)
    expect(second.generationId).toBe(first.generationId)
    expect(h.fs.files.get(mirrorPath())).toBe(mirror)
  })

  it('republishes the same generation when the mirror differs', async () => {
    const h = harness()
    const first = await h.run()
    h.fs.files.set(mirrorPath(), '{"tampered":true}\n')

    const second = await h.run()
    expect(second.changed).toBe(true)
    expect(second.generationId).toBe(first.generationId)
    expect(h.fs.files.get(mirrorPath())).toBe(`${canonicalJson(basePlan())}\n`)
  })

  it('treats a semantically equal mirror as intact', async () => {
    const h = harness()
    await h.run()
    const reformatted = `${JSON.stringify(JSON.parse(canonicalJson(basePlan())), null, 4)}\n`
    h.fs.files.set(mirrorPath(), reformatted)

    const second = await h.run()
    expect(second.changed).toBe(false)
    expect(h.fs.files.get(mirrorPath())).toBe(reformatted)
  })
})

describe('provenance sidecar', () => {
  const SIDECAR_PATH = `${PROFILE_DIR}/.eedsh/provenance.json`
  const configDir = '/repo/config'
  const provenance = {
    profiles: {
      work: [{ label: 'cli', sites: [{ file: `${configDir}/config.ts`, line: 3, column: 5 }] }],
    },
  }

  it('does not write a sidecar for an unchanged materialization', async () => {
    const h = harness({ provenance, configDir })
    const first = await h.run()
    expect(first.changed).toBe(true)
    expect(JSON.parse(h.fs.files.get(SIDECAR_PATH) ?? '{}').generationId).toBe(first.generationId)
    h.fs.files.delete(SIDECAR_PATH)

    const second = await h.run()
    expect(second.changed).toBe(false)
    expect(h.fs.files.has(SIDECAR_PATH)).toBe(false)
  })
})

describe('dependency-section notices', () => {
  it('reports a cleanup notice in the materialization result', async () => {
    const h = harness()
    await h.run()
    const manifest = JSON.parse(h.fs.files.get(MANIFEST_PATH) ?? '{}') as {
      devDependencies?: Record<string, string>
    }
    manifest.devDependencies = { '@scope/plugin': '^1.0.0' }
    h.fs.files.set(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)

    const result = await h.run()
    expect(result.notices).toContainEqual({
      severity: 'notice',
      message: 'removed @scope/plugin from devDependencies',
    })
  })
})

describe('dependency-section install decisions', () => {
  it('installs when the only change is a cleaned dependency section', async () => {
    const h = harness()
    await h.run()
    expect(h.packages.installs).toEqual([PROFILE_DIR])
    const manifest = JSON.parse(h.fs.files.get(MANIFEST_PATH) ?? '{}') as {
      devDependencies?: Record<string, string>
    }
    manifest.devDependencies = { '@scope/plugin': '^1.0.0', '@scope/tool': '^2.0.0' }
    h.fs.files.set(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)

    const result = await h.run()
    expect(result.changed).toBe(true)
    expect(h.packages.installs).toEqual([PROFILE_DIR, PROFILE_DIR])
    const written = JSON.parse(h.fs.files.get(MANIFEST_PATH) ?? '{}') as {
      devDependencies?: Record<string, string>
    }
    expect(written.devDependencies).toEqual({ '@scope/tool': '^2.0.0' })
  })
})

describe('invalid generation records', () => {
  it('fails without writing when an eedsh-managed profile has an unparseable record', async () => {
    const manifest = managedManifest()
    const h = harness({ files: { [MANIFEST_PATH]: manifest, [RECORD_PATH]: '{ not json' } })
    const error = failureOf(await h.runExit())
    expect(error).toMatchObject({
      _tag: 'OwnershipRecordInvalid',
      path: RECORD_PATH,
      reason: 'unparseable',
      adoptable: true,
    })
    expect(h.fs.writeOrder).toEqual([])
    expect(h.fs.files.get(MANIFEST_PATH)).toBe(manifest)
  })

  it('fails without writing when an eedsh-managed profile has no record', async () => {
    const manifest = managedManifest()
    const h = harness({ files: { [MANIFEST_PATH]: manifest } })
    const error = failureOf(await h.runExit())
    expect(error).toMatchObject({
      _tag: 'OwnershipRecordInvalid',
      path: RECORD_PATH,
      reason: 'missing',
      adoptable: true,
    })
    expect(h.fs.writeOrder).toEqual([])
  })

  it('fails when a leftover generated directory marks the profile as published', async () => {
    const h = harness({
      files: { [MANIFEST_PATH]: JSON.stringify({ name: 'mine' }) },
      directories: [`${PROFILE_DIR}/.eedsh/generated`],
    })
    expect(failureOf(await h.runExit())).toMatchObject({
      _tag: 'OwnershipRecordInvalid',
      reason: 'missing',
    })
  })

  it('proceeds on a fresh profile without eedsh artifacts', async () => {
    const h = harness()
    const result = await h.run()
    expect(result.changed).toBe(true)
    expect(h.fs.files.has(RECORD_PATH)).toBe(true)
  })

  it('proceeds on an existing profile that eedsh never materialized', async () => {
    const h = harness({
      files: {
        [MANIFEST_PATH]: `${JSON.stringify({
          name: 'mine',
          dsh: { profile: { bundles: ['@user/bundle'] } },
        })}\n`,
      },
    })
    const result = await h.run()
    expect(result.changed).toBe(true)
    expect(h.fs.files.has(RECORD_PATH)).toBe(true)
  })

  it('adopts ownership from the live manifest and reports the adopted names', async () => {
    const userBundle = '@edsh/adapted-ptc'
    const userPackage = '@user/plugin'
    const h = harness({
      files: {
        [MANIFEST_PATH]: `${JSON.stringify(
          {
            name: 'dsh-profile-work',
            private: true,
            dsh: {
              profile: { bundles: [BUNDLE, '@eedsh/runtime', '@eedsh/generated', userBundle] },
            },
            dependencies: {
              [userPackage]: '2.0.0',
              '@eedsh/runtime': 'link:/repo/packages/runtime',
              '@eedsh/generated': 'link:./.eedsh/generated',
            },
          },
          null,
          2,
        )}\n`,
        [RECORD_PATH]: '{ not json',
      },
    })
    const result = await h.run({ adoptOwnership: true })
    expect(result.changed).toBe(true)
    expect(result.notices).toContainEqual({
      severity: 'notice',
      message: expect.stringContaining(userBundle),
    })
    expect(result.notices).toContainEqual({
      severity: 'notice',
      message: expect.stringContaining(userPackage),
    })
    const manifest = JSON.parse(h.fs.files.get(MANIFEST_PATH) ?? '{}') as {
      dsh: { profile: { bundles: string[] } }
      dependencies: Record<string, string>
    }
    expect(manifest.dsh.profile.bundles).toContain(userBundle)
    expect(manifest.dependencies[userPackage]).toBe('2.0.0')
    const record = JSON.parse(h.fs.files.get(RECORD_PATH) ?? '{}') as {
      eedsh: { generationId: string; bundles: string[] }
    }
    expect(record.eedsh.generationId).toBe(result.generationId)
    expect(record.eedsh.bundles).not.toContain(userBundle)
  })

  it('refuses to adopt a newer record version', async () => {
    const h = harness({
      files: {
        [MANIFEST_PATH]: managedManifest(),
        [RECORD_PATH]: JSON.stringify({
          name: '@eedsh/generated',
          eedsh: { format: 'eedsh/generation', version: 2 },
        }),
      },
    })
    const error = failureOf(await h.runExit({ adoptOwnership: true }))
    expect(error).toMatchObject({
      _tag: 'OwnershipRecordInvalid',
      reason: 'version',
      adoptable: false,
    })
    expect(h.fs.writeOrder).toEqual([])
  })
})
