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
import { Effect, Option, PlatformError } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
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
  /** Installer override, primarily for tests. */
  readonly install?: (dir: string) => Promise<void>
  /** Clock override for cleanup and markers. */
  readonly now?: () => number
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
async function optionalFile(
  fileSystem: FileSystem.FileSystem,
  path: string,
): Promise<string | undefined> {
  try {
    return await Effect.runPromise(fileSystem.readFileString(path))
  } catch {
    return undefined
  }
}

/** Whether a path exists; an inspection failure counts as missing. */
async function pathExists(fileSystem: FileSystem.FileSystem, path: string): Promise<boolean> {
  try {
    return await Effect.runPromise(fileSystem.exists(path))
  } catch {
    return false
  }
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
export async function previewKey(
  input: PreparePreviewInput,
  fileSystem: FileSystem.FileSystem,
): Promise<string> {
  const manifestPath = join(input.profileDir, 'package.json')
  let manifest: string
  try {
    manifest = await Effect.runPromise(fileSystem.readFileString(manifestPath))
  } catch (cause) {
    throw new PreviewError({
      code: 'preview.profile_missing',
      path: manifestPath,
      message: `cannot prepare a preview: profile ${JSON.stringify(input.profileName)} has no manifest at ${manifestPath}: ${messageOf(cause)}`,
    })
  }
  const workspace =
    (await optionalFile(fileSystem, join(input.profileDir, 'pnpm-workspace.yaml'))) ?? null
  const lockfile =
    (await optionalFile(fileSystem, join(input.profileDir, 'pnpm-lock.yaml'))) ?? null
  const material = canonicalJson({
    profile: input.profileName,
    manifest,
    workspace,
    lockfile,
    dshVersion: input.dshVersion,
    specs: normalizeSpecs(input.specs),
  })
  return createHash('sha256').update(material).digest('hex')
}

interface PreviewMarker {
  readonly key: string
  readonly profile: string
  readonly specs: readonly PreviewSpec[]
  readonly createdAt: number
}

async function readMarker(
  fileSystem: FileSystem.FileSystem,
  dir: string,
): Promise<PreviewMarker | undefined> {
  try {
    const parsed = JSON.parse(
      await Effect.runPromise(fileSystem.readFileString(join(dir, '.eedsh-preview.json'))),
    ) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
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
  } catch {
    return undefined
  }
}

async function packageInstalled(
  fileSystem: FileSystem.FileSystem,
  dir: string,
  name: string,
): Promise<boolean> {
  return await pathExists(fileSystem, join(dir, 'node_modules', ...name.split('/'), 'package.json'))
}

async function reusable(
  fileSystem: FileSystem.FileSystem,
  dir: string,
  key: string,
  specs: readonly PreviewSpec[],
  profileName: string,
): Promise<boolean> {
  const marker = await readMarker(fileSystem, dir)
  if (marker === undefined) return false
  if (marker.key !== key || marker.profile !== profileName) return false
  if (canonicalJson(marker.specs) !== canonicalJson(specs)) return false
  for (const spec of specs) {
    if (!(await packageInstalled(fileSystem, dir, spec.name))) return false
  }
  return true
}

/**
 * The default installer: pnpm install inside the preview directory.
 * @param dir - the preview directory.
 * @param spawner - the child-process spawn seam.
 * @returns a promise that resolves when pnpm exits successfully.
 */
export async function installPreviewWithPnpm(dir: string, spawner: SpawnLike): Promise<void> {
  const invocation = pnpmInvocation(['install'])
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawner(invocation.command, [...invocation.args], {
      cwd: dir,
      stdio: 'pipe',
      env: process.env,
    })
    let stderr = ''
    // The spawn seam pipes all three streams; drain stdout so a chatty installer
    // cannot block on a full pipe while its output stays suppressed.
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', (chunk: unknown) => {
      stderr += String(chunk)
    })
    child.on('error', (cause) => {
      reject(
        new PreviewError({
          code: 'preview.install_failed',
          path: dir,
          message: `cannot install the session preview at ${dir}: ${messageOf(cause)}`,
        }),
      )
    })
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else
        reject(
          new PreviewError({
            code: 'preview.install_failed',
            path: dir,
            message: `preview installation at ${dir} exited with code ${String(code)}: ${stderr.trim()}`,
          }),
        )
    })
  })
}

