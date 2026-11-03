/**
 * Git source provisioning and preparation. A git source is resolved against
 * the remote, cloned or updated below the DSH home, reset to the resolved
 * commit, and prepared with the declaration's fixed-argument steps only when
 * the checkout is new or the recorded state changed. A local checkout is read
 * in place and prepared only when its declaration asks for steps.
 * @module @eedsh/cli/provision/git
 */
import { dirname } from 'node:path'
import { canonicalJson, type PlanSource } from '@eedsh/plan'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import type { ChildProcessSpawner } from 'effect/process'
import * as Result from 'effect/Result'
import { ProvisionFailure, type SyncLocked } from '../internal/effect/errors'
import type { SyncLockShape } from '../internal/effect/services'
import { withSyncLock } from '../internal/lock'
import { type CommandResult, childProcessCommand, type ProvisionCommand } from './command'
import {
  readSourceRecord,
  SOURCE_RECORD_FORMAT,
  type SourceRecord,
  writeSourceRecord,
} from './record'
import {
  type ResolvedSourceLocation,
  resolveSourceLocation,
  type SourceAcquisitionKind,
  sourceCheckoutDir,
  sourceKey,
  sourceLockPath,
  sourceStatePath,
} from './source'
import { verifyProvisionedPackage } from './verify'

/** A command failure naming the argv, the directory, and the status. */
function commandFailure(input: {
  readonly name: string
  readonly argv: readonly string[]
  readonly result: CommandResult
  readonly cwd: string
  readonly code?: 'provision.command_failed' | 'provision.fetch_failed'
}): ProvisionFailure {
  const detail = input.result.stderr.trim() || input.result.stdout.trim()
  return new ProvisionFailure({
    code: input.code ?? 'provision.command_failed',
    packageName: input.name,
    message:
      `${input.argv.join(' ')} exited with status ${input.result.status} in ${input.cwd} ` +
      `for source ${JSON.stringify(input.name)}` +
      (detail === '' ? '' : `: ${detail}`),
    command: [...input.argv],
    status: input.result.status,
    path: input.cwd,
  })
}

/** Run one git command and return its stdout, or fail with its status. */
function runGit(input: {
  readonly command: ProvisionCommand
  readonly name: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly code?: 'provision.command_failed' | 'provision.fetch_failed'
}): Effect.Effect<string, ProvisionFailure, ChildProcessSpawner.ChildProcessSpawner> {
  const argv = ['git', ...input.args]
  return input.command('git', input.args, { cwd: input.cwd }).pipe(
    Effect.flatMap((result) =>
      result.status === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(
            commandFailure({
              name: input.name,
              argv,
              result,
              cwd: input.cwd,
              ...(input.code === undefined ? {} : { code: input.code }),
            }),
          ),
    ),
  )
}

const COMMIT_SHA = /^[0-9a-f]{7,64}$/i

/**
 * Resolve the declared ref against the remote. With no ref, the remote's
 * default branch is resolved from HEAD; a ref that is already a commit object
 * id resolves to itself when the remote does not advertise it.
 */
function resolveRemoteCommit(input: {
  readonly command: ProvisionCommand
  readonly name: string
  readonly remote: string
  readonly ref: string | undefined
  readonly configDir: string
}): Effect.Effect<string, ProvisionFailure, ChildProcessSpawner.ChildProcessSpawner> {
  const spec = input.ref ?? 'HEAD'
  const args = ['ls-remote', input.remote, spec]
  return runGit({
    command: input.command,
    name: input.name,
    args,
    cwd: input.configDir,
    code: 'provision.fetch_failed',
  }).pipe(
    Effect.flatMap((stdout) => {
      const line = stdout
        .split('\n')
        .map((entry) => entry.trim())
        .find((entry) => entry !== '')
      const token = line?.split(/\s+/)[0]
      if (token !== undefined && COMMIT_SHA.test(token)) return Effect.succeed(token)
      if (input.ref !== undefined && COMMIT_SHA.test(input.ref)) return Effect.succeed(input.ref)
      const named =
        input.ref === undefined ? 'the default branch' : `ref ${JSON.stringify(input.ref)}`
      return Effect.fail(
        new ProvisionFailure({
          code: 'provision.fetch_failed',
          packageName: input.name,
          message: `cannot resolve ${named} for source ${JSON.stringify(input.name)} at ${input.remote}`,
          command: ['git', ...args],
          path: input.remote,
        }),
      )
    }),
  )
}

/** The steps and working directory for one preparation run. */
export interface PreparationInput {
  readonly name: string
  readonly checkoutDir: string
  readonly steps: readonly (readonly string[])[]
  readonly command: ProvisionCommand
}

/**
 * Run preparation steps in order with the checkout as the working directory.
 * The first non-zero step stops the run and fails naming the step, its status,
 * and its captured output.
 * @param input - the steps, the checkout, and the command seam.
 * @returns an effect that succeeds when every step did.
 */
