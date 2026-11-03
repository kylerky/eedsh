/**
 * The read-only `eedsh doctor` pipeline. It inspects a published profile and
 * reports findings; it never writes, takes no lock, and never repairs. Findings
 * name the command that can repair the profile: `eedsh sync` or
 * `eedsh sync --adopt-ownership`.
 * @module @eedsh/cli/doctor
 */
import { isAbsolute, join } from 'node:path'
import { canonicalJson, type PlanSource, type ProfilePlan, ProfilePlanSchema } from '@eedsh/plan'
import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as yaml from 'js-yaml'
import type { DiscoveredDshInstallation } from './dsh-discovery'
import { SUPPORTED_DSH_RANGE, supportsDshVersion } from './dsh-policy'
import { EXIT_FAILURE, EXIT_OK } from './exit'
import { messageOf } from './internal/error-message'
import { readOptional } from './internal/read-optional'
import {
  type LockfileEntry,
  readRecord as readJsonRecord,
  readLockfileEntry,
} from './internal/schema-readers'
import { isSemverRange, versionSatisfies } from './internal/semver'
import { sha256 } from './internal/sha256'
import {
  authoritativePlanPath,
  GENERATED_PACKAGE_NAME,
  type GenerationRecord,
  RUNTIME_PACKAGE_NAME,
} from './materialize/generated-bundle'
import {
  type InvalidGenerationRecord,
  lookupGenerationRecord,
  missingGenerationRecord,
} from './materialize/generation-record'
import {
  managedBundleOrder,
  readProfileBundles,
  readProfileDependencies,
  scanDependencyConflicts,
} from './materialize/manifest'
import {
  GENERATED_DIRNAME,
  GENERATED_MANIFEST_RELATIVE_PATH,
  PLAN_RELATIVE_PATH,
  PROFILE_PATCH_FILENAME,
  PROFILE_ROOT_FILENAME,
  PROFILE_WORKSPACE_FILENAME,
} from './materialize/profile'
import { readSourceRecord } from './provision/record'
import {
  resolveSourceLocation,
  sourceAcquisitionKind,
  sourceCheckoutDir,
  sourceKey,
  sourceLinkSpec,
  sourceStatePath,
} from './provision/source'
import { verifyProvisionedPackage } from './provision/verify'

/** The severity of one doctor finding. */
export type DoctorSeverity = 'error' | 'warning'

/** One located problem in a published profile. */
export interface DoctorFinding {
  readonly severity: DoctorSeverity
  /** The check that produced the finding. */
  readonly check: string
  readonly message: string
  /** The affected path, when the finding names one. */
  readonly path: Option.Option<string>
}

/** Provenance of the DSH installation doctor inspected. */
export interface DoctorDsh {
  readonly version: string
  readonly installAnchor: string
  readonly supported: boolean
}

/** The complete result of one doctor run. */
export interface DoctorResult {
  /** Errors first, then warnings, each sorted by check and message. */
  readonly findings: DoctorFinding[]
  readonly errors: number
  readonly warnings: number
  /** The discovered installation, when one was supplied. */
  readonly dsh?: DoctorDsh
}

/** Inputs for {@link doctor}. */
export interface DoctorOptions {
  /** Absolute path of the published profile to inspect. */
  profileDir: string
  /** Absolute DSH home; provisioned checkouts and records live below it. */
  dshHome: string
  /** The discovered DSH installation, when discovery succeeded. */
  dsh?: DiscoveredDshInstallation
}

/** The scaffolding files a published profile should carry. */
const SCAFFOLDING: readonly { file: string; label: string }[] = [
  { file: PROFILE_ROOT_FILENAME, label: 'root configuration' },
  { file: PROFILE_PATCH_FILENAME, label: 'profile patch' },
  { file: PROFILE_WORKSPACE_FILENAME, label: 'pnpm workspace file' },
]

