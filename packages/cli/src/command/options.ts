/**
 * The parsed value of one command's flag record. `Command.Config.Infer` is
 * Effect's unstable derivation, so it is named here once; adapters write
 * `Parsed<typeof options>` and never reference the Effect type directly.
 * @module @eedsh/cli/command/options
 */
import type { Command } from 'effect/cli'

/** The record a `Command.make` handler receives for one flag record. */
export type Parsed<Options extends Command.Command.Config> = Command.Command.Config.Infer<Options>