export function runPreparation(
  input: PreparationInput,
): Effect.Effect<void, ProvisionFailure, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.forEach(
    input.steps,
    (step) =>
      Effect.gen(function* () {
        const [executable, ...args] = step
        if (executable === undefined) {
          return yield* Effect.fail(
            new ProvisionFailure({
              code: 'provision.command_failed',
              packageName: input.name,
              message: `a preparation step for source ${JSON.stringify(input.name)} names no executable`,
              path: input.checkoutDir,
            }),
          )
        }
        const result = yield* input.command(executable, args, { cwd: input.checkoutDir })
        if (result.status === 0) return
        const detail = result.stderr.trim() || result.stdout.trim()
        return yield* Effect.fail(
          new ProvisionFailure({
            code: 'provision.command_failed',
            packageName: input.name,
            message:
              `preparation step ${step.join(' ')} for source ${JSON.stringify(input.name)} ` +
              `exited with status ${result.status} in ${input.checkoutDir}` +
              (detail === '' ? '' : `: ${detail}`),
            command: [...step],
            status: result.status,
            path: input.checkoutDir,
          }),
        )
      }),
    { discard: true },
  )
}

/** Inputs for {@link provisionSource}. */
export interface ProvisionSourceInput {
  /** The absolute DSH home; provisioned checkouts and records live below it. */
  readonly home: string
  /** The absolute directory holding the config file. */
  readonly configDir: string
  /** The declared package name. */
  readonly name: string
  /** The plan source declaration. */
  readonly declaration: PlanSource
  /** Override the command seam; defaults to the core child-process runner. */
  readonly command?: ProvisionCommand
  /** Force preparation even when the recorded state is unchanged. */
  readonly rebuild?: boolean
  /** Fail instead of preparing when preparation would be needed. */
  readonly noBuild?: boolean
  /** Override the recorded preparation time, for tests. */
  readonly now?: () => Date
  /** Receives non-fatal provisioning warnings. */
  readonly warn?: (message: string) => void
}

/** What provisioning one source did. */
export interface ProvisionedSource {
  readonly name: string
  /** The stable source key. */
  readonly key: string
  readonly kind: SourceAcquisitionKind
  /** The acquisition location: absolute for a local checkout. */
  readonly location: string
  /** The directory the profile links. */
  readonly checkoutDir: string
  /** The resolved preparation steps. */
  readonly prepare: readonly (readonly string[])[]
  /** The resolved commit for a git source. */
  readonly commit?: string
  /** Whether preparation ran. */
  readonly prepared: boolean
  /** Whether the checkout or its preparation changed. */
  readonly changed: boolean
  readonly warnings: readonly string[]
}

/** The refusal for a source that needs preparation under `--no-build`. */
function noBuildFailure(input: {
  readonly name: string
  readonly path: string
  readonly steps: readonly (readonly string[])[]
}): ProvisionFailure {
  return new ProvisionFailure({
    code: 'provision.no_build',
    packageName: input.name,
    path: input.path,
    message:
      `source ${JSON.stringify(input.name)} needs preparation, but --no-build refuses to run ` +
      input.steps.map((step) => step.join(' ')).join(', '),
  })
}

/** Provision one local checkout in place. */
function provisionLocal(input: {
  readonly fs: FileSystem.FileSystem
  readonly name: string
  readonly key: string
  readonly location: string
  readonly prepare: readonly (readonly string[])[]
  readonly command: ProvisionCommand
  readonly statePath: string
  readonly now: () => Date
  readonly warnings: readonly string[]
  readonly noBuild: boolean
}): Effect.Effect<
  ProvisionedSource,
  ProvisionFailure | PlatformError.PlatformError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    if (!(yield* input.fs.exists(input.location))) {
      return yield* Effect.fail(
        new ProvisionFailure({
          code: 'provision.source_missing',
          packageName: input.name,
          path: input.location,
          message: `source ${JSON.stringify(input.name)} names the local checkout ${input.location}, which does not exist`,
        }),
      )
    }
    const prepared = input.prepare.length > 0
    if (prepared && input.noBuild) {
      return yield* Effect.fail(
        noBuildFailure({ name: input.name, path: input.location, steps: input.prepare }),
      )
    }
    if (prepared) {
      yield* runPreparation({
        name: input.name,
        checkoutDir: input.location,
        steps: input.prepare,
        command: input.command,
      })
      const record: SourceRecord = {
        format: SOURCE_RECORD_FORMAT,
        name: input.name,
        from: input.location,
        prepare: input.prepare.map((step) => [...step]),
        preparedAt: input.now().toISOString(),
      }
      yield* writeSourceRecord(input.fs, input.statePath, record)
    }
    yield* verifyProvisionedPackage({ name: input.name, packageDir: input.location })
    return {
      name: input.name,
      key: input.key,
      kind: 'local',
      location: input.location,
      checkoutDir: input.location,
      prepare: input.prepare,
      prepared,
      changed: prepared,
      warnings: input.warnings,
    }
  })
}