async function writePreviewManifest(
  fileSystem: FileSystem.FileSystem,
  dir: string,
  specs: readonly PreviewSpec[],
): Promise<void> {
  const path = join(dir, 'package.json')
  const parsed = JSON.parse(await Effect.runPromise(fileSystem.readFileString(path))) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PreviewError({
      code: 'preview.profile_invalid',
      path,
      message: `cannot prepare a preview: profile manifest ${path} must hold a JSON object`,
    })
  }
  const manifest = parsed as Record<string, unknown>
  const dependencies =
    manifest.dependencies !== null &&
    typeof manifest.dependencies === 'object' &&
    !Array.isArray(manifest.dependencies)
      ? { ...(manifest.dependencies as Record<string, string>) }
      : {}
  for (const spec of specs) dependencies[spec.name] = spec.version
  manifest.dependencies = dependencies
  await Effect.runPromise(
    fileSystem.writeFileString(path, `${JSON.stringify(manifest, null, 2)}\n`),
  )
}

async function copyProfileMetadata(
  input: PreparePreviewInput,
  dir: string,
  fileSystem: FileSystem.FileSystem,
): Promise<void> {
  await Effect.runPromise(fileSystem.makeDirectory(dir, { recursive: true }))
  await Effect.runPromise(
    fileSystem.copyFile(join(input.profileDir, 'package.json'), join(dir, 'package.json')),
  )
  for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    const source = join(input.profileDir, file)
    if (await pathExists(fileSystem, source)) {
      await Effect.runPromise(fileSystem.copyFile(source, join(dir, file)))
    }
  }
  await writePreviewManifest(fileSystem, dir, normalizeSpecs(input.specs))
}

const inProcessLocks = new Map<string, Promise<void>>()

async function withInProcessLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = inProcessLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise
  })
  const next = previous.then(() => current)
  inProcessLocks.set(key, next)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (inProcessLocks.get(key) === next) inProcessLocks.delete(key)
  }
}

const LOCK_TIMEOUT_MS = 30_000
const STALE_LOCK_MS = 5 * 60_000

async function acquireFileLock(
  fileSystem: FileSystem.FileSystem,
  path: string,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (true) {
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fileSystem.open(path, { flag: 'wx' })
            yield* handle.writeAll(new TextEncoder().encode(String(process.pid)))
          }),
        ),
      )
      return async () => {
        await Effect.runPromise(fileSystem.remove(path, { force: true }))
      }
    } catch (cause) {
      const exists = PlatformError.isPlatformError(cause) && cause.reason._tag === 'AlreadyExists'
      if (!exists) {
        throw new PreviewError({
          code: 'preview.lock_failed',
          path,
          message: `cannot lock the session preview at ${path}: ${messageOf(cause)}`,
        })
      }
      try {
        const info = await Effect.runPromise(fileSystem.stat(path))
        if (Date.now() - modifiedTime(info) > STALE_LOCK_MS) {
          await Effect.runPromise(fileSystem.remove(path, { force: true }))
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) {
        throw new PreviewError({
          code: 'preview.lock_timeout',
          path,
          message: `timed out waiting for another session to finish the preview at ${path}`,
        })
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }
  }
}

/**
 * Prepare or reuse a preview for the selected profile. Concurrent sessions
 * with the same key serialize on an in-process chain and a cache lock file.
 * @param input - profile, selected DSH version, specs, and cache/install seams.
 * @param services - the file-system and spawn services to read and install through.
 * @returns the prepared preview and its profile-root override.
 */
