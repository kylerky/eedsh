/**
 * Entry-point verification for a provisioned package. Before a generation is
 * published, the package manifest must name the declared package and every
 * declared entry point must resolve to a file, so an unbuilt checkout fails
 * during sync instead of at DSH boot.
 * @module @eedsh/cli/provision/verify
 */
import { join } from 'node:path'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import * as Result from 'effect/Result'
import { ProvisionFailure } from '../internal/effect/errors'

/** Inputs for {@link verifyProvisionedPackage}. */
export interface VerifyProvisionedPackageInput {
  /** The declared package name. */
  readonly name: string
  /** The provisioned package directory. */
  readonly packageDir: string
}

const CONDITION_KEYS = ['default', 'import', 'require', 'node'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Pick the first resolvable target from a condition object. */
function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return undefined
  for (const key of CONDITION_KEYS) {
    if (!Object.hasOwn(value, key)) continue
    const target = exportTarget(value[key])
    if (target !== undefined) return target
  }
  return undefined
}

/** The package's main entry: the root export, or `main`. */
function mainTarget(manifest: Record<string, unknown>): string | undefined {
  const exports = manifest.exports
  if (typeof exports === 'string') return exports
  if (isRecord(exports) && Object.hasOwn(exports, '.')) {
    const target = exportTarget(exports['.'])
    if (target !== undefined) return target
  }
  return typeof manifest.main === 'string' ? manifest.main : undefined
}

/** Whether the package declares a DSH client half. */
function clientDeclared(manifest: Record<string, unknown>): boolean {
  const dsh = manifest.dsh
  return (
    isRecord(dsh) &&
    Object.hasOwn(dsh, 'client') &&
    dsh.client !== undefined &&
    dsh.client !== null &&
    dsh.client !== false
  )
}

function verifyFailure(input: {
  readonly name: string
  readonly path: string
  readonly message: string
}): ProvisionFailure {
  return new ProvisionFailure({
    code: 'provision.verify_failed',
    packageName: input.name,
    path: input.path,
    message: input.message,
  })
}

/**
 * Verify a provisioned package's manifest and declared entry points.
 * @param input - the declared package name and the provisioned directory.
 * @returns success when the manifest names the package and every entry exists.
 */
export function verifyProvisionedPackage(
  input: VerifyProvisionedPackageInput,
): Effect.Effect<void, ProvisionFailure | PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const manifestPath = join(input.packageDir, 'package.json')
    if (!(yield* fs.exists(manifestPath))) {
      return yield* Effect.fail(
        verifyFailure({
          name: input.name,
          path: manifestPath,
          message: `provisioned package ${JSON.stringify(input.name)} has no manifest at ${manifestPath}`,
        }),
      )
    }
    const text = yield* fs.readFileString(manifestPath)
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) => cause,
    }).pipe(Effect.result)
    if (Result.isFailure(parsed) || !isRecord(parsed.success)) {
      return yield* Effect.fail(
        verifyFailure({
          name: input.name,
          path: manifestPath,
          message: `provisioned package ${JSON.stringify(input.name)} has an unreadable manifest at ${manifestPath}`,
        }),
      )
    }
    const manifest = parsed.success

    const manifestName = manifest.name
    if (manifestName !== input.name) {
      return yield* Effect.fail(
        verifyFailure({
          name: input.name,
          path: manifestPath,
          message:
            `provisioned package at ${input.packageDir} is named ` +
            `${JSON.stringify(manifestName)}, but the profile declares ${JSON.stringify(input.name)}`,
        }),
      )
    }

    const main = mainTarget(manifest)
    if (main === undefined) {
      return yield* Effect.fail(
        verifyFailure({
          name: input.name,
          path: manifestPath,
          message: `provisioned package ${JSON.stringify(input.name)} declares no main entry or "." export in ${manifestPath}`,
        }),
      )
    }
    const mainPath = join(input.packageDir, main)
    if (!(yield* fs.exists(mainPath))) {
      return yield* Effect.fail(
        verifyFailure({
          name: input.name,
          path: mainPath,
          message: `provisioned package ${JSON.stringify(input.name)} declares main entry ${main}, which does not exist at ${mainPath}`,
        }),
      )
    }

    if (!clientDeclared(manifest)) return
    const exports = isRecord(manifest.exports) ? manifest.exports : undefined
    const client = exports === undefined ? undefined : exportTarget(exports['./client'])
    if (client === undefined) {
      return yield* Effect.fail(
        verifyFailure({
          name: input.name,
          path: manifestPath,
          message: `provisioned package ${JSON.stringify(input.name)} declares a DSH client half but ${manifestPath} has no "./client" export`,
        }),
      )
    }
    const clientPath = join(input.packageDir, client)
    if (!(yield* fs.exists(clientPath))) {
      return yield* Effect.fail(
        verifyFailure({
          name: input.name,
          path: clientPath,
          message: `provisioned package ${JSON.stringify(input.name)} declares client entry ${client}, which does not exist at ${clientPath}`,
        }),
      )
    }
  })
}