function compareStrings(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

function compareFindings(a: DoctorFinding, b: DoctorFinding): number {
  if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
  return compareStrings(
    `${a.check}\u0000${a.message}\u0000${Option.getOrElse(a.path, () => '')}`,
    `${b.check}\u0000${b.message}\u0000${Option.getOrElse(b.path, () => '')}`,
  )
}

function errorFinding(check: string, message: string, path: Option.Option<string>): DoctorFinding {
  return { severity: 'error', check, message, path }
}

function warningFinding(
  check: string,
  message: string,
  path: Option.Option<string>,
): DoctorFinding {
  return { severity: 'warning', check, message, path }
}

function summarize(findings: DoctorFinding[], dsh?: DoctorDsh): DoctorResult {
  const sorted = [...findings].sort(compareFindings)
  const errors = sorted.filter((item) => item.severity === 'error').length
  return {
    findings: sorted,
    errors,
    warnings: sorted.length - errors,
    ...(dsh === undefined ? {} : { dsh }),
  }
}

function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

/**
 * Format a doctor result as the plain-text report the CLI prints.
 * @param result - the findings and counts.
 * @returns report lines, errors first, with a trailing summary.
 */
export function formatDoctorReport(result: DoctorResult): string[] {
  const summary = `${plural(result.errors, 'error')}, ${plural(result.warnings, 'warning')}`
  const lines: string[] = []
  if (result.dsh !== undefined) {
    lines.push(
      `dsh: ${result.dsh.version} (${result.dsh.installAnchor})${result.dsh.supported ? '' : ' [unsupported]'}`,
    )
  }
  if (result.findings.length === 0) return [...lines, `clean: ${summary}`]
  lines.push(
    ...result.findings.map((finding) => {
      const location = Option.isNone(finding.path) ? '' : ` [${finding.path.value}]`
      return `${finding.severity}: ${finding.check}: ${finding.message}${location}`
    }),
  )
  return [...lines, summary]
}

/**
 * Map a doctor result to the command exit status.
 * @param result - the findings and counts.
 * @param strict - treat warnings as failures.
 * @returns the exit status.
 */
export function doctorExitCode(result: DoctorResult, strict: boolean): number {
  if (result.errors > 0) return EXIT_FAILURE
  return strict && result.warnings > 0 ? EXIT_FAILURE : EXIT_OK
}

function existsOrFalse(fs: FileSystem.FileSystem, path: string): Effect.Effect<boolean> {
  return fs.exists(path).pipe(Effect.orElseSucceed(() => false))
}

function parseJson(text: string): Result.Result<unknown, string> {
  return Result.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => messageOf(cause),
  })
}

const jsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const installedManifestSchema = Schema.Struct({ version: Schema.String })

function recordProblem(invalid: InvalidGenerationRecord): string {
  const recovery = invalid.adoptable
    ? '; run "eedsh sync --adopt-ownership" to re-baseline ownership from the current manifest'
    : ''
  return `${invalid.detail}${recovery}`
}

/** Read and validate the record, or report why the pipeline cannot continue. */
function readRecord(
  fs: FileSystem.FileSystem,
  recordPath: string,
  findings: DoctorFinding[],
): Effect.Effect<Option.Option<GenerationRecord>> {
  return Effect.gen(function* () {
    const lookup = yield* lookupGenerationRecord(recordPath, fs).pipe(Effect.result)
    if (Result.isFailure(lookup)) {
      findings.push(
        errorFinding(
          'record',
          `cannot read the generation record: ${messageOf(lookup.failure)}`,
          Option.some(recordPath),
        ),
      )
      return Option.none()
    }
    if (lookup.success._tag === 'valid') return Option.some(lookup.success.record)
    const invalid =
      lookup.success._tag === 'invalid' ? lookup.success : missingGenerationRecord(recordPath)
    findings.push(errorFinding('record', recordProblem(invalid), Option.some(recordPath)))
    return Option.none()
  })
}

