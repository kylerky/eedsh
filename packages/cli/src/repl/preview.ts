/**
 * Session-local preview resolution for custom bundles. A preview is a
 * hash-keyed copy of the selected profile's package metadata and lockfile,
 * installed in the XDG cache and never written into the profile.
 * @module @eedsh/cli/repl/preview
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { canonicalJson } from '@eedsh/plan'
import { Cause, Effect, Exit, Option, PlatformError } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import * as Result from 'effect/Result'
import * as Semaphore from 'effect/Semaphore'
import { pnpmInvocation } from '../command-runner'
import type { SpawnLike } from '../spawn'

/** One exact package request for a preview. */
export interface PreviewSpec {
  readonly name: string
  readonly version: string
}

/** Inputs for {@link preparePreview}. */
export interface PreparePreviewInput {
  readonly profileName: string
  /** Absolute real profile directory. */
  readonly profileDir: string
  /** The selected DSH installation version, part of the cache key. */
  readonly dshVersion: string
  readonly specs: readonly PreviewSpec[]
  readonly env: Record<string, string | undefined>
  /** Cache root override, primarily for tests. */
  readonly cacheRoot?: string
  /** The installer seam; the session passes the pnpm installer. */
  readonly install: (dir: string) => Effect.Effect<void, unknown>
  /** The clock seam for cleanup and markers. */
  readonly now: () => number
  /** Age after which an unused preview is removed. */
  readonly maxAgeMs?: number
}

/** The services preview preparation reads and installs through. */
export interface PreviewServices {
  /** The file-system service used for every preview read and write. */
  readonly fileSystem: FileSystem.FileSystem
  /** The child-process seam used by the default pnpm installer. */
  readonly spawner: SpawnLike
}

/** A ready preview directory and the profile override that selects it. */
export interface PreparedPreview {
  readonly key: string
  readonly dir: string
  readonly profileName: string
  readonly specs: readonly PreviewSpec[]
  readonly override: Readonly<Record<string, string>>
  /** Whether the install was skipped because the key was already complete. */
  readonly reused: boolean
}

/** A structured preview failure. */
export class PreviewError extends Error {
  readonly _tag = 'PreviewError'
  readonly code: string
  readonly path?: string

  constructor(input: { readonly code: string; readonly message: string; readonly path?: string }) {
    super(input.message)
    this.name = 'PreviewError'
    this.code = input.code
    if (input.path !== undefined) this.path = input.path
  }
}

/** The default preview cache root below the XDG cache home. */
export function previewCacheRoot(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CACHE_HOME
  const home = env.HOME ?? env.USERPROFILE ?? homedir()
  const base = xdg !== undefined && xdg !== '' && isAbsolute(xdg) ? xdg : join(home, '.cache')
  return join(base, 'eedsh', 'repl')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read a file, or undefined when it is missing or unreadable. */
function optionalFile(
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<string | undefined> {
  return fileSystem.readFileString(path).pipe(
    Effect.result,
    Effect.map((read) => (Result.isSuccess(read) ? read.success : undefined)),
  )
}

/** Whether a path exists; an inspection failure counts as missing. */
function pathExists(fileSystem: FileSystem.FileSystem, path: string): Effect.Effect<boolean> {
  return fileSystem.exists(path).pipe(
    Effect.result,
    Effect.map((checked) => (Result.isSuccess(checked) ? checked.success : false)),
  )
}

/** The reported modification time, in milliseconds, or zero when unavailable. */
function modifiedTime(info: FileSystem.File.Info): number {
  return Option.match(info.mtime, {
    onNone: () => 0,
    onSome: (date) => date.getTime(),
  })
}

/** The reported creation time, in milliseconds, or zero when unavailable. */
function createdTime(info: FileSystem.File.Info): number {
  const birthtime = Option.match(info.birthtime, {
    onNone: () => 0,
    onSome: (date) => date.getTime(),
  })
  return birthtime || modifiedTime(info)
}

function normalizeSpecs(specs: readonly PreviewSpec[]): PreviewSpec[] {
  const seen = new Map<string, string>()
  for (const spec of specs) seen.set(spec.name, spec.version)
  return [...seen.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, version]) => ({ name, version }))
}

/**
 * Compute the cache key from the copied inputs and requested exact specs.
 * @param input - profile, selected DSH version, and requested specs.
 * @param fileSystem - the file-system service.
 * @returns the hash-keyed cache directory name.
 */
