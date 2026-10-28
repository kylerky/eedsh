import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const packages = ['config', 'cli', 'runtime'] as const

type PackageName = (typeof packages)[number]

const manifestCache = new Map<PackageName, Record<string, any>>()

function manifest(name: PackageName): Record<string, any> {
  const cached = manifestCache.get(name)
  if (cached) return cached
  const path = join(root, 'packages', name, 'package.json')
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
  manifestCache.set(name, parsed)
  return parsed
}

function dependencyNames(name: PackageName): string[] {
  const value = manifest(name)
  const groups = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  return groups.flatMap((group) => Object.keys(value[group] ?? {}))
}

function sourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.isFile() && path.endsWith('.ts')) files.push(path)
  }
  return files
}

function sourceImports(name: PackageName): { file: string; specifier: string }[] {
  const dir = join(root, 'packages', name, 'src')
  const imports: { file: string; specifier: string }[] = []
  for (const file of sourceFiles(dir)) {
    const text = readFileSync(file, 'utf8')
    const pattern = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier) imports.push({ file, specifier })
    }
  }
  return imports
}

/**
 * The only production exception sites the architecture check permits. The
 * malformed-expression branch is unreachable after plan validation, and the
 * Effect-free runtime is outside this scan.
 */
const EXCEPTION_ALLOWLIST = new Set(['packages/cli/src/materialize/yaml.ts'])

/** JavaScript exception control flow in one source text. */
function exceptionSites(text: string): string[] {
  const sites: string[] = []
  if (/\bthrow\b/.test(text)) sites.push('throw')
  if (/\btry\s*\{/.test(text)) sites.push('try')
  if (/(?<!Effect)\.catch\s*\(/.test(text)) sites.push('.catch')
  return sites
}

function exceptionViolations(): { file: string; sites: string[] }[] {
  const violations: { file: string; sites: string[] }[] = []
  for (const name of ['config', 'cli'] as const) {
    for (const file of sourceFiles(join(root, 'packages', name, 'src'))) {
      const relativePath = relative(root, file).replaceAll('\\', '/')
      if (EXCEPTION_ALLOWLIST.has(relativePath)) continue
      const sites = exceptionSites(readFileSync(file, 'utf8'))
      if (sites.length > 0) violations.push({ file: relativePath, sites })
    }
  }
  return violations
}

const TOOLCHAIN_PACKAGES = ['tsx', 'typescript']

function declaresEffect(name: PackageName): boolean {
  return dependencyNames(name).includes('effect')
}

function importsEffect(name: PackageName): boolean {
  return sourceImports(name).some(
    ({ specifier }) => specifier === 'effect' || specifier.startsWith('effect/'),
  )
}

function declaresToolchain(name: PackageName): boolean {
  return dependencyNames(name).some((dependency) => TOOLCHAIN_PACKAGES.includes(dependency))
}

function importsToolchain(name: PackageName): boolean {
  return sourceImports(name).some(({ specifier }) =>
    TOOLCHAIN_PACKAGES.some(
      (dependency) => specifier === dependency || specifier.startsWith(`${dependency}/`),
    ),
  )
}

describe('package boundaries', () => {
  it('keeps Effect out of @eedsh/runtime', () => {
    expect(declaresEffect('runtime'), '@eedsh/runtime must not depend on effect').toBe(false)
    expect(importsEffect('runtime'), '@eedsh/runtime must not import effect').toBe(false)
  })

  it('keeps runtime plan validators out of @eedsh/config', async () => {
    const config = await import('@eedsh/config')
    for (const symbol of [
      'validatePlan',
      'validateConfigValue',
      'ProfilePlanSchema',
      'EedshConfigSchema',
    ]) {
      expect(symbol in config, `@eedsh/config must not export ${symbol}`).toBe(false)
    }
  })

  it('re-exports plan symbols from @eedsh/config as types only', () => {
    const index = readFileSync(join(root, 'packages/config/src/index.ts'), 'utf8')
    expect(index, '@eedsh/config must not runtime re-export @eedsh/plan').not.toMatch(
      /export\s+\*\s+from\s+['"]@eedsh\/plan['"]/,
    )
  })

  it('has @eedsh/cli import the plan contract directly', () => {
    const specifiers = sourceImports('cli').map(({ specifier }) => specifier)
    expect(specifiers, '@eedsh/cli must import @eedsh/plan').toContain('@eedsh/plan')
  })

  it('confines the DSH runtime dependency to @eedsh/cli and @eedsh/runtime types', () => {
    for (const dependency of dependencyNames('config')) {
      expect(
        dependency.startsWith('@deepseek-ai/'),
        `@eedsh/config must not depend on ${dependency}`,
      ).toBe(false)
    }
  })

  it('rejects new expected-failure exception control flow', () => {
    expect(exceptionSites('throw new Error("x")')).toEqual(['throw'])
    expect(exceptionSites('try { throw 1 } catch {}')).toEqual(['throw', 'try'])
    expect(exceptionSites('promise.catch(() => {})')).toEqual(['.catch'])
    expect(exceptionSites('Effect.catch(() => {})')).toEqual([])
    expect(exceptionSites('Effect.try({ try: () => 1, catch: () => 2 })')).toEqual([])
  })

  it('confines exception control flow to the documented allowlist', () => {
    expect(exceptionViolations()).toEqual([])
  })

  it('confines the TypeScript evaluation toolchain to @eedsh/cli', () => {
    for (const name of ['config', 'runtime'] as const) {
      expect(declaresToolchain(name), `@eedsh/${name} must not depend on tsx or typescript`).toBe(
        false,
      )
      expect(importsToolchain(name), `@eedsh/${name} must not import tsx or typescript`).toBe(false)
    }
    expect(manifest('cli').dependencies?.tsx, '@eedsh/cli must declare tsx').toBeDefined()
  })
})