/** Verify the authoritative plan: presence, hash, and plan decoding. */
function readPlan(
  fs: FileSystem.FileSystem,
  profileDir: string,
  record: GenerationRecord,
  findings: DoctorFinding[],
): Effect.Effect<Option.Option<ProfilePlan>> {
  return Effect.gen(function* () {
    const path = join(profileDir, GENERATED_DIRNAME, authoritativePlanPath(record.generationId))
    const read = yield* readOptional(fs, path).pipe(Effect.result)
    if (Result.isFailure(read)) {
      findings.push(
        errorFinding(
          'plan',
          `cannot read the authoritative plan: ${messageOf(read.failure)}`,
          Option.some(path),
        ),
      )
      return Option.none()
    }
    if (Option.isNone(read.success)) {
      findings.push(
        warningFinding(
          'plan',
          'the authoritative plan is missing; run "eedsh sync" to republish it',
          Option.some(path),
        ),
      )
      return Option.none()
    }
    if (sha256(read.success.value) !== record.planHash) {
      findings.push(
        errorFinding(
          'plan',
          'the authoritative plan does not hash to the recorded plan hash; run "eedsh sync" to republish it',
          Option.some(path),
        ),
      )
      return Option.none()
    }
    const parsed = parseJson(read.success.value)
    if (Result.isFailure(parsed)) {
      findings.push(
        errorFinding(
          'plan',
          `the authoritative plan is not valid JSON: ${parsed.failure}`,
          Option.some(path),
        ),
      )
      return Option.none()
    }
    const planVersion = (parsed.success as { version?: unknown }).version
    if (typeof planVersion === 'number' && planVersion !== 2) {
      findings.push(
        errorFinding(
          'plan',
          `the authoritative plan declares unsupported version ${String(planVersion)}; run "eedsh sync" to publish a version 2 plan`,
          Option.some(path),
        ),
      )
      return Option.none()
    }
    const decoded = Schema.decodeUnknownResult(ProfilePlanSchema)(parsed.success)
    if (Result.isFailure(decoded)) {
      const detail = decoded.failure.message.split('\n')[0] ?? decoded.failure.message
      findings.push(
        errorFinding(
          'plan',
          `the authoritative plan is not a valid profile plan: ${detail}`,
          Option.some(path),
        ),
      )
      return Option.none()
    }
    return Option.some(decoded.success)
  })
}

/**
 * Verify that the record's managed sets agree with the authoritative plan.
 * The advisory provenance sidecar is deliberately outside this check: it is not
 * required for a profile to be correct or bootable, so an absent, unreadable, or
 * generation-mismatched sidecar must never produce a finding or affect exit status.
 */