export function previewKey(
  input: PreparePreviewInput,
  fileSystem: FileSystem.FileSystem,
): Effect.Effect<string, PreviewError> {
  return Effect.gen(function* () {
    const manifestPath = join(input.profileDir, 'package.json')
    const read = yield* Effect.result(fileSystem.readFileString(manifestPath))
    if (Result.isFailure(read)) {
      return yield* Effect.fail(
        new PreviewError({
          code: 'preview.profile_missing',
          path: manifestPath,
          message: `cannot prepare a preview: profile ${JSON.stringify(input.profileName)} has no manifest at ${manifestPath}: ${messageOf(read.failure)}`,
        }),
      )
    }
    const workspace =
      (yield* optionalFile(fileSystem, join(input.profileDir, 'pnpm-workspace.yaml'))) ?? null
    const lockfile =
      (yield* optionalFile(fileSystem, join(input.profileDir, 'pnpm-lock.yaml'))) ?? null
    const material = canonicalJson({
      profile: input.profileName,
      manifest: read.success,
      workspace,
      lockfile,
      dshVersion: input.dshVersion,
      specs: normalizeSpecs(input.specs),
    })
    return createHash('sha256').update(material).digest('hex')
  })
}

interface PreviewMarker {
  readonly key: string
  readonly profile: string
  readonly specs: readonly PreviewSpec[]
  readonly createdAt: number
}

function readMarker(
  fileSystem: FileSystem.FileSystem,
  dir: string,
): Effect.Effect<PreviewMarker | undefined> {
  return Effect.gen(function* () {
    const content = yield* optionalFile(fileSystem, join(dir, '.eedsh-preview.json'))
    if (content === undefined) return undefined
    const parsed = Result.try(() => JSON.parse(content) as unknown)
    if (Result.isFailure(parsed)) return undefined
    const value = parsed.success
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (record.key !== basename(dir)) return undefined
    if (typeof record.profile !== 'string') return undefined
    if (!Array.isArray(record.specs)) return undefined
    if (typeof record.createdAt !== 'number') return undefined
    const specs: PreviewSpec[] = []
    for (const item of record.specs) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
      const spec = item as Record<string, unknown>
      if (typeof spec.name !== 'string' || typeof spec.version !== 'string') return undefined
      specs.push({ name: spec.name, version: spec.version })
    }
    return {
      key: record.key as string,
      profile: record.profile,
      specs,
      createdAt: record.createdAt,
    }
  })
}

function packageInstalled(
  fileSystem: FileSystem.FileSystem,
  dir: string,
  name: string,
): Effect.Effect<boolean> {
  return pathExists(fileSystem, join(dir, 'node_modules', ...name.split('/'), 'package.json'))
}

function reusable(
  fileSystem: FileSystem.FileSystem,
  dir: string,
  key: string,
  specs: readonly PreviewSpec[],
  profileName: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const marker = yield* readMarker(fileSystem, dir)
    if (marker === undefined) return false
    if (marker.key !== key || marker.profile !== profileName) return false
    if (canonicalJson(marker.specs) !== canonicalJson(specs)) return false
    for (const spec of specs) {
      if (!(yield* packageInstalled(fileSystem, dir, spec.name))) return false
    }
    return true
  })
}

/**
 * The default installer: pnpm install inside the preview directory.
 * @param dir - the preview directory.
 * @param spawner - the child-process spawn seam.
 * @returns an effect that completes when pnpm exits successfully.
 */
export function installPreviewWithPnpm(
  dir: string,
  spawner: SpawnLike,
): Effect.Effect<void, PreviewError> {
  return Effect.callback<void, PreviewError>((resume) => {
    const invocation = pnpmInvocation(['install'])
    const child = spawner(invocation.command, [...invocation.args], {
      cwd: dir,
      stdio: 'pipe',
      env: process.env,
    })
    let settled = false
    let stderr = ''
    const finish = (effect: Effect.Effect<void, PreviewError>): void => {
      if (settled) return
      settled = true
      resume(effect)
    }
    // The spawn seam pipes all three streams; drain stdout so a chatty installer
    // cannot block on a full pipe while its output stays suppressed.
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (chunk: unknown) => {
      stderr += String(chunk)
    })
    child.on('error', (cause) => {
      finish(
        Effect.fail(
          new PreviewError({
            code: 'preview.install_failed',
            path: dir,
            message: `cannot install the session preview at ${dir}: ${messageOf(cause)}`,
          }),
        ),
      )
    })
    child.on('exit', (code) => {
      if (code === 0) {
        finish(Effect.void)
      } else {
        finish(
          Effect.fail(
            new PreviewError({
              code: 'preview.install_failed',
              path: dir,
              message: `preview installation at ${dir} exited with code ${String(code)}: ${stderr.trim()}`,
            }),
          ),
        )
      }
    })
    return Effect.void
  })
}

