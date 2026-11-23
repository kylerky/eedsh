/**
 * Reporting for the CLI: describe a failure from the one failure vocabulary,
 * print preflight warnings, and print a materialization result. One module
 * decides how an `eedsh:` line is rendered, so every command reports the same
 * way, and the match below is exhaustive: a failure without a diagnostic fails
 * the type check.
 * @module @eedsh/cli/command/report
 */
import type { ProfilePlan } from '@eedsh/plan'
import { Effect, Match } from 'effect'
import type * as Console from 'effect/Console'
import * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import { EXIT_FAILURE } from '../exit'
import { presetDefinitionErrorLines } from '../internal/authoring-error'
import { Output, type OutputShape } from '../internal/effect/services'
import { describeInvalidRecord } from '../materialize/generation-record'
import type { MaterializeResult } from '../materialize/program'
import { describeProfileSelection } from '../selection'
import type { EedshError } from './errors'

export const EXPLAIN_HINT = 'eedsh: add --explain to attribute each warning to its source layer'

export const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}[[][0-9;]*m`, 'g')

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, '')
}

export function cliConsole(
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Console.Console {
  const render = (args: ReadonlyArray<unknown>): string =>
    stripAnsi(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '))
  const write =
    (sink: (line: string) => void) =>
    (...args: ReadonlyArray<unknown>): void => {
      sink(render(args))
    }
  return {
    assert: (condition, ...args) => {
      if (!condition) stderr(`Assertion failed: ${render(args)}`)
    },
    clear: () => {},
    count: () => {},
    countReset: () => {},
    debug: write(stderr),
    dir: (item) => {
      stderr(render([item]))
    },
    dirxml: write(stderr),
    error: write(stderr),
    group: () => {},
    groupCollapsed: () => {},
    groupEnd: () => {},
    info: write(stderr),
    log: write(stdout),
    table: (tabularData) => {
      stdout(render([tabularData]))
    },
    time: () => {},
    timeEnd: () => {},
    timeLog: write(stderr),
    trace: write(stderr),
    warn: write(stderr),
  }
}

/**
 * Render one failure as diagnostic lines, without the `eedsh: ` prefix. The
 * match is exhaustive over the CLI's failure union, so every failure has a
 * diagnostic and adding a tagged failure without an arm fails the type check.
 * @param error - the failure to render.
 * @returns the printed lines.
 */
export function describeError(error: EedshError): string[] {
  return Match.value(error).pipe(
    Match.when(Schema.isSchemaError, (schemaError) => schemaError.message.split('\n')),
    Match.when(PlatformError.isPlatformError, (platformError) => [platformError.message]),
    Match.tagsExhaustive({
      InvalidConfigValue: (failure) => [`${failure.code}: ${failure.message}`],
      ConfigError: (failure) => [`${failure.code}: ${failure.message}`],
      CheckFailure: (failure) => [`${failure.code}: ${failure.message}`],
      PackageInstallFailure: (failure) => [
        `package installation failed in ${failure.profileDir}: ${String(failure.cause)}`,
      ],
      PreflightFailure: (failure) => [failure.message, ...failure.warnings],
      SpawnFailure: (failure) => [`cannot launch dsh: ${String(failure.cause)}`],
      SyncLocked: (failure) => [
        `another sync is running for this profile; lock: ${failure.lockPath}`,
      ],
      OwnershipRecordInvalid: (failure) => [
        describeInvalidRecord({
          path: failure.path,
          detail: failure.detail,
          adoptable: failure.adoptable,
        }),
      ],
      DshResolveFailure: (failure) => [
        `cannot resolve DSH package ${failure.packageName}: ${String(failure.cause)}`,
      ],
      DshFailure: (failure) => [`${failure.code}: ${failure.message}`],
      InitError: (failure) => [`${failure.code}: ${failure.message}`],
      ReplSessionError: (failure) => [...failure.lines],
      ResolutionError: (failure) => [`${failure.code}: ${failure.message}`],
      PresetDefinitionError: (failure) => presetDefinitionErrorLines(failure),
      SourceDeclarationError: (failure) => [`${failure.code}: ${failure.message}`],
      ProvisionFailure: (failure) => [`${failure.code}: ${failure.message}`],
      PreviewError: (failure) => [`${failure.code}: ${failure.message}`],
      UnknownProfile: (failure) => [describeProfileSelection(failure)],
      AmbiguousProfile: (failure) => [describeProfileSelection(failure)],
      UnexpectedFailure: (failure) => [failure.message],
    }),
  )
}

export function report(stderr: (line: string) => void, error: EedshError): void {
  for (const line of describeError(error)) stderr(`eedsh: ${line}`)
}

/**
 * Report one typed command failure and return the failure exit code. A sync
 * failure keeps its explain hint; every other failure prints the diagnostic
 * once.
 * @param error - the failure the command produced.
 * @param options - whether this is a sync failure and whether explain is on.
 * @returns the failure exit code.
 */
export function failWith(
  error: EedshError,
  options: { sync?: boolean; explain?: boolean } = {},
): Effect.Effect<number, never, OutputShape> {
  return Effect.map(Output, (output) => {
    if (options.sync === true) reportSyncError(output.stderr, error, options.explain === true)
    else report(output.stderr, error)
    return EXIT_FAILURE
  })
}

/**
 * The warnings a preflight failure carries, for the explain hint and for a
 * profile-labelled report.
 * @param error - the reported failure.
 * @returns its warnings, or an empty list for any other failure.
 */
export function rawPreflightWarnings(error: EedshError): string[] {
  return error._tag === 'PreflightFailure' ? [...error.warnings] : []
}

export function reportSyncError(
  stderr: (line: string) => void,
  error: EedshError,
  explain: boolean,
): void {
  report(stderr, error)
  if (!explain && rawPreflightWarnings(error).length > 0) stderr(EXPLAIN_HINT)
}

export function printResult(
  stdout: (line: string) => void,
  stderr: (line: string) => void,
  plan: ProfilePlan,
  result: MaterializeResult,
  explain: boolean,
): void {
  for (const warning of result.warnings) stderr(`eedsh: warning: ${warning}`)
  for (const note of result.notices) stderr(`eedsh: ${note.severity}: ${note.message}`)
  if (!explain && result.warnings.length > 0) stderr(EXPLAIN_HINT)
  stdout(
    `eedsh: ${result.changed ? 'published' : 'unchanged'} profile ${plan.profile.name} (generation ${result.generationId.slice(0, 12)})`,
  )
}
