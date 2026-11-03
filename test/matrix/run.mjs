#!/usr/bin/env node
/** CLI entry for the external-DSH matrix; exits 1 when any check fails. */
import { PINNED_VERSIONS, runMatrix } from './harness.mjs'

const fromEnv = process.env.EEDSH_MATRIX_VERSIONS?.split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const fromArgs = process.argv.slice(2)
const versions = fromArgs.length > 0 ? fromArgs : (fromEnv ?? PINNED_VERSIONS)

const results = await runMatrix(versions)
for (const result of results) {
  const status = result.ok ? 'ok' : 'FAIL'
  console.log(`${status} dsh ${result.spec} (resolved ${result.version})`)
  for (const [check, value] of Object.entries(result.checks)) {
    console.log(`  ${check}: ${value === true ? 'ok' : value === false ? 'FAIL' : value}`)
  }
}
process.exit(results.every((result) => result.ok) ? 0 : 1)