function writePreviewManifest(
  fileSystem: FileSystem.FileSystem,
  dir: string,
  specs: readonly PreviewSpec[],
): Effect.Effect<void, PreviewError | PlatformError.PlatformError> {
  return Effect.gen(function* () {
    const path = join(dir, 'package.json')
    const content = yield* fileSystem.readFileString(path)
    const parsed = Result.try(() => JSON.parse(content) as unknown)
    if (Result.isFailure(parsed)) {
      return yield* Effect.fail(
        new PreviewError({
          code: 'preview.profile_invalid',
          path,
          message: `cannot prepare a preview: profile manifest ${path} must hold a JSON object`,
        }),
      )
    }
    const value = parsed.success
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return yield* Effect.fail(
        new PreviewError({
          code: 'preview.profile_invalid',
          path,
          message: `cannot prepare a preview: profile manifest ${path} must hold a JSON object`,
        }),
      )
    }
    const manifest = value as Record<string, unknown>
    const dependencies =
      manifest.dependencies !== null &&
      typeof manifest.dependencies === 'object' &&
      !Array.isArray(manifest.dependencies)
        ? { ...(manifest.dependencies as Record<string, string>) }
        : {}
    for (const spec of specs) dependencies[spec.name] = spec.version
    manifest.dependencies = dependencies
    yield* fileSystem.writeFileString(path, `${JSON.stringify(manifest, null, 2)}\n`)
  })
}

function copyProfileMetadata(
  input: PreparePreviewInput,
  dir: string,
  fileSystem: FileSystem.FileSystem,
): Effect.Effect<void, PreviewError | PlatformError.PlatformError> {
  return Effect.gen(function* () {
    yield* fileSystem.makeDirectory(dir, { recursive: true })
    yield* fileSystem.copyFile(join(input.profileDir, 'package.json'), join(dir, 'package.json'))
    for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
      const source = join(input.profileDir, file)
      if (yield* pathExists(fileSystem, source)) {
        yield* fileSystem.copyFile(source, join(dir, file))
      }
    }
    yield* writePreviewManifest(fileSystem, dir, normalizeSpecs(input.specs))
  })
}

const inProcessLocks = new Map<string, Semaphore.Semaphore>()

/** The process-wide mutex for one preview key, created on first use. */
function inProcessLock(key: string): Semaphore.Semaphore {
  const existing = inProcessLocks.get(key)
  if (existing !== undefined) return existing
  const created = Semaphore.makeUnsafe(1)
  inProcessLocks.set(key, created)
  return created
}

function withInProcessLock<A, E>(key: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
  return Effect.flatMap(
    Effect.sync(() => inProcessLock(key)),
    (semaphore) => semaphore.withPermits(1)(effect),
  )
}

const LOCK_TIMEOUT_MS = 30_000
const STALE_LOCK_MS = 5 * 60_000

function acquireFileLock(
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<Effect.Effect<void>, PreviewError> {
  return Effect.gen(function* () {
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    while (true) {
      const attempt = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fileSystem.open(path, { flag: 'wx' })
            yield* handle.writeAll(new TextEncoder().encode(String(process.pid)))
          }),
        ),
      )
      if (Exit.isSuccess(attempt)) {
        return fileSystem.remove(path, { force: true }).pipe(Effect.ignore)
      }
      const cause = Cause.squash(attempt.cause)
      const exists = PlatformError.isPlatformError(cause) && cause.reason._tag === 'AlreadyExists'
      if (!exists) {
        return yield* Effect.fail(
          new PreviewError({
            code: 'preview.lock_failed',
            path,
            message: `cannot lock the session preview at ${path}: ${messageOf(cause)}`,
          }),
        )
      }
      const info = yield* Effect.exit(fileSystem.stat(path))
      if (Exit.isSuccess(info) && Date.now() - modifiedTime(info.value) > STALE_LOCK_MS) {
        yield* fileSystem.remove(path, { force: true }).pipe(Effect.ignore)
        continue
      }
      if (Date.now() > deadline) {
        return yield* Effect.fail(
          new PreviewError({
            code: 'preview.lock_timeout',
            path,
            message: `timed out waiting for another session to finish the preview at ${path}`,
          }),
        )
      }
      yield* Effect.sleep(50)
    }
  })
}

/**
 * Prepare or reuse a preview for the selected profile. Concurrent sessions
 * with the same key serialize on an in-process mutex and a cache lock file.
 * @param input - profile, selected DSH version, specs, cache/install seams, and clock.
 * @param services - the file-system and spawn services to read and install through.
 * @returns the prepared preview and its profile-root override.
 */
