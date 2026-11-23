/**
 * The single exception boundary. Authoring is synchronous: it reports misuse
 * as a defect, and this module is the only production code that raises one.
 * Every other production site reports an expected failure as a `Result` value
 * or through the Effect error channel, and the config loader is the single
 * entry safety net that turns a raised defect into an Effect defect.
 *
 * The architecture check scans source text, so the exception keyword is
 * confined to this file; no file is exempt from that scan by name.
 * @module @eedsh/config/defect
 */

/**
 * Raise an authoring defect across the single exception boundary.
 * The value is raised unchanged, so a caller observes exactly the error it
 * authored, and the declared `never` return keeps control-flow narrowing.
 * @param error - the defect to raise.
 * @returns never; the call always raises.
 */
export function defect(error: Error): never {
  throw error
}