/**
 * Provision one declared source.
 * @param input - the declaration, the DSH home, the config directory, and the seams.
 * @returns what was provisioned and whether anything changed.
 */
export function provisionSource(
  input: ProvisionSourceInput,
): Effect.Effect<
  ProvisionedSource,
  ProvisionFailure | PlatformError.PlatformError | SyncLocked,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | SyncLockShape
> {
  const key = sourceKey(input.declaration)
  return withSyncLock(sourceLockPath(input.home, key), provisionSourceUnlocked(input, key))
}

/** Provision one source; the caller holds the per-source lock. */
function provisionSourceUnlocked(
  input: ProvisionSourceInput,
  key: string,
): Effect.Effect<
  ProvisionedSource,
  ProvisionFailure | PlatformError.PlatformError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const command = input.command ?? childProcessCommand
    const resolved: ResolvedSourceLocation = resolveSourceLocation(
      input.declaration.from,
      input.configDir,
    )
    const statePath = sourceStatePath(input.home, key)
    const prepare = input.declaration.prepare
    const warnings: string[] = []
    const warn = (message: string) => {
      warnings.push(message)
      input.warn?.(message)
    }
    const now = input.now ?? (() => new Date())

    if (resolved.kind === 'local') {
      return yield* provisionLocal({
        fs,
        name: input.name,
        key,
        location: resolved.location,
        prepare,
        command,
        statePath,
        now,
        warnings,
        noBuild: input.noBuild === true,
      })
    }

    const record = yield* readSourceRecord(fs, statePath)
    if (record === undefined && (yield* fs.exists(statePath))) {
      warn(`the provisioning record ${statePath} is unreadable; provisioning the source again`)
    }
    const checkoutDir = sourceCheckoutDir(input.home, key)
    const checkoutExists = yield* fs.exists(checkoutDir)
    const remoteCommit = yield* Effect.result(
      resolveRemoteCommit({
        command,
        name: input.name,
        remote: resolved.location,
        ref: input.declaration.ref,
        configDir: input.configDir,
      }),
    )
    let commit: string
    if (Result.isFailure(remoteCommit)) {
      if (record?.commit !== undefined && checkoutExists) {
        // Offline: the recorded commit is the last state that verifies.
        commit = record.commit
        warn(
          `cannot reach the git source at ${resolved.location} for ${JSON.stringify(input.name)}; ` +
            `keeping the recorded commit ${commit}: ${remoteCommit.failure.message}`,
        )
      } else {
        return yield* Effect.fail(remoteCommit.failure)
      }
    } else {
      commit = remoteCommit.success
    }
    const fresh = !checkoutExists
    const stepsChanged =
      record === undefined || canonicalJson(record.prepare) !== canonicalJson(prepare)
    const commitChanged = record?.commit !== commit
    const prepareNeeded =
      prepare.length > 0 && (input.rebuild === true || fresh || commitChanged || stepsChanged)
    if (prepareNeeded && input.noBuild === true) {
      return yield* Effect.fail(
        noBuildFailure({ name: input.name, path: checkoutDir, steps: prepare }),
      )
    }

    if (fresh) {
      yield* fs.makeDirectory(input.home, { recursive: true })
      yield* fs.makeDirectory(dirname(checkoutDir), { recursive: true })
      yield* runGit({
        command,
        name: input.name,
        args: ['clone', resolved.location, checkoutDir],
        cwd: input.home,
      })
      // The real clone created the directory; mirror that for injected checkers.
      yield* fs.makeDirectory(checkoutDir, { recursive: true })
    }
    if (fresh || commitChanged) {
      if (!fresh) {
        yield* runGit({
          command,
          name: input.name,
          args: ['fetch', '--force', '--tags', 'origin'],
          cwd: checkoutDir,
        })
      }
      yield* runGit({
        command,
        name: input.name,
        args: ['reset', '--hard', commit],
        cwd: checkoutDir,
      })
    }

    let prepared = false
    if (prepareNeeded) {
      yield* runPreparation({
        name: input.name,
        checkoutDir,
        steps: prepare,
        command,
      })
      prepared = true
    }
    yield* verifyProvisionedPackage({ name: input.name, packageDir: checkoutDir })

    const changed = fresh || commitChanged || prepared
    if (changed || record === undefined) {
      const next: SourceRecord = {
        format: SOURCE_RECORD_FORMAT,
        name: input.name,
        from: input.declaration.from,
        ...(input.declaration.ref === undefined ? {} : { ref: input.declaration.ref }),
        commit,
        prepare: prepare.map((step) => [...step]),
        ...(prepared || record?.preparedAt === undefined
          ? { preparedAt: now().toISOString() }
          : { preparedAt: record.preparedAt }),
      }
      yield* writeSourceRecord(fs, statePath, next)
    }

    return {
      name: input.name,
      key,
      kind: 'git',
      location: resolved.location,
      checkoutDir,
      prepare,
      commit,
      prepared,
      changed,
      warnings,
    }
  })
}
