import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type EedshConfig, type ProfilePlan, validateConfigValue } from '@eedsh/plan'

const root = fileURLToPath(new URL('../..', import.meta.url))

/** One evaluated README example: its config and explicit profile selection. */
export interface ReadmeExample {
  readonly config: EedshConfig
  /**
   * Select one profile's validated plan.
   * @param profileName - a declared profile key.
   * @returns the profile's validated plan.
   */
  plan(profileName: string): ProfilePlan
}

/**
 * Extract the first TypeScript fenced block under a top-level README heading.
 * @param lines - README lines.
 * @param heading - heading text without the leading `## `.
 * @returns the block source.
 */
function exampleBlock(lines: readonly string[], heading: string): string {
  const headingIndex = lines.findIndex((line) => line.trim() === `## ${heading}`)
  if (headingIndex < 0) throw new Error(`README is missing the "${heading}" heading`)

  const fence = /^\s*```ts\s*$/
  const closingFence = /^\s*```\s*$/
  const fenceIndex = lines.findIndex((line, index) => index > headingIndex && fence.test(line))
  if (fenceIndex < 0) throw new Error(`README "${heading}" has no TypeScript block`)

  const endIndex = lines.findIndex((line, index) => index > fenceIndex && closingFence.test(line))
  if (endIndex < 0) throw new Error(`README "${heading}" has an unterminated TypeScript block`)
  return `${lines.slice(fenceIndex + 1, endIndex).join('\n')}\n`
}

/**
 * Perform the explicit one-profile selection a README example relies on.
 * @param config - the evaluated config.
 * @param profileName - the declared profile key.
 * @returns the validated plan.
 */
function selectPlan(config: EedshConfig, profileName: string): ProfilePlan {
  const selected = config.profiles[profileName]
  if (selected === undefined) {
    throw new Error(
      `README example declares no "${profileName}" profile (declared: ${Object.keys(config.profiles).join(', ')})`,
    )
  }
  if (selected._tag === 'Failure') {
    throw new Error(
      `README "${profileName}" profile is not a valid plan: ${selected.failure.message}`,
    )
  }
  return selected.success
}

/**
 * Evaluate a README example as a temporary TypeScript module and validate its
 * default export as an eedsh config. The module lives below the Vitest root, so
 * Vitest's transform resolves `@eedsh/config` to source. The temporary
 * directory is removed in `finally`, whether evaluation succeeds or fails.
 * @param heading - top-level README heading containing the example.
 * @returns the validated config plus an explicit profile selection helper.
 */
export async function readmeExample(heading: string): Promise<ReadmeExample> {
  const text = await readFile(join(root, 'README.md'), 'utf8')
  const source = exampleBlock(text.split('\n'), heading)
  const tempRoot = join(root, 'test/.tmp')
  await mkdir(tempRoot, { recursive: true })
  const dir = await mkdtemp(join(tempRoot, 'readme-'))
  const modulePath = join(dir, 'example.ts')
  try {
    await writeFile(modulePath, source)
    const loaded = (await import(pathToFileURL(modulePath).href)) as { default?: unknown }
    if (loaded.default === undefined) {
      throw new Error(`README "${heading}" example has no default export`)
    }
    const validated = validateConfigValue(loaded.default)
    if (validated._tag === 'Failure') {
      throw new Error(
        `README "${heading}" example is not a valid config: ${validated.failure.message}`,
      )
    }
    return {
      config: validated.success,
      plan: (profileName: string) => selectPlan(validated.success, profileName),
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
