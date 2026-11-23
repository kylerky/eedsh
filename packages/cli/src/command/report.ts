/**
 * Reporting for the CLI: describe a tagged failure, print preflight warnings,
 * and print a materialization result. One module decides how an `eedsh:` line is
 * rendered, so every command reports the same way.
 * @module @eedsh/cli/command/report
 */
import type { ProfilePlan } from '@eedsh/plan'
import { Effect } from 'effect'
import type * as Console from 'effect/Console'
import * as Schema from 'effect/Schema'
import { EXIT_FAILURE } from '../exit'
import { presetDefinitionErrorLines } from '../internal/authoring-error'
import { Output, type OutputShape } from '../internal/effect/services'
import { messageOf } from '../internal/error-message'
import { asRecord } from '../internal/record'
import { describeInvalidRecord } from '../materialize/generation-record'
import type { MaterializeResult } from '../materialize/program'
import { AmbiguousProfile, describeProfileSelection, UnknownProfile } from '../selection'

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

export function describeError(error: unknown): string[] {
  if (Schema.isSchemaError(error)) return error.message.split('\n')
  if (error instanceof UnknownProfile || error instanceof AmbiguousProfile) {
    return [describeProfileSelection(error)]
  }
  const tagged = asRecord(error)
  if (tagged !== undefined && '_tag' in tagged) {
    switch (tagged._tag) {
      case 'ConfigError':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'CheckFailure':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'SpawnFailure':
        return [`cannot launch dsh: ${String(tagged.cause)}`]
      case 'PackageInstallFailure':
        return [
          `package installation failed in ${String(tagged.profileDir)}: ${String(tagged.cause)}`,
        ]
      case 'PreflightFailure': {
        const warnings = Array.isArray(tagged.warnings) ? tagged.warnings.map(String) : []
        return [String(tagged.message), ...warnings]
      }
      case 'SyncLocked':
        return [`another sync is running for this profile; lock: ${String(tagged.lockPath)}`]
      case 'OwnershipRecordInvalid':
        return [
          describeInvalidRecord({
            path: String(tagged.path),
            detail: String(tagged.detail),
            adoptable: tagged.adoptable === true,
          }),
        ]
      case 'DshResolveFailure':
        return [`cannot resolve DSH package ${String(tagged.packageName)}: ${String(tagged.cause)}`]
      case 'DshFailure':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'InitError':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'ReplSessionError':
        return Array.isArray(tagged.lines) ? tagged.lines.map(String) : [String(tagged.message)]
      case 'ResolutionError':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'PresetDefinitionError':
        return presetDefinitionErrorLines(tagged)
      case 'SourceDeclarationError':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'ProvisionFailure':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      case 'PreviewError':
        return [`${String(tagged.code)}: ${String(tagged.message)}`]
      default:
        break
    }
  }
  return [messageOf(error)]
}

export function report(stderr: (line: string) => void, error: unknown): void {
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
  error: unknown,
  options: { sync?: boolean; explain?: boolean } = {},
): Effect.Effect<number, never, OutputShape> {
  return Effect.map(Output, (output) => {
    if (options.sync === true) reportSyncError(output.stderr, error, options.explain === true)
    else report(output.stderr, error)
    return EXIT_FAILURE
  })
}

export function rawPreflightWarnings(error: unknown): string[] {
  const tagged = asRecord(error)
  if (tagged === undefined || tagged._tag !== 'PreflightFailure') return []
  return Array.isArray(tagged.warnings) ? tagged.warnings.map(String) : []
}

export function reportSyncError(
  stderr: (line: string) => void,
  error: unknown,
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
