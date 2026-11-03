/**
 * The real source-bundle fixture. The committed fixture holds no build output:
 * `lib/` is gitignored and produced by `pnpm run build`, so provisioning must
 * clone, prepare, and verify rather than link a prebuilt tree.
 * @module test/support/source-fixture
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The fixture bundle's package name. */
export const SOURCE_BUNDLE_NAME = '@fixture/source-bundle'

/** One fixture repository prepared in place. */
export interface SourceRepository {
  /** The directory holding the repository; it carries no `.git` suffix. */
  readonly dir: string
  /** The `file://` URL naming that directory. */
  readonly url: string
}

/**
 * Copy the source-bundle fixture into `parent` and initialize a git repository
 * in place, committing everything the fixture tracks.
 * @param parent - the directory to create the repository in.
 * @returns the repository directory and its file URL.
 */
export async function createSourceRepository(parent: string): Promise<SourceRepository> {
  const fixture = join(process.cwd(), 'packages/cli/test/fixtures/source-bundle')
  const dir = join(parent, 'source-bundle')
  await mkdir(parent, { recursive: true })
  await cp(fixture, dir, { recursive: true })
  execFileSync('git', ['init', dir], { encoding: 'utf8' })
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  git('add', '.')
  git(
    '-c',
    'user.email=eedsh@example.test',
    '-c',
    'user.name=eedsh',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'fixture: source bundle',
  )
  return { dir, url: pathToFileURL(dir).href }
}
