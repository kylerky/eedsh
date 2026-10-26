/**
 * The read-only `eedsh doctor` pipeline. It inspects a published profile and
 * reports findings; it never writes, takes no lock, and never repairs. Findings
 * name the command that can repair the profile: `eedsh sync` or
 * `eedsh sync --adopt-ownership`.
 * @module @eedsh/cli/doctor
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { canonicalJson, type ProfilePlan, ProfilePlanSchema } from '@eedsh/config'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import * as Predicate from 'effect/Predicate'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { EXIT_FAILURE, EXIT_OK } from './exit'
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

/** The severity of one doctor finding. */
export type DoctorSeverity = 'error' | 'warning'

/** One located problem in a published profile. */
export interface DoctorFinding {
  readonly severity: DoctorSeverity
  /** The check that produced the finding. */
  readonly check: string
  readonly message: string
  /** The affected path, when the finding names one. */
  readonly path?: string
}

/** The complete result of one doctor run. */
export interface DoctorResult {
  /** Errors first, then warnings, each sorted by check and message. */
  readonly findings: DoctorFinding[]
  readonly errors: number
  readonly warnings: number
}

/** Inputs for {@link doctor}. */
export interface DoctorOptions {
  /** Absolute path of the published profile to inspect. */
  profileDir: string
}

/** The scaffolding files a published profile should carry. */
const SCAFFOLDING: readonly { file: string; label: string }[] = [
  { file: PROFILE_ROOT_FILENAME, label: 'root configuration' },
  { file: PROFILE_PATCH_FILENAME, label: 'profile patch' },
  { file: PROFILE_WORKSPACE_FILENAME, label: 'pnpm workspace file' },
]

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

function compareFindings(a: DoctorFinding, b: DoctorFinding): number {
  if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
  return compareStrings(
    `${a.check}\u0000${a.message}\u0000${a.path ?? ''}`,
    `${b.check}\u0000${b.message}\u0000${b.path ?? ''}`,
  )
}

function errorFinding(check: string, message: string, path?: string): DoctorFinding {
  return path === undefined
    ? { severity: 'error', check, message }
    : { severity: 'error', check, message, path }
}

function warningFinding(check: string, message: string, path?: string): DoctorFinding {
  return path === undefined
    ? { severity: 'warning', check, message }
    : { severity: 'warning', check, message, path }
}

function summarize(findings: DoctorFinding[]): DoctorResult {
  const sorted = [...findings].sort(compareFindings)
  const errors = sorted.filter((item) => item.severity === 'error').length
  return { findings: sorted, errors, warnings: sorted.length - errors }
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
  if (result.findings.length === 0) return [`clean: ${summary}`]
  const lines = result.findings.map((finding) => {
    const location = finding.path === undefined ? '' : ` [${finding.path}]`
    return `${finding.severity}: ${finding.check}: ${finding.message}${location}`
  })
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

function readOptional(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<string | undefined, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return undefined
    return yield* fs.readFileString(path)
  })
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function parseJson(text: string): Result.Result<unknown, string> {
  return Result.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => messageOf(cause),
  })
}

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
): Effect.Effect<GenerationRecord | undefined> {
  return Effect.gen(function* () {
    const lookup = yield* lookupGenerationRecord(recordPath, fs).pipe(Effect.result)
    if (Result.isFailure(lookup)) {
      findings.push(
        errorFinding(
          'record',
          `cannot read the generation record: ${messageOf(lookup.failure)}`,
          recordPath,
        ),
      )
      return undefined
    }
    if (lookup.success._tag === 'valid') return lookup.success.record
    const invalid =
      lookup.success._tag === 'invalid' ? lookup.success : missingGenerationRecord(recordPath)
    findings.push(errorFinding('record', recordProblem(invalid), recordPath))
    return undefined
  })
}

/** Verify the authoritative plan: presence, hash, and plan decoding. */
function readPlan(
  fs: FileSystem.FileSystem,
  profileDir: string,
  record: GenerationRecord,
  findings: DoctorFinding[],
): Effect.Effect<ProfilePlan | undefined> {
  return Effect.gen(function* () {
    const path = join(profileDir, GENERATED_DIRNAME, authoritativePlanPath(record.generationId))
    const read = yield* readOptional(fs, path).pipe(Effect.result)
    if (Result.isFailure(read)) {
      findings.push(
        errorFinding(
          'plan',
          `cannot read the authoritative plan: ${messageOf(read.failure)}`,
          path,
        ),
      )
      return undefined
    }
    if (read.success === undefined) {
      findings.push(
        warningFinding(
          'plan',
          'the authoritative plan is missing; run "eedsh sync" to republish it',
          path,
        ),
      )
      return undefined
    }
    if (sha256(read.success) !== record.planHash) {
      findings.push(
        errorFinding(
          'plan',
          'the authoritative plan does not hash to the recorded plan hash; run "eedsh sync" to republish it',
          path,
        ),
      )
      return undefined
    }
    const parsed = parseJson(read.success)
    if (Result.isFailure(parsed)) {
      findings.push(
        errorFinding('plan', `the authoritative plan is not valid JSON: ${parsed.failure}`, path),
      )
      return undefined
    }
    const decoded = Schema.decodeUnknownResult(ProfilePlanSchema)(parsed.success)
    if (Result.isFailure(decoded)) {
      const detail = decoded.failure.message.split('\n')[0] ?? decoded.failure.message
      findings.push(
        errorFinding('plan', `the authoritative plan is not a valid profile plan: ${detail}`, path),
      )
      return undefined
    }
    return decoded.success
  })
}

