#!/usr/bin/env node
import { Cause, Effect, Exit, Fiber } from 'effect'
import * as Result from 'effect/Result'
import { main } from './cli'
import { EXIT_OK } from './exit'
import { liveCliServicesLayer } from './internal/effect/layer'
import { messageOf } from './internal/error-message'
import { WatchCloseError } from './watch'

// The single runtime start in the CLI. SIGINT and SIGTERM interrupt that one
// invocation fiber, and their handlers are removed once it settles. The process
// result is derived from the one Exit: its value is the command's exit code;
// SIGINT/SIGTERM are the only interruption source and the specified watch-stop
// outcome is success (EXIT_OK); a defect is reported once and exits 1. The one
// exception is a watcher-close failure during that stop: the watch lifecycle
// specifies a warning that does not change the successful stop.
const fiber = Effect.runFork(
  Effect.suspend(() => main(process.argv.slice(2))).pipe(Effect.provide(liveCliServicesLayer)),
)
const onSignal = (): void => {
  fiber.interruptUnsafe()
}
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)

const exit = await Effect.runPromise(Fiber.await(fiber))
process.removeListener('SIGINT', onSignal)
process.removeListener('SIGTERM', onSignal)

if (Exit.isSuccess(exit)) {
  process.exitCode = exit.value
} else {
  const closeFailure = Cause.findDefect(exit.cause)
  if (
    Cause.hasInterrupts(exit.cause) &&
    Result.isSuccess(closeFailure) &&
    closeFailure.success instanceof WatchCloseError
  ) {
    console.error(`eedsh: warning: ${messageOf(closeFailure.success.cause)}`)
    process.exitCode = EXIT_OK
  } else if (Cause.hasInterruptsOnly(exit.cause)) {
    process.exitCode = EXIT_OK
  } else {
    console.error(`eedsh: ${messageOf(Cause.squash(exit.cause))}`)
    process.exitCode = 1
  }
}
