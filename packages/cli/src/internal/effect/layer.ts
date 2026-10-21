/**
 * Live service layers: the only place Node `fs` and `spawn` meet the Effect
 * pipeline. Everything else depends on the service shapes, so tests provide
 * plain test layers instead.
 * @module @eedsh/cli/internal/effect/layer
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Effect, Layer } from 'effect'
import { resolveBundleLayers, resolveDshInstallation } from '../../dsh'
import { writeFileAtomic } from '../atomic-write'
import { DshResolveFailure, FileSystemFailure, PackageInstallFailure } from './errors'
import {
  DshInstallation,
  type DshInstallationShape,
  FileSystem,
  type FileSystemShape,
  PackageManager,
  type PackageManagerShape,
} from './services'

/** Node-backed file access. */
export const nodeFileSystem: FileSystemShape = {
  exists: (path) =>
    Effect.tryPromise({
      try: async () => {
        try {
          await stat(path)
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
      },
      catch: (cause) => new FileSystemFailure({ operation: 'exists', path, cause }),
    }),
  readFile: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, 'utf8'),
      catch: (cause) => new FileSystemFailure({ operation: 'readFile', path, cause }),
    }),
  writeFileAtomic: (path, content) =>
    Effect.tryPromise({
      try: () => writeFileAtomic(path, content),
      catch: (cause) => new FileSystemFailure({ operation: 'writeFileAtomic', path, cause }),
    }),
  ensureDir: (path) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(path, { recursive: true })
      },
      catch: (cause) => new FileSystemFailure({ operation: 'ensureDir', path, cause }),
    }),
  remove: (path) =>
    Effect.tryPromise({
      try: async () => {
        await rm(path, { force: true })
      },
      catch: (cause) => new FileSystemFailure({ operation: 'remove', path, cause }),
    }),
  rename: (from, to) =>
    Effect.tryPromise({
      try: () => rename(from, to),
      catch: (cause) => new FileSystemFailure({ operation: 'rename', path: from, cause }),
    }),
  writeFileExclusive: (path, content) =>
    Effect.tryPromise({
      try: async () => {
        try {
          await writeFile(path, content, { flag: 'wx' })
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
          throw error
        }
      },
      catch: (cause) => new FileSystemFailure({ operation: 'writeFileExclusive', path, cause }),
    }),
}

/**
 * Install profile dependencies with pnpm inside the profile directory. pnpm is
 * DSH's own package manager, so the profile layout stays what `dsh plugin`
 * and boot expect.
 * @param profileDir - absolute profile directory.
 * @returns a promise settling when pnpm exits successfully.
 */
export function pnpmInstall(profileDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['install'], {
      cwd: profileDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`pnpm install exited with code ${String(code)}: ${stderr.trim()}`))
    })
  })
}

/** pnpm-backed package installation. */
export const pnpmPackageManager: PackageManagerShape = {
  install: (profileDir) =>
    Effect.tryPromise({
      try: () => pnpmInstall(profileDir),
      catch: (cause) => new PackageInstallFailure({ profileDir, cause }),
    }),
}

/** File access layer. */
export const nodeFileSystemLayer = Layer.succeed(FileSystem, nodeFileSystem)

/** Package installation layer. */
export const pnpmPackageManagerLayer = Layer.succeed(PackageManager, pnpmPackageManager)

/** The pinned DSH installation layer; construction fails when DSH is missing. */
export const dshInstallationLayer = Layer.effect(
  DshInstallation,
  Effect.try({
    try: (): DshInstallationShape => {
      const info = resolveDshInstallation()
      return {
        ...info,
        resolveBundlePatches: (packageName, profileDir) =>
          Effect.try({
            try: () => resolveBundleLayers(packageName, profileDir, info.installAnchor),
            catch: (cause) => new DshResolveFailure({ packageName, cause }),
          }),
      }
    },
    catch: (cause) => new DshResolveFailure({ packageName: '@deepseek-ai/dsh', cause }),
  }),
)

/** Every live service the pipeline needs except preflight. */
export const liveServiceLayer = Layer.mergeAll(
  nodeFileSystemLayer,
  pnpmPackageManagerLayer,
  dshInstallationLayer,
)
