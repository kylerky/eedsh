/**
 * Profile directory layout and file ownership. Materialization creates the
 * files DSH needs when they are missing and never rewrites a user-owned patch
 * layer.
 * @module @eedsh/cli/materialize/profile
 */
import { join } from 'node:path'
import { Effect } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import { writeFileAtomic } from '../internal/atomic-write'

/** The profile's user-owned patch layer. */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** The empty root configuration DSH mounts the patch stack over. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/** pnpm settings out-of-tree profile plugins need. */
export const PROFILE_WORKSPACE_FILENAME = 'pnpm-workspace.yaml'

/** eedsh's private directory inside a profile. */
export const EEDSH_DIRNAME = '.eedsh'

/** The generated bundle package directory, relative to the profile. */
export const GENERATED_DIRNAME = '.eedsh/generated'

/** The inspectable plan copy, relative to the profile. */
export const PLAN_RELATIVE_PATH = '.eedsh/plan.json'

/** The advisory provenance sidecar, relative to the profile. */
export const PROVENANCE_RELATIVE_PATH = '.eedsh/provenance.json'

/** The profile-local sync lock, relative to the profile. */
export const LOCK_RELATIVE_PATH = '.eedsh/sync.lock'

/** The generated package manifest, relative to the profile. */
export const GENERATED_MANIFEST_RELATIVE_PATH = '.eedsh/generated/package.json'

/** Root configuration content: DSH composes everything from patch layers. */
export const PROFILE_ROOT_TEMPLATE = '[]\n'

/** An empty, user-editable patch layer. */
export const PROFILE_PATCH_TEMPLATE = '[]\n'

/** pnpm settings copied from DSH's own profile initialization. */
export const PROFILE_WORKSPACE_TEMPLATE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** Which profile files this call created. */
export interface EnsureProfileFilesResult {
  createdRoot: boolean
  createdPatch: boolean
  createdWorkspace: boolean
}

/**
 * Create the profile's root configuration, patch layer, and pnpm workspace
 * when they are missing. Existing files are never touched.
 * @param dir - absolute profile directory.
 * @param fs - the platform file-system service.
 * @returns which files were created.
 */
export function ensureProfileFiles(
  dir: string,
  fs: FileSystem.FileSystem,
): Effect.Effect<EnsureProfileFilesResult, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    yield* fs.makeDirectory(dir, { recursive: true })
    yield* fs.makeDirectory(join(dir, EEDSH_DIRNAME), { recursive: true })
    const root = join(dir, PROFILE_ROOT_FILENAME)
    const patch = join(dir, PROFILE_PATCH_FILENAME)
    const workspace = join(dir, PROFILE_WORKSPACE_FILENAME)

    let createdRoot = false
    let createdPatch = false
    let createdWorkspace = false
    if (!(yield* fs.exists(root))) {
      yield* writeFileAtomic(fs, root, PROFILE_ROOT_TEMPLATE)
      createdRoot = true
    }
    if (!(yield* fs.exists(patch))) {
      yield* writeFileAtomic(fs, patch, PROFILE_PATCH_TEMPLATE)
      createdPatch = true
    }
    if (!(yield* fs.exists(workspace))) {
      yield* writeFileAtomic(fs, workspace, PROFILE_WORKSPACE_TEMPLATE)
      createdWorkspace = true
    }
    return { createdRoot, createdPatch, createdWorkspace }
  })
}
