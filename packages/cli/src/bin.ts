#!/usr/bin/env node
import { Cause, Effect, Exit } from 'effect'
import { main } from './cli'
import { liveCliServicesLayer } from './internal/effect/layer'
import { messageOf } from './internal/error-message'

// The single runtime start in the CLI. The process result is derived from the
// one Exit: its value is the command's exit code, an interrupt exits 1 without
// a diagnostic, and a defect is reported once and exits 1.
Effect.runPromiseExit(
  Effect.suspend(() => main(process.argv.slice(2))).pipe(Effect.provide(liveCliServicesLayer)),
).then(
  (exit) => {
    if (Exit.isSuccess(exit)) {
      process.exitCode = exit.value
      return
    }
    process.exitCode = 1
    if (Cause.hasInterruptsOnly(exit.cause)) return
    console.error(`eedsh: ${messageOf(Cause.squash(exit.cause))}`)
  },
  (error: unknown) => {
    console.error(`eedsh: ${messageOf(error)}`)
    process.exitCode = 1
  },
)
