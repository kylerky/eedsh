/**
 * The `eedsh` flag constructors. Several flags are shared by up to five
 * subcommands, so they live in one module; each command's record references them
 * and derives its input type from that record.
 * @module @eedsh/cli/surface
 */
import { Flag } from 'effect/cli'

export const configFlag = Flag.String('config').pipe(
  Flag.withDescription('config file to load (default: $XDG_CONFIG_HOME/eedsh/config.ts)'),
  Flag.optional,
)
export const dshFlag = Flag.String('dsh').pipe(
  Flag.withDescription(
    'DSH installation package directory or package.json (default: EEDSH_DSH_ANCHOR, PATH, then a project-local package)',
  ),
  Flag.optional,
)
export const strictFlag = Flag.Boolean('strict').pipe(
  Flag.withDescription('treat preflight warnings as failures'),
  Flag.withDefault(false),
)
export const watchFlag = Flag.Boolean('watch').pipe(
  Flag.withDescription('re-run sync when files in the config directory change'),
  Flag.withDefault(false),
)
export const explainFlag = Flag.Boolean('explain').pipe(
  Flag.withDescription('attribute preflight warnings to their source layer'),
  Flag.withDefault(false),
)
export const noSyncFlag = Flag.Boolean('no-sync').pipe(
  Flag.withDescription('skip publication and boot the last published generation'),
  Flag.withDefault(false),
)
export const noInstallFlag = Flag.Boolean('no-install').pipe(
  Flag.withDescription('write the config project without running pnpm install'),
  Flag.withDefault(false),
)
export const adoptOwnershipFlag = Flag.Boolean('adopt-ownership').pipe(
  Flag.withDescription(
    're-baseline ownership from the current manifest when the generation record is unreadable',
  ),
  Flag.withDefault(false),
)
export const rebuildFlag = Flag.Boolean('rebuild').pipe(
  Flag.withDescription('run every source preparation step even when the source is unchanged'),
  Flag.withDefault(false),
)
export const noBuildFlag = Flag.Boolean('no-build').pipe(
  Flag.withDescription('fail instead of preparing when a declared source needs preparation'),
  Flag.withDefault(false),
)
export const syncProfileFlag = Flag.String('profile').pipe(
  Flag.withDescription('profile to sync (default: every profile in the config)'),
  Flag.optional,
)
export const runProfileFlag = Flag.String('profile').pipe(
  Flag.withDescription('profile to boot (default: the declared default, then the sole profile)'),
  Flag.optional,
)
export const profileFlag = Flag.String('profile').pipe(
  Flag.withDescription(
    'profile name to inspect under DSH_HOME (default: the config default or sole profile)',
  ),
  Flag.optional,
)
export const doctorStrictFlag = Flag.Boolean('strict').pipe(
  Flag.withDescription('exit 1 when there is at least one warning'),
  Flag.withDefault(false),
)
export const replSyncFlag = Flag.Boolean('sync').pipe(
  Flag.withDescription('sync the selected profile after each successful save'),
  Flag.withDefault(false),
)
export const evalFlag = Flag.String('eval').pipe(
  Flag.withDescription('evaluate one expression, print its value, and exit'),
  Flag.optional,
)