function checkConsistency(
  record: GenerationRecord,
  plan: ProfilePlan,
  recordPath: string,
  findings: DoctorFinding[],
): void {
  const expectedBundles = managedBundleOrder(plan)
  if (canonicalJson(record.bundles) !== canonicalJson(expectedBundles)) {
    findings.push(
      errorFinding(
        'consistency',
        `the record's managed bundle order does not match the plan (record: ${record.bundles.join(', ')}; plan: ${expectedBundles.join(', ')}); run "eedsh sync"`,
        Option.some(recordPath),
      ),
    )
  }

  const specMismatches = Object.entries(plan.packages)
    .filter(([name, spec]) => record.packages[name] !== spec)
    .map(([name, spec]) => `${name} (record: ${record.packages[name] ?? 'missing'}, plan: ${spec})`)
  if (specMismatches.length > 0) {
    findings.push(
      errorFinding(
        'consistency',
        `the record's managed package specifications do not match the plan: ${specMismatches.join(', ')}; run "eedsh sync"`,
        Option.some(recordPath),
      ),
    )
  }

  const expectedNames = new Set([
    ...Object.keys(plan.packages),
    ...Object.keys(plan.sources ?? {}),
    RUNTIME_PACKAGE_NAME,
    GENERATED_PACKAGE_NAME,
  ])
  const extras = Object.keys(record.packages)
    .filter((name) => !expectedNames.has(name))
    .sort()
  const missing = [...expectedNames].filter((name) => !(name in record.packages)).sort()
  if (extras.length > 0 || missing.length > 0) {
    const parts: string[] = []
    if (extras.length > 0) parts.push(`unexpected: ${extras.join(', ')}`)
    if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`)
    findings.push(
      errorFinding(
        'consistency',
        `the record's managed packages differ from the plan's (${parts.join('; ')}); run "eedsh sync"`,
        Option.some(recordPath),
      ),
    )
  }
}

/**
 * Verify that the stable mirror carries the authoritative plan. The provenance
 * sidecar next to it is not consulted here.
 */
function checkMirror(
  fs: FileSystem.FileSystem,
  profileDir: string,
  plan: ProfilePlan,
  findings: DoctorFinding[],
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const path = join(profileDir, PLAN_RELATIVE_PATH)
    const read = yield* readOptional(fs, path).pipe(Effect.result)
    if (Result.isFailure(read)) {
      findings.push(
        warningFinding(
          'mirror',
          `cannot read the plan mirror: ${messageOf(read.failure)}`,
          Option.some(path),
        ),
      )
      return
    }
    if (Option.isNone(read.success)) {
      findings.push(
        warningFinding(
          'mirror',
          'the plan mirror is missing; run "eedsh sync" to rewrite it',
          Option.some(path),
        ),
      )
      return
    }
    const parsed = parseJson(read.success.value)
    if (Result.isFailure(parsed)) {
      findings.push(
        warningFinding(
          'mirror',
          'the plan mirror is not valid JSON; run "eedsh sync" to rewrite it',
          Option.some(path),
        ),
      )
      return
    }
    if (canonicalJson(parsed.success) !== canonicalJson(plan)) {
      findings.push(
        warningFinding(
          'mirror',
          'the plan mirror does not match the authoritative plan; run "eedsh sync" to rewrite it',
          Option.some(path),
        ),
      )
    }
  })
}

/** Verify managed bundles, managed dependencies, and dependency-section conflicts. */
function checkManifest(
  fs: FileSystem.FileSystem,
  profileDir: string,
  record: GenerationRecord,
  findings: DoctorFinding[],
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const path = join(profileDir, 'package.json')
    const read = yield* readOptional(fs, path).pipe(Effect.result)
    if (Result.isFailure(read)) {
      findings.push(
        errorFinding(
          'manifest',
          `cannot read the profile manifest: ${messageOf(read.failure)}`,
          Option.some(path),
        ),
      )
      return
    }
    if (Option.isNone(read.success)) {
      findings.push(
        errorFinding(
          'manifest',
          'the profile manifest is missing; run "eedsh sync"',
          Option.some(path),
        ),
      )
      return
    }
    const parsed = parseJson(read.success.value)
    const decoded = Result.isSuccess(parsed)
      ? Schema.decodeUnknownOption(jsonRecordSchema)(parsed.success)
      : Option.none()
    if (Option.isNone(decoded)) {
      findings.push(
        errorFinding(
          'manifest',
          'the profile manifest is not a JSON object; run "eedsh sync"',
          Option.some(path),
        ),
      )
      return
    }
    const manifest = { ...decoded.value }

    const listed = readProfileBundles(Option.some(manifest))
    const prefixIntact =
      listed.length >= record.bundles.length &&
      record.bundles.every((name, index) => listed[index] === name)
    if (!prefixIntact) {
      findings.push(
        errorFinding(
          'manifest',
          `managed bundles must start with ${record.bundles.join(', ')} in recorded order; run "eedsh sync"`,
          Option.some(path),
        ),
      )
    }

    const dependencies = readProfileDependencies(Option.some(manifest)).dependencies
    for (const [name, spec] of Object.entries(record.packages)) {
      if (dependencies[name] === spec) continue
      const found = dependencies[name]
      findings.push(
        errorFinding(
          'manifest',
          `managed package ${name} must be declared as ${spec} in dependencies${found === undefined ? '' : ` (found ${found})`}; run "eedsh sync"`,
          Option.some(path),
        ),
      )
    }

    const scan = scanDependencyConflicts(
      Option.some(manifest),
      new Set(Object.keys(record.packages)),
    )
    for (const section of scan.malformed) {
      findings.push(
        warningFinding(
          'dependencies',
          `${section} is not a record of package specifications; eedsh sync leaves it unchanged`,
          Option.some(path),
        ),
      )
    }
    for (const conflict of scan.conflicts) {
      const message =
        conflict.field === 'devDependencies' || conflict.field === 'optionalDependencies'
          ? `managed package ${conflict.name} is also declared in ${conflict.field}; run "eedsh sync" to remove it`
          : `managed package ${conflict.name} is also declared in ${conflict.field}; the resolved version may differ`
      findings.push(warningFinding('dependencies', message, Option.some(path)))
    }
  })
}

const COMMIT_SHA = /^[0-9a-f]{7,64}$/i

/** The commit a provisioned working tree is checked out at, from its refs. */
function readCheckedOutCommit(
  fs: FileSystem.FileSystem,
  checkoutDir: string,
): Effect.Effect<Option.Option<string>> {
  return Effect.gen(function* () {
    const head = yield* readOptional(fs, join(checkoutDir, '.git', 'HEAD')).pipe(Effect.result)
    if (Result.isFailure(head) || Option.isNone(head.success)) return Option.none()
    const value = head.success.value.trim()
    if (value.startsWith('ref: ')) {
      const ref = yield* readOptional(fs, join(checkoutDir, '.git', value.slice(5).trim())).pipe(
        Effect.result,
      )
      if (Result.isFailure(ref) || Option.isNone(ref.success)) return Option.none()
      const commit = ref.success.value.trim()
      return COMMIT_SHA.test(commit) ? Option.some(commit) : Option.none()
    }
    return COMMIT_SHA.test(value) ? Option.some(value) : Option.none()
  })
}

/**
 * The derived manifest specification for a source, when the declaration alone
 * determines it. A git source always does; a local checkout does only when its
 * declared location is absolute or home-relative.
 */
function derivedSourceSpec(declaration: PlanSource, dshHome: string): string | undefined {
  if (sourceAcquisitionKind(declaration.from) === 'git') {
    return sourceLinkSpec(sourceCheckoutDir(dshHome, sourceKey(declaration)))
  }
  const from = declaration.from
  const machineLocal =
    isAbsolute(from) || from === '~' || from.startsWith('~/') || from.startsWith('~\\')
  return machineLocal ? sourceLinkSpec(resolveSourceLocation(from, dshHome).location) : undefined
}

/**
 * Verify provisioned sources without provisioning: read the published plan's
 * source declarations, require the manifest to name each provisioned location,
 * require the location and its entry points to exist, and warn when a working
 * tree sits at a commit other than the recorded one.
 */
function checkSources(
  fs: FileSystem.FileSystem,
  profileDir: string,
  plan: ProfilePlan,
  dshHome: string,
  findings: DoctorFinding[],
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const sources = plan.sources ?? {}
    const names = Object.keys(sources).sort()
    if (names.length === 0) return

    const manifestPath = join(profileDir, 'package.json')
    const read = yield* readOptional(fs, manifestPath).pipe(Effect.result)
    let dependencies: Readonly<Record<string, string>> | undefined
    if (Result.isSuccess(read) && Option.isSome(read.success)) {
      const parsed = parseJson(read.success.value)
      if (Result.isSuccess(parsed)) {
        const decoded = Schema.decodeUnknownOption(jsonRecordSchema)(parsed.success)
        if (Option.isSome(decoded)) {
          dependencies = readProfileDependencies(Option.some({ ...decoded.value })).dependencies
        }
      }
    }

    for (const name of names) {
      const declaration = sources[name] as PlanSource
      const expected = derivedSourceSpec(declaration, dshHome)
      const declared = dependencies?.[name]
      if (dependencies !== undefined && expected !== undefined && declared !== expected) {
        findings.push(
          errorFinding(
            'sources',
            `the profile manifest declares source ${name} as ${declared ?? 'nothing'}, but its provisioned location is ${expected}; run "eedsh sync"`,
            Option.some(manifestPath),
          ),
        )
      }

      const spec = dependencies === undefined ? expected : (declared ?? expected)
      if (spec === undefined || !spec.startsWith('link:')) {
        findings.push(
          errorFinding(
            'sources',
            `source ${name} has no link specification in the profile manifest; run "eedsh sync"`,
            Option.some(manifestPath),
          ),
        )
        continue
      }
      const location = spec.slice('link:'.length)
      if (!(yield* existsOrFalse(fs, location))) {
        findings.push(
          errorFinding(
            'sources',
            `the provisioned source ${name} is missing at ${location}; run "eedsh sync"`,
            Option.some(location),
          ),
        )
        continue
      }

      const verified = yield* verifyProvisionedPackage({ name, packageDir: location }).pipe(
        Effect.result,
      )
      if (Result.isFailure(verified)) {
        const failure = verified.failure
        const path = 'path' in failure && typeof failure.path === 'string' ? failure.path : location
        findings.push(
          errorFinding('sources', `${messageOf(failure)}; run "eedsh sync"`, Option.some(path)),
        )
      }

      if (sourceAcquisitionKind(declaration.from) !== 'git') continue
      const checkedOut = yield* readCheckedOutCommit(fs, location)
      const recordRead = yield* readSourceRecord(
        fs,
        sourceStatePath(dshHome, sourceKey(declaration)),
      ).pipe(Effect.result)
      if (Result.isFailure(recordRead)) continue
      const record = recordRead.success
      if (
        record?.commit !== undefined &&
        Option.isSome(checkedOut) &&
        checkedOut.value !== record.commit
      ) {
        findings.push(
          warningFinding(
            'sources',
            `the provisioned checkout for ${name} is at ${checkedOut.value}, but the recorded commit is ${record.commit}; run "eedsh sync" to update it`,
            Option.some(location),
          ),
        )
      }
    }
  })
}

/** Warn about every missing scaffolding file. */
function checkScaffolding(
  fs: FileSystem.FileSystem,
  profileDir: string,
  findings: DoctorFinding[],
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const { file, label } of SCAFFOLDING) {
      const path = join(profileDir, file)
      if (yield* existsOrFalse(fs, path)) continue
      findings.push(
        warningFinding(
          'scaffolding',
          `the ${label} (${file}) is missing; run "eedsh sync" to recreate it`,
          Option.some(path),
        ),
      )
    }
  })
}

/** Resolved dependency entries from the lockfile root importer. */
type LockfileDependencies = ReadonlyMap<string, LockfileEntry>

/** Strip a trailing pnpm peer suffix such as `(peer@1.0.0)`. */
function resolvedVersion(version: string): Option.Option<string> {
  const base = version.split('(')[0]?.trim()
  return base === undefined || base === '' ? Option.none() : Option.some(base)
}

/** Read the lockfile and verify every managed entry and resolved range. */
function checkLockfile(
  fs: FileSystem.FileSystem,
  profileDir: string,
  record: GenerationRecord,
  findings: DoctorFinding[],
): Effect.Effect<Option.Option<LockfileDependencies>> {
  return Effect.gen(function* () {
    const path = join(profileDir, 'pnpm-lock.yaml')
    const read = yield* readOptional(fs, path).pipe(Effect.result)
    if (Result.isFailure(read)) {
      findings.push(
        errorFinding(
          'lockfile',
          `cannot read pnpm-lock.yaml: ${messageOf(read.failure)}`,
          Option.some(path),
        ),
      )
      return Option.none()
    }
    const text = read.success
    if (Option.isNone(text)) {
      findings.push(
        errorFinding(
          'lockfile',
          'there is no pnpm-lock.yaml, so the installed state cannot be verified; run "eedsh sync"',
          Option.some(path),
        ),
      )
      return Option.none()
    }
    const parsed = yield* Effect.try({
      try: () => yaml.load(text.value) as unknown,
      catch: (cause) => messageOf(cause),
    }).pipe(Effect.result)
    if (Result.isFailure(parsed)) {
      findings.push(
        errorFinding(
          'lockfile',
          `cannot parse pnpm-lock.yaml: ${parsed.failure}`,
          Option.some(path),
        ),
      )
      return Option.none()
    }
    const decoded = Schema.decodeUnknownOption(jsonRecordSchema)(parsed.success)
    if (Option.isNone(decoded)) {
      findings.push(
        errorFinding('lockfile', 'the lockfile is not a YAML object', Option.some(path)),
      )
      return Option.none()
    }
    const lockfile = { ...decoded.value }
    const version = String(lockfile.lockfileVersion ?? '')
    if (!/^9(?:\.|$)/.test(version)) {
      findings.push(
        errorFinding(
          'lockfile',
          `unsupported lockfile version ${version === '' ? '(missing)' : version}; the installed state cannot be verified`,
          Option.some(path),
        ),
      )
      return Option.none()
    }
    const importers = readJsonRecord(lockfile.importers)
    const names = Object.keys(importers)
    const importerValue =
      importers['.'] ?? (names.length === 1 ? importers[names[0] as string] : undefined)
    const importer = Schema.decodeUnknownOption(jsonRecordSchema)(importerValue)
    if (Option.isNone(importer)) {
      findings.push(
        errorFinding(
          'lockfile',
          'the lockfile has no root importer, so the installed state cannot be verified; run "eedsh sync"',
          Option.some(path),
        ),
      )
      return Option.none()
    }
    const dependencies = readJsonRecord(importer.value.dependencies)
    const entries = new Map<string, LockfileEntry>()
    for (const [name, value] of Object.entries(dependencies)) {
      entries.set(name, readLockfileEntry(value))
    }

    for (const [name, spec] of Object.entries(record.packages)) {
      const entry = Option.fromUndefinedOr(entries.get(name))
      if (Option.isNone(entry)) {
        findings.push(
          errorFinding(
            'lockfile',
            `managed package ${name} is missing from the lockfile root importer; run "eedsh sync"`,
            Option.some(path),
          ),
        )
        continue
      }
      if (Option.isSome(entry.value.specifier) && entry.value.specifier.value !== spec) {
        findings.push(
          warningFinding(
            'lockfile',
            `the lockfile specifier "${entry.value.specifier.value}" for ${name} differs from the recorded specification "${spec}"; pnpm may normalize it`,
            Option.some(path),
          ),
        )
      }
      if (!isSemverRange(spec)) continue
      const resolved = Option.flatMap(entry.value.version, resolvedVersion)
      if (Option.isNone(resolved)) {
        findings.push(
          errorFinding(
            'lockfile',
            `the lockfile has no resolved version for ${name}; run "eedsh sync"`,
            Option.some(path),
          ),
        )
        continue
      }
      const matches = versionSatisfies(spec, resolved.value)
      if (matches === false) {
        findings.push(
          errorFinding(
            'lockfile',
            `the resolved version ${resolved.value} of ${name} does not satisfy the recorded range ${spec}; run "eedsh sync"`,
            Option.some(path),
          ),
        )
      } else if (matches === undefined) {
        findings.push(
          errorFinding(
            'lockfile',
            `the lockfile version ${resolved.value} of ${name} is not a semantic version; run "eedsh sync"`,
            Option.some(path),
          ),
        )
      }
    }
    return Option.some(entries)
  })
}

/** Verify each managed package is installed and its version agrees. */
function checkInstalled(
  fs: FileSystem.FileSystem,
  profileDir: string,
  record: GenerationRecord,
  lockfile: Option.Option<LockfileDependencies>,
  findings: DoctorFinding[],
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (const [name, spec] of Object.entries(record.packages)) {
      const path = join(profileDir, 'node_modules', name, 'package.json')
      const read = yield* readOptional(fs, path).pipe(Effect.result)
      if (Result.isFailure(read)) {
        findings.push(
          errorFinding(
            'installed',
            `cannot read the installed package ${name}: ${messageOf(read.failure)}`,
            Option.some(path),
          ),
        )
        continue
      }
      if (Option.isNone(read.success)) {
        findings.push(
          errorFinding(
            'installed',
            `managed package ${name} is not installed; run "eedsh sync"`,
            Option.some(path),
          ),
        )
        continue
      }
      const parsed = parseJson(read.success.value)
      const decoded = Result.isSuccess(parsed)
        ? Schema.decodeUnknownOption(installedManifestSchema)(parsed.success)
        : Option.none()
      if (Option.isNone(decoded)) {
        findings.push(
          errorFinding(
            'installed',
            `the installed package ${name} has no readable version; reinstall it`,
            Option.some(path),
          ),
        )
        continue
      }
      const installed = decoded.value.version
      const lockVersion = Option.flatMap(lockfile, (dependencies) =>
        Option.flatMap(Option.fromUndefinedOr(dependencies.get(name)), (entry) =>
          Option.flatMap(entry.version, resolvedVersion),
        ),
      )
      if (Option.isSome(lockVersion) && lockVersion.value !== installed) {
        findings.push(
          errorFinding(
            'installed',
            `installed ${name} version ${installed} differs from the lockfile version ${lockVersion.value}; run "eedsh sync"`,
            Option.some(path),
          ),
        )
      }
      if (!isSemverRange(spec)) continue
      const matches = versionSatisfies(spec, installed)
      if (matches === false) {
        findings.push(
          errorFinding(
            'installed',
            `installed ${name} version ${installed} does not satisfy the recorded range ${spec}; run "eedsh sync"`,
            Option.some(path),
          ),
        )
      } else if (matches === undefined) {
        findings.push(
          errorFinding(
            'installed',
            `installed ${name} version ${installed} is not a semantic version; reinstall it`,
            Option.some(path),
          ),
        )
      }
    }
  })
}

/** Report a generation change or a now-invalid record after the checks ran. */
function checkSnapshot(
  fs: FileSystem.FileSystem,
  recordPath: string,
  record: GenerationRecord,
  findings: DoctorFinding[],
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const lookup = yield* lookupGenerationRecord(recordPath, fs).pipe(Effect.result)
    const changed =
      Result.isFailure(lookup) ||
      lookup.success._tag !== 'valid' ||
      lookup.success.record.generationId !== record.generationId
    if (!changed) return
    findings.push(
      errorFinding(
        'snapshot',
        'the profile changed during diagnosis; rerun "eedsh doctor"',
        Option.some(recordPath),
      ),
    )
  })
}

/**
 * Inspect a published profile without changing it.
 * @param options - the resolved profile directory.
 * @returns the findings and their counts.
 */
export function doctor(
  options: DoctorOptions,
): Effect.Effect<DoctorResult, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const findings: DoctorFinding[] = []
    const dsh: DoctorDsh | undefined =
      options.dsh === undefined
        ? undefined
        : {
            version: options.dsh.version,
            installAnchor: options.dsh.installAnchor,
            supported: supportsDshVersion(options.dsh.version),
          }
    if (dsh !== undefined && !dsh.supported) {
      findings.push(
        errorFinding(
          'dsh',
          `the discovered DSH ${dsh.version} is outside the supported range ${SUPPORTED_DSH_RANGE}; install a supported dsh or select one with --dsh`,
          Option.some(dsh.installAnchor),
        ),
      )
    }

    if (!(yield* existsOrFalse(fs, options.profileDir))) {
      findings.push(
        errorFinding(
          'profile',
          'the profile directory does not exist; run "eedsh sync" to create it',
          Option.some(options.profileDir),
        ),
      )
      return summarize(findings, dsh)
    }

    const recordPath = join(options.profileDir, GENERATED_MANIFEST_RELATIVE_PATH)
    const record = yield* readRecord(fs, recordPath, findings)
    if (Option.isNone(record)) return summarize(findings, dsh)
    if (dsh !== undefined && record.value.dshVersion !== dsh.version) {
      findings.push(
        warningFinding(
          'dsh',
          `the generation record was published with DSH ${record.value.dshVersion} but the discovered installation is ${dsh.version}; run "eedsh sync" to republish with this installation`,
          Option.some(dsh.installAnchor),
        ),
      )
    }

    const plan = yield* readPlan(fs, options.profileDir, record.value, findings)
    if (Option.isSome(plan)) {
      checkConsistency(record.value, plan.value, recordPath, findings)
      yield* checkMirror(fs, options.profileDir, plan.value, findings)
      yield* checkSources(fs, options.profileDir, plan.value, options.dshHome, findings)
    }
    yield* checkManifest(fs, options.profileDir, record.value, findings)
    yield* checkScaffolding(fs, options.profileDir, findings)
    const lockfile = yield* checkLockfile(fs, options.profileDir, record.value, findings)
    yield* checkInstalled(fs, options.profileDir, record.value, lockfile, findings)
    yield* checkSnapshot(fs, recordPath, record.value, findings)
    return summarize(findings, dsh)
  })
}
