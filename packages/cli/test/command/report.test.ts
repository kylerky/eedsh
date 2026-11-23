import { PresetDefinitionError, ResolutionError, SourceDeclarationError } from '@eedsh/config'
import * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { describeError, report } from '../../src/command/report'
import { ConfigError } from '../../src/config'
import { InitError } from '../../src/init'
import {
  CheckFailure,
  DshFailure,
  DshResolveFailure,
  OwnershipRecordInvalid,
  PackageInstallFailure,
  PreflightFailure,
  ProvisionFailure,
  SpawnFailure,
  SyncLocked,
} from '../../src/internal/effect/errors'
import { PreviewError } from '../../src/repl/preview'
import { ReplSessionError } from '../../src/repl/session'
import { AmbiguousProfile, UnknownProfile } from '../../src/selection'

/** The failure type the reporter accepts. */
type Failure = Parameters<typeof describeError>[0]

function schemaError(): Schema.SchemaError {
  try {
    Schema.decodeUnknownSync(Schema.Struct({ n: Schema.Number }))({ n: 'x' })
  } catch (error) {
    if (Schema.isSchemaError(error)) return error
    throw error
  }
  throw new Error('unreachable: the decode must fail')
}

interface Case {
  readonly name: string
  readonly error: Failure
  readonly lines: readonly string[]
}

/**
 * One representative failure per tag and a pinned diagnostic. These are the
 * regression baseline for the reporter: replacing the tag switch with an
 * exhaustive match must not change a single line.
 */
const CASES: readonly Case[] = [
  {
    name: 'ConfigError',
    error: new ConfigError('config.import_failed', 'cannot import /work/config.ts'),
    lines: ['config.import_failed: cannot import /work/config.ts'],
  },
  {
    name: 'CheckFailure',
    error: new CheckFailure({ code: 'check.tsc_failed', message: 'tsc failed' }),
    lines: ['check.tsc_failed: tsc failed'],
  },
  {
    name: 'SpawnFailure',
    error: new SpawnFailure({ cause: new Error('ENOENT dsh') }),
    lines: ['cannot launch dsh: Error: ENOENT dsh'],
  },
  {
    name: 'PackageInstallFailure',
    error: new PackageInstallFailure({
      profileDir: '/home/profiles/work',
      cause: new Error('pnpm failed'),
    }),
    lines: ['package installation failed in /home/profiles/work: Error: pnpm failed'],
  },
  {
    name: 'PreflightFailure',
    error: new PreflightFailure({
      message: 'unmatched target',
      warnings: ['bundle:x: missing row'],
    }),
    lines: ['unmatched target', 'bundle:x: missing row'],
  },
  {
    name: 'SyncLocked',
    error: new SyncLocked({ lockPath: '/home/profiles/work/.eedsh/sync.lock' }),
    lines: ['another sync is running for this profile; lock: /home/profiles/work/.eedsh/sync.lock'],
  },
  {
    name: 'OwnershipRecordInvalid',
    error: new OwnershipRecordInvalid({
      path: '/home/profiles/work/.eedsh/generated/package.json',
      reason: 'unparseable',
      detail: 'invalid JSON',
      adoptable: true,
    }),
    lines: [
      'cannot use the generation record at /home/profiles/work/.eedsh/generated/package.json: invalid JSON; run "eedsh sync --adopt-ownership" to re-baseline ownership from the current manifest',
    ],
  },
  {
    name: 'DshResolveFailure',
    error: new DshResolveFailure({
      packageName: '@deepseek-ai/dsh-base',
      cause: new Error('not installed'),
    }),
    lines: ['cannot resolve DSH package @deepseek-ai/dsh-base: Error: not installed'],
  },
  {
    name: 'DshFailure',
    error: new DshFailure({ code: 'dsh.not_found', message: 'cannot find a DSH installation' }),
    lines: ['dsh.not_found: cannot find a DSH installation'],
  },
  {
    name: 'InitError',
    error: new InitError({ code: 'init.manifest_unreadable', message: 'cannot read package.json' }),
    lines: ['init.manifest_unreadable: cannot read package.json'],
  },
  {
    name: 'ReplSessionError',
    error: new ReplSessionError({
      code: 'repl.bridge_missing',
      message: 'missing bridge',
      lines: ['missing bridge', 'select one with --dsh'],
    }),
    lines: ['missing bridge', 'select one with --dsh'],
  },
  {
    name: 'PreviewError',
    error: new PreviewError({
      code: 'preview.install_failed',
      message: 'install failed',
      path: '/cache/preview',
    }),
    lines: ['preview.install_failed: install failed'],
  },
  {
    name: 'ResolutionError',
    error: new ResolutionError({
      code: 'resolution.bundle_not_found',
      bundle: '@scope/x',
      message: 'bundle not found',
      path: '/pkg',
    }),
    lines: ['resolution.bundle_not_found: bundle not found'],
  },
  {
    name: 'PresetDefinitionError',
    error: new PresetDefinitionError({
      code: 'preset.invalid_selection',
      presetId: 'web',
      rowId: 'web-row',
      childId: 'child',
      message: 'invalid selection',
    }),
    lines: [
      'preset.invalid_selection: invalid selection',
      'preset "web" row "web-row" child "child"',
    ],
  },
  {
    name: 'SourceDeclarationError',
    error: new SourceDeclarationError({
      code: 'source.duplicate_package',
      packageName: '@scope/dup',
      message: 'duplicate package',
    }),
    lines: ['source.duplicate_package: duplicate package'],
  },
  {
    name: 'ProvisionFailure',
    error: new ProvisionFailure({
      code: 'provision.command_failed',
      packageName: '@scope/src',
      message: 'git clone failed',
      command: ['git', 'clone'],
      status: 128,
    }),
    lines: ['provision.command_failed: git clone failed'],
  },
  {
    name: 'UnknownProfile',
    error: new UnknownProfile({ requested: 'web', names: ['a', 'b'] }),
    lines: ['profile "web" is not declared; available profiles: a, b'],
  },
  {
    name: 'AmbiguousProfile',
    error: new AmbiguousProfile({ names: ['a', 'b'] }),
    lines: ['several profiles are declared (a, b); pass --profile <name>'],
  },
  {
    name: 'native schema error',
    error: schemaError(),
    lines: ['Expected number', '  at ["n"]'],
  },
  {
    name: 'platform error',
    error: PlatformError.systemError({
      _tag: 'NotFound',
      module: 'FileSystem',
      method: 'readFileString',
      pathOrDescriptor: '/work/config.ts',
    }),
    lines: ['NotFound: FileSystem.readFileString (/work/config.ts)'],
  },
]

describe('CLI diagnostics', () => {
  for (const { name, error, lines } of CASES) {
    it(`renders ${name}`, () => {
      expect(describeError(error)).toEqual([...lines])
    })
  }

  it('prefixes every reported line with eedsh:', () => {
    for (const { name, error, lines } of CASES) {
      const emitted: string[] = []
      report((line) => emitted.push(line), error)
      expect(emitted, name).toEqual(lines.map((line) => `eedsh: ${line}`))
    }
  })
})