export async function preparePreview(
  input: PreparePreviewInput,
  services: PreviewServices,
): Promise<PreparedPreview> {
  const { fileSystem, spawner } = services
  const specs = normalizeSpecs(input.specs)
  if (specs.length === 0) {
    throw new PreviewError({
      code: 'preview.spec_required',
      message: 'a preview needs at least one exact package spec, such as @acme/x@1.2.3',
    })
  }
  const key = await previewKey(input, fileSystem)
  const cacheRoot = input.cacheRoot ?? previewCacheRoot(input.env)
  await Effect.runPromise(fileSystem.makeDirectory(cacheRoot, { recursive: true }))
  await cleanupPreviews(cacheRoot, fileSystem, {
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.maxAgeMs === undefined ? {} : { maxAgeMs: input.maxAgeMs }),
  }).catch(() => undefined)
  const dir = join(cacheRoot, key)
  const lockPath = join(cacheRoot, `${key}.lock`)

  return withInProcessLock(key, async () => {
    const release = await acquireFileLock(fileSystem, lockPath)
    try {
      if (await reusable(fileSystem, dir, key, specs, input.profileName)) {
        return {
          key,
          dir,
          profileName: input.profileName,
          specs,
          override: { [input.profileName]: dir },
          reused: true,
        }
      }
      await Effect.runPromise(fileSystem.remove(dir, { recursive: true, force: true }))
      await copyProfileMetadata(input, dir, fileSystem)
      const install =
        input.install ?? ((installDir: string) => installPreviewWithPnpm(installDir, spawner))
      try {
        await install(dir)
      } catch (cause) {
        throw cause instanceof PreviewError
          ? cause
          : new PreviewError({
              code: 'preview.install_failed',
              path: dir,
              message: `preview installation at ${dir} failed: ${messageOf(cause)}`,
            })
      }
      for (const spec of specs) {
        if (!(await packageInstalled(fileSystem, dir, spec.name))) {
          throw new PreviewError({
            code: 'preview.package_missing',
            path: dir,
            message: `preview installation at ${dir} did not install ${spec.name}@${spec.version}`,
          })
        }
      }
      const marker: PreviewMarker = {
        key,
        profile: input.profileName,
        specs,
        createdAt: (input.now ?? Date.now)(),
      }
      await Effect.runPromise(
        fileSystem.writeFileString(
          join(dir, '.eedsh-preview.json'),
          `${JSON.stringify(marker, null, 2)}\n`,
        ),
      )
      return {
        key,
        dir,
        profileName: input.profileName,
        specs,
        override: { [input.profileName]: dir },
        reused: false,
      }
    } finally {
      await release()
    }
  })
}

/**
 * Remove one preview directory, leaving its lock file alone.
 * @param dir - the preview directory.
 * @param fileSystem - the file-system service.
 * @returns a promise that resolves once the directory is gone.
 */
export async function removePreview(dir: string, fileSystem: FileSystem.FileSystem): Promise<void> {
  await Effect.runPromise(fileSystem.remove(dir, { recursive: true, force: true }))
}

/** Inputs for {@link cleanupPreviews}. */
export interface CleanupPreviewsOptions {
  readonly maxAgeMs?: number
  readonly now?: () => number
}

/**
 * Remove preview directories older than the maximum age. Markers supply the
 * creation time; a directory without a readable marker falls back to mtime.
 * @param cacheRoot - the preview cache root.
 * @param fileSystem - the file-system service.
 * @param options - age and clock.
 * @returns the removed directories.
 */
export async function cleanupPreviews(
  cacheRoot: string,
  fileSystem: FileSystem.FileSystem,
  options: CleanupPreviewsOptions = {},
): Promise<string[]> {
  const maxAge = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000
  const now = (options.now ?? Date.now)()
  let entries: string[]
  try {
    entries = await Effect.runPromise(fileSystem.readDirectory(cacheRoot))
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of entries) {
    const dir = join(cacheRoot, name)
    let created = now
    const marker = await readMarker(fileSystem, dir)
    if (marker !== undefined) created = marker.createdAt
    else {
      try {
        const info = await Effect.runPromise(fileSystem.stat(dir))
        if (info.type !== 'Directory') continue
        created = createdTime(info)
      } catch {
        continue
      }
    }
    if (now - created <= maxAge) continue
    await Effect.runPromise(fileSystem.remove(dir, { recursive: true, force: true }))
    removed.push(dir)
  }
  return removed
}
