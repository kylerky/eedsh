import { Effect } from 'effect'
import { FileSystemFailure } from '../../src/internal/effect/errors'
import type {
  DshInstallationShape,
  FileSystemShape,
  PackageManagerShape,
  PreflightShape,
} from '../../src/internal/effect/services'

/** In-memory file system matching the materializer's FileSystem service. */
export function memoryFileSystem(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const writeOrder: string[] = []
  const shape: FileSystemShape = {
    exists: (path) => Effect.succeed(files.has(path)),
    readFile: (path) => {
      const value = files.get(path)
      return value === undefined
        ? Effect.fail(new FileSystemFailure({ operation: 'readFile', path, cause: 'ENOENT' }))
        : Effect.succeed(value)
    },
    writeFileAtomic: (path, content) => {
      writeOrder.push(path)
      files.set(path, content)
      return Effect.void
    },
    ensureDir: () => Effect.void,
    remove: (path) => {
      files.delete(path)
      return Effect.void
    },
    rename: (from, to) => {
      const value = files.get(from)
      if (value === undefined) {
        return Effect.fail(
          new FileSystemFailure({ operation: 'rename', path: from, cause: 'ENOENT' }),
        )
      }
      files.delete(from)
      files.set(to, value)
      return Effect.void
    },
    writeFileExclusive: (path, content) => {
      if (files.has(path)) return Effect.succeed(false)
      writeOrder.push(path)
      files.set(path, content)
      return Effect.succeed(true)
    },
  }
  return { shape, files, writeOrder }
}

/** Package manager that records installs and optionally fails. */
export function fakePackageManager(options: { fail?: boolean } = {}) {
  const installs: string[] = []
  const shape: PackageManagerShape = {
    install: (dir) => {
      installs.push(dir)
      return options.fail
        ? (Effect.fail({
            _tag: 'PackageInstallFailure',
            profileDir: dir,
            cause: 'boom',
          }) as never)
        : Effect.void
    },
  }
  return { shape, installs }
}

/** DSH installation with a fixed bundle layer. */
export function fakeDsh(options: { patches?: Record<string, unknown>[]; version?: string } = {}) {
  const calls: { packageName: string; profileDir: string }[] = []
  const shape: DshInstallationShape = {
    version: options.version ?? '0.2.1-rc.2',
    installAnchor: '/dsh/package.json',
    binPath: '/dsh/lib/bin.js',
    resolveBundlePatches: (packageName, profileDir) => {
      calls.push({ packageName, profileDir })
      return Effect.succeed(options.patches ?? [])
    },
  }
  return { shape, calls }
}

/** Preflight that succeeds with optional warnings or fails with a tagged error. */
export function fakePreflight(options: { fail?: boolean; warnings?: string[] } = {}) {
  const calls: unknown[] = []
  const shape: PreflightShape = {
    check: (input) => {
      calls.push(input)
      if (options.fail) {
        return Effect.fail({
          _tag: 'PreflightFailure',
          message: 'unmatched target',
          warnings: ['patch: entry "missing-row" not found'],
        } as never)
      }
      return Effect.succeed({ warnings: options.warnings ?? [] })
    },
  }
  return { shape, calls }
}
