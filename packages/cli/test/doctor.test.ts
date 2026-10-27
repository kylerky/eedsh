import { bundle, generated, insert, layer } from '@eedsh/config'
import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { describe, expect, it } from 'vitest'
import {
  type DoctorFinding,
  type DoctorResult,
  doctor,
  doctorExitCode,
  formatDoctorReport,
} from '../src/doctor'
import { sha256 } from '../src/internal/sha256'
import { BUNDLE, harness, MANIFEST_PATH, PROFILE_DIR, RECORD_PATH } from './support/materialize'
import { planOf } from './support/plan'

const LOCKFILE_PATH = `${PROFILE_DIR}/pnpm-lock.yaml`

/** Lockfile text with the managed entries, optionally overridden. */
function lockfileText(options: { pluginSpecifier?: string; pluginVersion?: string } = {}): string {
  const specifier = options.pluginSpecifier ?? '1.0.0'
  const version = options.pluginVersion ?? '1.0.0'
  return `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@scope/plugin':
        specifier: ${specifier}
        version: ${version}
      '@eedsh/runtime':
        specifier: link:/repo/packages/runtime
      '@eedsh/generated':
        specifier: link:./.eedsh/generated
`
}

/** A plan whose managed package uses a semantic-version range. */
function rangePlan() {
  return planOf({
    name: 'work',
    dsh: '0.2.1-rc.2',
    bundles: [bundle(BUNDLE), generated()],
    layers: [layer('cli', [insert({ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' })])],
    packages: { '@scope/plugin': '^1.0.0' },
  })
}

function addInstalled(
  h: Awaited<ReturnType<typeof published>>,
  name: string,
  version: string,
): void {
  h.fs.files.set(
    `${PROFILE_DIR}/node_modules/${name}/package.json`,
    `${JSON.stringify({ name, version })}\n`,
  )
}

interface RuntimeStateOptions {
  pluginSpecifier?: string
  pluginVersion?: string
  pluginInstalledVersion?: string
  lockfile?: string
}

/** Write a lockfile and the installed packages a clean doctor run expects. */
function addRuntimeState(
  h: Awaited<ReturnType<typeof published>>,
  options: RuntimeStateOptions = {},
): void {
  h.fs.files.set(LOCKFILE_PATH, options.lockfile ?? lockfileText(options))
  addInstalled(
    h,
    '@scope/plugin',
    options.pluginInstalledVersion ?? options.pluginVersion ?? '1.0.0',
  )
  addInstalled(h, '@eedsh/runtime', '0.0.0')
  addInstalled(h, '@eedsh/generated', '0.0.0')
}

async function published(options: { range?: boolean } = {}) {
  const h = options.range === true ? harness({ plan: rangePlan() }) : harness()
  await h.run()
  addRuntimeState(h)
  return h
}

function diagnose(fs: FileSystem.FileSystem): Promise<DoctorResult> {
  return Effect.runPromise(
    doctor({ profileDir: PROFILE_DIR }).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
  )
}

function finding(result: DoctorResult, check: string): DoctorFinding | undefined {
  return result.findings.find((item) => item.check === check)
}

function recordOf(h: Awaited<ReturnType<typeof published>>): {
  eedsh: {
    generationId: string
    planHash: string
    bundles: string[]
    packages: Record<string, string>
  }
} {
  return JSON.parse(h.fs.files.get(RECORD_PATH) ?? '{}')
}

function editRecord(
  h: Awaited<ReturnType<typeof published>>,
  edit: (record: ReturnType<typeof recordOf>) => void,
): void {
  const record = recordOf(h)
  edit(record)
  h.fs.files.set(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`)
}

function planPath(h: Awaited<ReturnType<typeof published>>): string {
  return `${PROFILE_DIR}/.eedsh/generated/plans/${recordOf(h).eedsh.generationId}.json`
}

describe('doctor record checks', () => {
  it('reports a missing generation record as an error', async () => {
    const h = await published()
    h.fs.files.delete(RECORD_PATH)
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'record')).toMatchObject({
      severity: 'error',
      check: 'record',
      path: Option.some(RECORD_PATH),
    })
    expect(result.errors).toBe(1)
    expect(doctorExitCode(result, false)).toBe(1)
  })

  it('reports an unparseable generation record as an error', async () => {
    const h = await published()
    h.fs.files.set(RECORD_PATH, '{ not json')
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'record')).toMatchObject({ severity: 'error', check: 'record' })
    expect(finding(result, 'record')?.message).toContain('not valid JSON')
  })

  it('reports no record finding for a valid record', async () => {
    const h = await published()
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'record')).toBeUndefined()
  })
})

describe('doctor authoritative plan checks', () => {
  it('warns when the authoritative plan is missing', async () => {
    const h = await published()
    h.fs.files.delete(planPath(h))
    const result = await diagnose(h.fs.fs)
    const plan = finding(result, 'plan')
    expect(plan).toMatchObject({ severity: 'warning', check: 'plan' })
    expect(plan?.message).toContain('eedsh sync')
    expect(result.errors).toBe(0)
    expect(doctorExitCode(result, false)).toBe(0)
    expect(doctorExitCode(result, true)).toBe(1)
  })

  it('errors when the authoritative plan does not hash to the record', async () => {
    const h = await published()
    h.fs.files.set(planPath(h), '{"tampered":true}')
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'plan')).toMatchObject({ severity: 'error', check: 'plan' })
    expect(result.errors).toBeGreaterThan(0)
  })

  it('errors when the authoritative plan is not a valid plan', async () => {
    const h = await published()
    const content = '{"not":"a plan"}'
    h.fs.files.set(planPath(h), content)
    editRecord(h, (record) => {
      record.eedsh.planHash = sha256(content)
    })
    const result = await diagnose(h.fs.fs)
    const plan = finding(result, 'plan')
    expect(plan).toMatchObject({ severity: 'error', check: 'plan' })
    expect(plan?.message).toContain('not a valid profile plan')
  })
})

describe('doctor consistency checks', () => {
  it('errors when the record bundle order differs from the plan', async () => {
    const h = await published()
    editRecord(h, (record) => {
      record.eedsh.bundles = ['@deepseek-ai/dsh-base', '@eedsh/generated', '@eedsh/runtime']
    })
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'consistency')).toMatchObject({
      severity: 'error',
      check: 'consistency',
    })
  })

  it('errors when a record package specification differs from the plan', async () => {
    const h = await published()
    editRecord(h, (record) => {
      record.eedsh.packages['@scope/plugin'] = '9.9.9'
    })
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'consistency')).toMatchObject({
      severity: 'error',
      check: 'consistency',
    })
    expect(finding(result, 'consistency')?.message).toContain('@scope/plugin')
  })

  it('errors when the record lists a package the plan does not declare', async () => {
    const h = await published()
    editRecord(h, (record) => {
      record.eedsh.packages['@extra/plugin'] = '1.0.0'
    })
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'consistency')).toMatchObject({
      severity: 'error',
      check: 'consistency',
    })
    expect(finding(result, 'consistency')?.message).toContain('@extra/plugin')
  })

  it('warns when the plan mirror is missing or different', async () => {
    const h = await published()
    const mirrorPath = `${PROFILE_DIR}/.eedsh/plan.json`
    h.fs.files.delete(mirrorPath)
    const missing = await diagnose(h.fs.fs)
    expect(finding(missing, 'mirror')).toMatchObject({ severity: 'warning', check: 'mirror' })

    h.fs.files.set(mirrorPath, '{"different":true}\n')
    const different = await diagnose(h.fs.fs)
    expect(finding(different, 'mirror')).toMatchObject({ severity: 'warning', check: 'mirror' })
    expect(finding(different, 'mirror')?.message).toContain('eedsh sync')
  })

  it('reports no mirror finding for a matching mirror', async () => {
    const h = await published()
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'mirror')).toBeUndefined()
  })
})

describe('doctor manifest checks', () => {
  function editManifest(
    h: Awaited<ReturnType<typeof published>>,
    edit: (manifest: Record<string, unknown>) => void,
  ): string {
    const manifest = JSON.parse(h.fs.files.get(MANIFEST_PATH) ?? '{}') as Record<string, unknown>
    edit(manifest)
    const content = `${JSON.stringify(manifest, null, 2)}\n`
    h.fs.files.set(MANIFEST_PATH, content)
    return content
  }

  it('errors when a managed dependency was removed by hand', async () => {
    const h = await published()
    editManifest(h, (manifest) => {
      const dependencies = manifest.dependencies as Record<string, string>
      delete dependencies['@scope/plugin']
    })
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'manifest')).toMatchObject({ severity: 'error', check: 'manifest' })
    expect(finding(result, 'manifest')?.message).toContain('@scope/plugin')
    expect(doctorExitCode(result, false)).toBe(1)
  })

  it('errors when the managed bundles are out of recorded order', async () => {
    const h = await published()
    editManifest(h, (manifest) => {
      const dsh = manifest.dsh as { profile: { bundles: string[] } }
      dsh.profile.bundles = ['@eedsh/runtime', '@eedsh/generated', '@deepseek-ai/dsh-base']
    })
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'manifest')).toMatchObject({ severity: 'error', check: 'manifest' })
    expect(finding(result, 'manifest')?.message).toContain('managed bundles')
  })

  it('warns about managed duplicates in devDependencies without editing them', async () => {
    const h = await published()
    const content = editManifest(h, (manifest) => {
      manifest.devDependencies = { '@scope/plugin': '1.0.0' }
    })
    const result = await diagnose(h.fs.fs)
    const dependencies = finding(result, 'dependencies')
    expect(dependencies).toMatchObject({ severity: 'warning', check: 'dependencies' })
    expect(dependencies?.message).toContain('@scope/plugin')
    expect(dependencies?.message).toContain('devDependencies')
    expect(h.fs.files.get(MANIFEST_PATH)).toBe(content)
  })

  it('warns about overrides that name a managed package', async () => {
    const h = await published()
    editManifest(h, (manifest) => {
      manifest.pnpm = { overrides: { '@scope/plugin': '1.0.0' } }
    })
    const result = await diagnose(h.fs.fs)
    const dependencies = finding(result, 'dependencies')
    expect(dependencies).toMatchObject({ severity: 'warning', check: 'dependencies' })
    expect(dependencies?.message).toContain('resolved version may differ')
  })
})

describe('doctor scaffolding checks', () => {
  it('warns when a scaffolding file is missing', async () => {
    const h = await published()
    h.fs.files.delete(`${PROFILE_DIR}/cordis.yml`)
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'scaffolding')).toMatchObject({
      severity: 'warning',
      check: 'scaffolding',
    })
    expect(finding(result, 'scaffolding')?.message).toContain('cordis.yml')
  })

  it('reports no scaffolding finding for a complete profile', async () => {
    const h = await published()
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'scaffolding')).toBeUndefined()
  })
})

describe('doctor lockfile checks', () => {
  it('accepts a v9 lockfile with a root importer', async () => {
    const h = await published()
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'lockfile')).toBeUndefined()
  })

  it('accepts a single non-root importer', async () => {
    const h = await published()
    h.fs.files.set(LOCKFILE_PATH, lockfileText().replace('  .:', `  ${PROFILE_DIR}:`))
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'lockfile')).toBeUndefined()
  })

  it('errors when the lockfile is missing', async () => {
    const h = await published()
    h.fs.files.delete(LOCKFILE_PATH)
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'lockfile')).toMatchObject({
      severity: 'error',
      check: 'lockfile',
      path: Option.some(LOCKFILE_PATH),
    })
    expect(finding(result, 'lockfile')?.message).toContain('cannot be verified')
    expect(doctorExitCode(result, false)).toBe(1)
  })

  it('errors when a managed package is missing from the importer', async () => {
    const h = await published()
    h.fs.files.set(
      LOCKFILE_PATH,
      `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@eedsh/runtime':
        specifier: link:/repo/packages/runtime
      '@eedsh/generated':
        specifier: link:./.eedsh/generated
`,
    )
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'lockfile')).toMatchObject({ severity: 'error', check: 'lockfile' })
    expect(finding(result, 'lockfile')?.message).toContain('@scope/plugin')
  })

  it('warns when the lockfile specifier differs from the record', async () => {
    const h = await published()
    h.fs.files.set(LOCKFILE_PATH, lockfileText({ pluginSpecifier: '^1.0.0' }))
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'lockfile')).toMatchObject({ severity: 'warning', check: 'lockfile' })
    expect(finding(result, 'lockfile')?.message).toContain('^1.0.0')
    expect(result.errors).toBe(0)
  })

  it('errors when the resolved version is outside the recorded range', async () => {
    const h = await published()
    addRuntimeState(h, { pluginVersion: '2.0.0', pluginInstalledVersion: '2.0.0' })
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'lockfile')).toMatchObject({ severity: 'error', check: 'lockfile' })
    expect(finding(result, 'lockfile')?.message).toContain('2.0.0')
  })

  it('errors on an unsupported lockfile version', async () => {
    const h = await published()
    h.fs.files.set(
      LOCKFILE_PATH,
      lockfileText().replace("lockfileVersion: '9.0'", "lockfileVersion: '8.0'"),
    )
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'lockfile')).toMatchObject({ severity: 'error', check: 'lockfile' })
    expect(finding(result, 'lockfile')?.message).toContain('cannot be verified')
  })

  it('reports a missing root importer when importers is not a record', async () => {
    const h = await published()
    h.fs.files.set(LOCKFILE_PATH, ["lockfileVersion: '9.0'", 'importers: []', ''].join('\n'))
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'lockfile')).toMatchObject({ severity: 'error', check: 'lockfile' })
    expect(finding(result, 'lockfile')?.message).toBe(
      'the lockfile has no root importer, so the installed state cannot be verified; run "eedsh sync"',
    )
  })

  it('reports managed packages missing when importer dependencies is not a record', async () => {
    const h = await published()
    h.fs.files.set(
      LOCKFILE_PATH,
      ["lockfileVersion: '9.0'", 'importers:', '  .:', "    dependencies: 'not-a-record'", ''].join(
        '\n',
      ),
    )
    const result = await diagnose(h.fs.fs)
    const name = Object.keys(recordOf(h).eedsh.packages)[0]
    expect(finding(result, 'lockfile')).toMatchObject({ severity: 'error', check: 'lockfile' })
    expect(finding(result, 'lockfile')?.message).toBe(
      `managed package ${name} is missing from the lockfile root importer; run "eedsh sync"`,
    )
  })

  it('treats a non-object dependency entry as an empty entry', async () => {
    const h = await published()
    h.fs.files.set(
      LOCKFILE_PATH,
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        "      '@scope/plugin': not-an-entry",
        "      '@eedsh/runtime':",
        '        specifier: link:/repo/packages/runtime',
        "      '@eedsh/generated':",
        '        specifier: link:./.eedsh/generated',
        '',
      ].join('\n'),
    )
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'lockfile')).toMatchObject({ severity: 'error', check: 'lockfile' })
    expect(finding(result, 'lockfile')?.message).toBe(
      'the lockfile has no resolved version for @scope/plugin; run "eedsh sync"',
    )
  })

  it('keeps a valid version when the specifier is malformed', async () => {
    const h = await published()
    h.fs.files.set(
      LOCKFILE_PATH,
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        "      '@scope/plugin':",
        '        specifier: 42',
        '        version: 1.0.0',
        "      '@eedsh/runtime':",
        '        specifier: link:/repo/packages/runtime',
        "      '@eedsh/generated':",
        '        specifier: link:./.eedsh/generated',
        '',
      ].join('\n'),
    )
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'lockfile')).toBeUndefined()
    expect(result.errors).toBe(0)
    expect(result.warnings).toBe(0)
  })
})

describe('doctor installed checks', () => {
  it('accepts a clean installation', async () => {
    const h = await published()
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'installed')).toBeUndefined()
    expect(result.findings).toEqual([])
  })

  it('errors when a managed package is not installed', async () => {
    const h = await published()
    h.fs.files.delete(`${PROFILE_DIR}/node_modules/@scope/plugin/package.json`)
    const result = await diagnose(h.fs.fs)
    const installed = finding(result, 'installed')
    expect(installed).toMatchObject({ severity: 'error', check: 'installed' })
    expect(installed?.message).toContain('@scope/plugin')
    expect(doctorExitCode(result, false)).toBe(1)
  })

  it('errors when the installed version differs from the lockfile', async () => {
    const h = await published()
    addInstalled(h, '@scope/plugin', '1.2.0')
    const result = await diagnose(h.fs.fs)
    const installed = finding(result, 'installed')
    expect(installed).toMatchObject({ severity: 'error', check: 'installed' })
    expect(installed?.message).toContain('1.2.0')
    expect(installed?.message).toContain('1.0.0')
  })

  it('accepts an installed version inside the recorded range', async () => {
    const h = await published({ range: true })
    addRuntimeState(h, {
      pluginSpecifier: '^1.0.0',
      pluginVersion: '1.4.0',
      pluginInstalledVersion: '1.4.0',
    })
    const result = await diagnose(h.fs.fs)
    expect(finding(result, 'installed')).toBeUndefined()
    expect(result.findings).toEqual([])
  })

  it('reports a link specification without a range error', async () => {
    const h = await published()
    const result = await diagnose(h.fs.fs)
    expect(result.findings.filter((item) => item.check === 'installed')).toEqual([])
  })
})

describe('doctor report and exit status', () => {
  it('reports a clean summary for a valid profile', async () => {
    const h = await published()
    const result = await diagnose(h.fs.fs)
    expect(result.findings).toEqual([])
    expect(formatDoctorReport(result)).toEqual(['clean: 0 errors, 0 warnings'])
    expect(doctorExitCode(result, false)).toBe(0)
    expect(doctorExitCode(result, true)).toBe(0)
  })

  it('prints errors before warnings and ends with a summary', async () => {
    const h = await published()
    h.fs.files.delete(planPath(h))
    h.fs.files.delete(`${PROFILE_DIR}/cordis.yml`)
    const manifest = JSON.parse(h.fs.files.get(MANIFEST_PATH) ?? '{}') as {
      dependencies: Record<string, string>
    }
    delete manifest.dependencies['@scope/plugin']
    h.fs.files.set(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)

    const result = await diagnose(h.fs.fs)
    const lines = formatDoctorReport(result)
    expect(lines.at(-1)).toBe('1 error, 2 warnings')
    expect(lines[0]?.startsWith('error: manifest:')).toBe(true)
    expect(lines[1]?.startsWith('warning: plan:')).toBe(true)
    expect(lines[2]?.startsWith('warning: scaffolding:')).toBe(true)
    expect(doctorExitCode(result, false)).toBe(1)
  })

  it('omits the location for a finding with no path', () => {
    const result: DoctorResult = {
      findings: [
        {
          severity: 'error',
          check: 'record',
          message: 'boom',
          path: Option.none(),
        },
      ],
      errors: 1,
      warnings: 0,
    }
    expect(formatDoctorReport(result)).toEqual(['error: record: boom', '1 error, 0 warnings'])
  })

  it('exits 0 with warnings unless strict is set', async () => {
    const h = await published()
    h.fs.files.delete(planPath(h))
    const result = await diagnose(h.fs.fs)
    expect(result.errors).toBe(0)
    expect(result.warnings).toBeGreaterThan(0)
    expect(doctorExitCode(result, false)).toBe(0)
    expect(doctorExitCode(result, true)).toBe(1)
  })
})

describe('doctor is read-only', () => {
  it('changes no file and takes no lock', async () => {
    const h = await published()
    const files = new Map(h.fs.files)
    const writes = [...h.fs.writeOrder]
    const renames = [...h.fs.renameOrder]
    await diagnose(h.fs.fs)
    expect(new Map(h.fs.files)).toEqual(files)
    expect(h.fs.writeOrder).toEqual(writes)
    expect(h.fs.renameOrder).toEqual(renames)
  })
})

describe('doctor snapshot checks', () => {
  it('errors when a sync publishes during diagnosis', async () => {
    const h = await published()
    const original = h.fs.files.get(RECORD_PATH) ?? '{}'
    const changed = JSON.parse(original) as { eedsh: { generationId: string } }
    changed.eedsh.generationId = 'f'.repeat(64)
    const changedText = JSON.stringify(changed)
    let reads = 0
    const flaky: FileSystem.FileSystem = {
      ...h.fs.fs,
      readFileString: (path) => {
        if (path === RECORD_PATH) {
          reads += 1
          return Effect.succeed(reads > 1 ? changedText : original)
        }
        return h.fs.fs.readFileString(path)
      },
    }
    const result = await diagnose(flaky)
    expect(finding(result, 'snapshot')).toMatchObject({ severity: 'error', check: 'snapshot' })
    expect(finding(result, 'snapshot')?.message).toContain('changed during diagnosis')
    expect(doctorExitCode(result, false)).toBe(1)
  })

  it('errors when the record becomes unreadable during diagnosis', async () => {
    const h = await published()
    const original = h.fs.files.get(RECORD_PATH) ?? '{}'
    let reads = 0
    const flaky: FileSystem.FileSystem = {
      ...h.fs.fs,
      readFileString: (path) => {
        if (path === RECORD_PATH) {
          reads += 1
          return Effect.succeed(reads > 1 ? '{ broken' : original)
        }
        return h.fs.fs.readFileString(path)
      },
    }
    const result = await diagnose(flaky)
    expect(finding(result, 'snapshot')).toMatchObject({ severity: 'error', check: 'snapshot' })
  })
})
