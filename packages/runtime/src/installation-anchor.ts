/**
 * The machine-local DSH installation anchor. The CLI records the package it
 * selected or bootstrapped, and the runtime refreshes the record on every
 * profile boot. Paths, the format-1 record, and its validation live here so the
 * CLI and the runtime share one schema. This module is plain Node code and
 * deliberately free of Effect and DSH imports.
 * @module @eedsh/runtime/installation-anchor
 */
import { randomUUID } from 'node:crypto'
import { rmdirSync, rmSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

/** The one anchor record format this release reads and writes. */
export const INSTALLATION_ANCHOR_FORMAT = 1

/** Directory parts below the DSH home that hold the anchor record. */
export const INSTALLATION_ANCHOR_PARTS = ['.local', 'state', 'installation.json'] as const

/** Directory parts of the retired anchor location, cleaned up after a successful write. */
export const RETIRED_INSTALLATION_ANCHOR_PARTS = ['.eedsh', 'installation.json'] as const

/** The package managers the automatic bootstrap supports. */
export type InstallationAnchorManager = 'pnpm' | 'npm'

/**
 * The recorded installation anchor. `format` and an absolute `installAnchor`
 * package.json are required; the remaining fields are provenance and are
 * present when the writer knows them.
 */
export interface InstallationAnchor {
  readonly format: number
  readonly installAnchor: string
  readonly version?: string
  readonly launcher?: string
  readonly manager?: InstallationAnchorManager
  readonly recordedBy?: string
  readonly recordedAt?: string
}

/** A decoded record or the reason it was rejected. */
export type InstallationAnchorDecode =
  | { readonly ok: true; readonly anchor: InstallationAnchor }
  | { readonly ok: false; readonly reason: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reject(reason: string): InstallationAnchorDecode {
  return { ok: false, reason }
}

/**
 * Resolve the anchor record path for one DSH home.
 * @param home - absolute DSH home (the directory that contains `profiles`).
 * @returns the absolute record path.
 */
export function installationAnchorPath(home: string): string {
  return join(home, ...INSTALLATION_ANCHOR_PARTS)
}

/**
 * Validate one parsed anchor value.
 * @param value - parsed JSON value.
 * @returns the normalized record, or the validation reason.
 */
export function validateInstallationAnchorValue(value: unknown): InstallationAnchorDecode {
  if (!isObject(value)) return reject('the installation anchor must be a JSON object')
  const format = value.format
  if (format !== INSTALLATION_ANCHOR_FORMAT) {
    return reject(
      `unsupported installation anchor format ${JSON.stringify(format)}; expected ${INSTALLATION_ANCHOR_FORMAT}`,
    )
  }
  const installAnchor = value.installAnchor
  if (typeof installAnchor !== 'string' || installAnchor.length === 0) {
    return reject('the installation anchor has no installAnchor path')
  }
  if (!isAbsolute(installAnchor)) {
    return reject(
      `installAnchor must be an absolute package.json path: ${JSON.stringify(installAnchor)}`,
    )
  }
  if (basename(installAnchor) !== 'package.json') {
    return reject(`installAnchor must name a package.json: ${JSON.stringify(installAnchor)}`)
  }
  const version = value.version
  if (version !== undefined && (typeof version !== 'string' || version.length === 0)) {
    return reject('version must be a non-empty string when present')
  }
  const launcher = value.launcher
  if (launcher !== undefined) {
    if (typeof launcher !== 'string' || launcher.length === 0) {
      return reject('launcher must be a non-empty string when present')
    }
    if (!isAbsolute(launcher)) {
      return reject(`launcher must be absolute when present: ${JSON.stringify(launcher)}`)
    }
  }
  const manager = value.manager
  if (manager !== undefined && manager !== 'pnpm' && manager !== 'npm') {
    return reject(`manager must be "pnpm" or "npm" when present: ${JSON.stringify(manager)}`)
  }
  const recordedBy = value.recordedBy
  if (recordedBy !== undefined && (typeof recordedBy !== 'string' || recordedBy.length === 0)) {
    return reject('recordedBy must be a non-empty string when present')
  }
  const recordedAt = value.recordedAt
  if (recordedAt !== undefined && (typeof recordedAt !== 'string' || recordedAt.length === 0)) {
    return reject('recordedAt must be a non-empty string when present')
  }
  return {
    ok: true,
    anchor: {
      format: INSTALLATION_ANCHOR_FORMAT,
      installAnchor,
      ...(version === undefined ? {} : { version }),
      ...(launcher === undefined ? {} : { launcher }),
      ...(manager === undefined ? {} : { manager }),
      ...(recordedBy === undefined ? {} : { recordedBy }),
      ...(recordedAt === undefined ? {} : { recordedAt }),
    },
  }
}

/**
 * Parse and validate one anchor record.
 * @param text - the record file's text.
 * @returns the normalized record, or the rejection reason.
 */
export function decodeInstallationAnchor(text: string): InstallationAnchorDecode {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return reject(`the installation anchor is not valid JSON: ${errorMessage(error)}`)
  }
  return validateInstallationAnchorValue(parsed)
}

/**
 * Encode one anchor record as the file content.
 * @param anchor - the record to encode.
 * @returns pretty-printed JSON with a trailing newline.
 */
export function encodeInstallationAnchor(anchor: InstallationAnchor): string {
  const value = {
    format: anchor.format,
    installAnchor: anchor.installAnchor,
    ...(anchor.version === undefined ? {} : { version: anchor.version }),
    ...(anchor.launcher === undefined ? {} : { launcher: anchor.launcher }),
    ...(anchor.manager === undefined ? {} : { manager: anchor.manager }),
    ...(anchor.recordedBy === undefined ? {} : { recordedBy: anchor.recordedBy }),
    ...(anchor.recordedAt === undefined ? {} : { recordedAt: anchor.recordedAt }),
  }
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Read and validate the anchor for one DSH home. A missing, unreadable, or
 * malformed record is reported rather than thrown.
 * @param home - absolute DSH home.
 * @returns the decoded record or the rejection reason.
 */
export async function readInstallationAnchorFile(home: string): Promise<InstallationAnchorDecode> {
  const path = installationAnchorPath(home)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return reject(`cannot read ${path}: ${errorMessage(error)}`)
  }
  return decodeInstallationAnchor(text)
}

/**
 * Remove the retired anchor record and then the retired directory when it
 * holds nothing else. Cleanup never fails an anchor write: the new record is
 * already authoritative, and a retired directory holding other content stays
 * untouched.
 * @param home - absolute DSH home.
 * @returns a promise that resolves after cleanup is attempted.
 */
export async function cleanupRetiredInstallationAnchor(home: string): Promise<void> {
  const path = join(home, ...RETIRED_INSTALLATION_ANCHOR_PARTS)
  try {
    await rm(path, { force: true })
  } catch {
    // The retired record could not be removed; leave its directory alone.
    return
  }
  try {
    await rmdir(dirname(path))
  } catch {
    // The retired directory holds other content or is already gone.
  }
}

/**
 * Synchronous variant of {@link cleanupRetiredInstallationAnchor} for writers
 * that run before the command's services are built.
 * @param home - absolute DSH home.
 */
export function cleanupRetiredInstallationAnchorSync(home: string): void {
  const path = join(home, ...RETIRED_INSTALLATION_ANCHOR_PARTS)
  try {
    rmSync(path, { force: true })
  } catch {
    return
  }
  try {
    rmdirSync(dirname(path))
  } catch {
    // The retired directory holds other content or is already gone.
  }
}

/**
 * Atomically write the anchor record below one DSH home, creating the
 * `.local/state` directory owner-only. The temporary file is removed when the
 * write or rename fails. A successful write cleans up the retired
 * `.eedsh/installation.json` location.
 * @param home - absolute DSH home.
 * @param anchor - the record to write.
 * @returns a promise that resolves after the rename.
 */
export async function writeInstallationAnchorFile(
  home: string,
  anchor: InstallationAnchor,
): Promise<void> {
  const path = installationAnchorPath(home)
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temp = join(directory, `.installation.json.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, encodeInstallationAnchor(anchor), { encoding: 'utf8', mode: 0o600 })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
  await chmod(path, 0o600).catch(() => {})
  await chmod(directory, 0o700).catch(() => {})
  await cleanupRetiredInstallationAnchor(home)
}