export function preparePreview(
  input: PreparePreviewInput,
  services: PreviewServices,
): Effect.Effect<PreparedPreview, PreviewError | PlatformError.PlatformError> {
  return Effect.gen(function* () {
    const { fileSystem } = services
    const specs = normalizeSpecs(input.specs)
    if (specs.length === 0) {
      return yield* Effect.fail(
        new PreviewError({
          code: 'preview.spec_required',
          message: 'a preview needs at least one exact package spec, such as @acme/x@1.2.3',
        }),
      )
    }
    const key = yield* previewKey(input, fileSystem)
    const cacheRoot = input.cacheRoot ?? previewCacheRoot(input.env)
    yield* fileSystem.makeDirectory(cacheRoot, { recursive: true })
    yield* Effect.exit(
      cleanupPreviews(cacheRoot, fileSystem, {
        now: input.now,
        ...(input.maxAgeMs === undefined ? {} : { maxAgeMs: input.maxAgeMs }),
      }),
    )
    const dir = join(cacheRoot, key)
    const lockPath = join(cacheRoot, `${key}.lock`)

    return yield* withInProcessLock(
      key,
      Effect.gen(function* () {
        const release = yield* acquireFileLock(fileSystem, lockPath)
        return yield* Effect.ensuring(
          Effect.gen(function* () {
            if (yield* reusable(fileSystem, dir, key, specs, input.profileName)) {
              return {
                key,
                dir,
                profileName: input.profileName,
                specs,
                override: { [input.profileName]: dir },
                reused: true,
              }
            }
            yield* fileSystem.remove(dir, { recursive: true, force: true })
            yield* copyProfileMetadata(input, dir, fileSystem)
            const installed = yield* Effect.exit(Effect.suspend(() => input.install(dir)))
            if (Exit.isFailure(installed)) {
              const cause = Cause.squash(installed.cause)
              return yield* Effect.fail(
                cause instanceof PreviewError
                  ? cause
                  : new PreviewError({
                      code: 'preview.install_failed',
                      path: dir,
                      message: `preview installation at ${dir} failed: ${messageOf(cause)}`,
                    }),
              )
            }
            for (const spec of specs) {
              if (!(yield* packageInstalled(fileSystem, dir, spec.name))) {
                return yield* Effect.fail(
                  new PreviewError({
                    code: 'preview.package_missing',
                    path: dir,
                    message: `preview installation at ${dir} did not install ${spec.name}@${spec.version}`,
                  }),
                )
              }
            }
            const marker: PreviewMarker = {
              key,
              profile: input.profileName,
              specs,
              createdAt: input.now(),
            }
            yield* fileSystem.writeFileString(
              join(dir, '.eedsh-preview.json'),
              `${JSON.stringify(marker, null, 2)}\n`,
            )
            return {
              key,
              dir,
              profileName: input.profileName,
              specs,
              override: { [input.profileName]: dir },
              reused: false,
            }
          }),
          release,
        )
      }),
    )
  })
}

/**
 * Remove one preview directory, leaving its lock file alone.
 * @param dir - the preview directory.
 * @param fileSystem - the file-system service.
 * @returns an effect that completes once the directory is gone.
 */
export function removePreview(
  dir: string,
  fileSystem: FileSystem.FileSystem,
): Effect.Effect<void, PlatformError.PlatformError> {
  return fileSystem.remove(dir, { recursive: true, force: true })
}

/** Inputs for {@link cleanupPreviews}. */
export interface CleanupPreviewsOptions {
  readonly maxAgeMs?: number
  /** The clock seam for marker and modification-age comparisons. */
  readonly now: () => number
}

/**
 * Remove preview directories older than the maximum age. Markers supply the
 * creation time; a directory without a readable marker falls back to mtime.
 * @param cacheRoot - the preview cache root.
 * @param fileSystem - the file-system service.
 * @param options - age and clock.
 * @returns the removed directories.
 */
export function cleanupPreviews(
  cacheRoot: string,
  fileSystem: FileSystem.FileSystem,
  options: CleanupPreviewsOptions,
): Effect.Effect<string[], PlatformError.PlatformError> {
  return Effect.gen(function* () {
    const maxAge = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000
    const now = options.now()
    const entries = yield* Effect.result(fileSystem.readDirectory(cacheRoot))
    if (Result.isFailure(entries)) return []
    const removed: string[] = []
    for (const name of entries.success) {
      const dir = join(cacheRoot, name)
      let created = now
      const marker = yield* readMarker(fileSystem, dir)
      if (marker !== undefined) {
        created = marker.createdAt
      } else {
        const info = yield* Effect.result(fileSystem.stat(dir))
        if (Result.isFailure(info)) continue
        if (info.success.type !== 'Directory') continue
        created = createdTime(info.success)
      }
      if (now - created <= maxAge) continue
      yield* fileSystem.remove(dir, { recursive: true, force: true })
      removed.push(dir)
    }
    return removed
  })
}
