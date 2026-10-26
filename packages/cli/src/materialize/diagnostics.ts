/**
 * Structured materialization diagnostics. Reconciliation warnings report
 * something eedsh could not reconcile; notices report a change eedsh made that
 * the user should know about. Preflight warnings stay a separate array so the
 * `--explain` hint keeps applying only to layer-attributed messages.
 * @module @eedsh/cli/materialize/diagnostics
 */

/** The severity of one materialization diagnostic. */
export type DiagnosticSeverity = 'warning' | 'notice'

/** One structured materialization diagnostic. */
export interface Diagnostic {
  readonly severity: DiagnosticSeverity
  readonly message: string
}

/**
 * Build a notice: a reconciliation change worth reporting.
 * @param message - the diagnostic text.
 * @returns the notice value.
 */
export function notice(message: string): Diagnostic {
  return { severity: 'notice', message }
}

/**
 * Build a warning: something reconciliation could not resolve.
 * @param message - the diagnostic text.
 * @returns the warning value.
 */
export function warning(message: string): Diagnostic {
  return { severity: 'warning', message }
}