/** Verify that the record's managed sets agree with the authoritative plan. */
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
        recordPath,
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
        recordPath,
      ),
    )
  }

  const expectedNames = new Set([
    ...Object.keys(plan.packages),
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
        recordPath,
      ),
    )
  }
}

/** Verify that the stable mirror carries the authoritative plan. */
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
        warningFinding('mirror', `cannot read the plan mirror: ${messageOf(read.failure)}`, path),
      )
      return
    }
    if (read.success === undefined) {
      findings.push(
        warningFinding(
          'mirror',
          'the plan mirror is missing; run "eedsh sync" to rewrite it',
          path,
        ),
      )
      return
    }
    const parsed = parseJson(read.success)
    if (Result.isFailure(parsed)) {
      findings.push(
        warningFinding(
          'mirror',
          'the plan mirror is not valid JSON; run "eedsh sync" to rewrite it',
          path,
        ),
      )
      return
    }
    if (canonicalJson(parsed.success) !== canonicalJson(plan)) {
      findings.push(
        warningFinding(
          'mirror',
          'the plan mirror does not match the authoritative plan; run "eedsh sync" to rewrite it',
          path,
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
          path,
        ),
      )
      return
    }
    if (read.success === undefined) {
      findings.push(
        errorFinding('manifest', 'the profile manifest is missing; run "eedsh sync"', path),
      )
      return
    }
    const parsed = parseJson(read.success)
    if (Result.isFailure(parsed) || !Predicate.isObject(parsed.success)) {
      findings.push(
        errorFinding(
          'manifest',
          'the profile manifest is not a JSON object; run "eedsh sync"',
          path,
        ),
      )
      return
    }
    const manifest = parsed.success as Record<string, unknown>

    const listed = readProfileBundles(manifest)
    const prefixIntact =
      listed.length >= record.bundles.length &&
      record.bundles.every((name, index) => listed[index] === name)
    if (!prefixIntact) {
      findings.push(
        errorFinding(
          'manifest',
          `managed bundles must start with ${record.bundles.join(', ')} in recorded order; run "eedsh sync"`,
          path,
        ),
      )
    }

    const dependencies = readProfileDependencies(manifest).dependencies
    for (const [name, spec] of Object.entries(record.packages)) {
      if (dependencies[name] === spec) continue
      const found = dependencies[name]
      findings.push(
        errorFinding(
          'manifest',
          `managed package ${name} must be declared as ${spec} in dependencies${found === undefined ? '' : ` (found ${found})`}; run "eedsh sync"`,
          path,
        ),
      )
    }

    const scan = scanDependencyConflicts(manifest, new Set(Object.keys(record.packages)))
    for (const section of scan.malformed) {
      findings.push(
        warningFinding(
          'dependencies',
          `${section} is not a record of package specifications; eedsh sync leaves it unchanged`,
          path,
        ),
      )
    }
    for (const conflict of scan.conflicts) {
      const message =
        conflict.field === 'devDependencies' || conflict.field === 'optionalDependencies'
          ? `managed package ${conflict.name} is also declared in ${conflict.field}; run "eedsh sync" to remove it`
          : `managed package ${conflict.name} is also declared in ${conflict.field}; the resolved version may differ`
      findings.push(warningFinding('dependencies', message, path))
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
          path,
        ),
      )
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
        recordPath,
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

    if (!(yield* existsOrFalse(fs, options.profileDir))) {
      findings.push(
        errorFinding(
          'profile',
          'the profile directory does not exist; run "eedsh sync" to create it',
          options.profileDir,
        ),
      )
      return summarize(findings)
    }

    const recordPath = join(options.profileDir, GENERATED_MANIFEST_RELATIVE_PATH)
    const record = yield* readRecord(fs, recordPath, findings)
    if (record === undefined) return summarize(findings)

    const plan = yield* readPlan(fs, options.profileDir, record, findings)
    if (plan !== undefined) {
      checkConsistency(record, plan, recordPath, findings)
      yield* checkMirror(fs, options.profileDir, plan, findings)
    }
    yield* checkManifest(fs, options.profileDir, record, findings)
    yield* checkScaffolding(fs, options.profileDir, findings)
    yield* checkSnapshot(fs, recordPath, record, findings)
    return summarize(findings)
  })
}
