import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type ProfilePlan, validatePlan } from '@eedsh/config'

const root = fileURLToPath(new URL('../..', import.meta.url))

/** The shape of Effect's Result that a README example may export. */
interface ResultLike {
  readonly _tag: 'Success' | 'Failure'
  readonly success?: unknown
  readonly failure?: { readonly message?: string }
}

/** Whether a value is an Effect Result without importing Effect from this root module. */
function isResult(value: unknown): value is ResultLike {
  if (typeof value !== 'object' || value === null) return false
  const tag = (value as { _tag?: unknown })._tag
  return tag === 'Success' || tag === 'Failure'
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
 * Evaluate a README example as a temporary TypeScript module and validate its
 * default export. The module lives below the Vitest root, so Vitest's transform
 * resolves `@eedsh/config` to source. The temporary directory is removed in
 * `finally`, whether evaluation succeeds or fails.
 * @param heading - top-level README heading containing the example.
 * @returns the validated plan.
 */
export async function readmePlan(heading: string): Promise<ProfilePlan> {
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
    const exported = loaded.default
    if (isResult(exported) && exported._tag === 'Failure') {
      throw new Error(
        `README "${heading}" example returned a failed Result: ${exported.failure?.message ?? 'unknown failure'}`,
      )
    }
    const candidate = isResult(exported) ? exported.success : exported
    const validated = validatePlan(candidate)
    if (validated._tag === 'Failure') {
      throw new Error(
        `README "${heading}" example is not a valid plan: ${validated.failure.message}`,
      )
    }
    return validated.success
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
