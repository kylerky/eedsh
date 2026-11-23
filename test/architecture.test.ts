import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const packages = ['plan', 'config', 'cli', 'runtime'] as const

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
 * The single exception boundary. Authoring is synchronous and reports misuse
 * only as a defect, so one module constructs that exception; every other
 * production site reports an expected failure as a `Result` value or through
 * the Effect error channel. The config loader is the single entry safety net
 * that turns a thrown authoring defect into an Effect defect. No file is
 * exempt from the scan by name.
 */
const AUTHORING_DEFECT_BOUNDARY = 'packages/config/src/defect.ts'

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
      const sites = exceptionSites(readFileSync(file, 'utf8')).filter(
        (site) => relativePath !== AUTHORING_DEFECT_BOUNDARY || site !== 'throw',
      )
      if (sites.length > 0) violations.push({ file: relativePath, sites })
    }
  }
  return violations
}

/** Every production file that contains a literal `throw` keyword. */
function throwFiles(): string[] {
  const files: string[] = []
  for (const name of ['config', 'cli'] as const) {
    for (const file of sourceFiles(join(root, 'packages', name, 'src'))) {
      if (/\bthrow\b/.test(readFileSync(file, 'utf8'))) {
        files.push(relative(root, file).replaceAll('\\', '/'))
      }
    }
  }
  return files
}

/** Production dependencies a published package may not declare. */
const FORBIDDEN_DSH_DEPENDENCY = (dependency: string): boolean =>
  dependency.startsWith('@deepseek-ai/dsh') || dependency === '@deepseek-ai/cordis-plugin-include'

const TOOLCHAIN_PACKAGES = ['tsx', 'typescript']

/** Packages that must share one exact Effect version. */
const EFFECT_PACKAGES = ['plan', 'config', 'cli'] as const

/** The exact Effect version every consumer pins. */
const EFFECT_VERSION = '4.0.6'

/** The only Effect modules the plan and authoring packages may import. */
const ALLOWED_EFFECT_MODULES = ['effect/Schema', 'effect/Result']

/** Effect-free DSH helpers the authoring package may import. */
const ALLOWED_DSH_HELPERS = ['@deepseek-ai/dsh-app-boot']

/** Source imports that match a predicate, rendered as `path: specifier`. */
function offendingImports(name: PackageName, predicate: (specifier: string) => boolean): string[] {
  return sourceImports(name)
    .filter(({ specifier }) => predicate(specifier))
    .map(({ file, specifier }) => `${relative(root, file).replaceAll('\\', '/')}: ${specifier}`)
}

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

  it('pins one exact Effect version across plan, config, and cli', () => {
    for (const name of EFFECT_PACKAGES) {
      const declared = [
        manifest(name).dependencies?.effect,
        manifest(name).devDependencies?.effect,
        manifest(name).peerDependencies?.effect,
      ].filter((version): version is string => typeof version === 'string')
      expect(declared.length, `@eedsh/${name} must declare effect`).toBeGreaterThan(0)
      for (const version of declared) {
        expect(version, `@eedsh/${name} must pin effect exactly`).toBe(EFFECT_VERSION)
      }
    }
    const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
    const resolved = new Set(
      [...lockfile.matchAll(/^ {2}effect@([0-9][^:\s(]*):/gm)].map((match) => match[1]),
    )
    expect([...resolved], 'the workspace must resolve exactly one Effect version').toEqual([
      EFFECT_VERSION,
    ])
  })

  it('limits @eedsh/plan to the schema and result modules', () => {
    const offenders = offendingImports(
      'plan',
      (specifier) =>
        (specifier === 'effect' || specifier.startsWith('effect/')) &&
        !ALLOWED_EFFECT_MODULES.includes(specifier),
    )
    expect(offenders, '@eedsh/plan may import only effect/Schema and effect/Result').toEqual([])
  })

  it('keeps Node builtins out of @eedsh/plan', () => {
    const offenders = offendingImports('plan', (specifier) => specifier.startsWith('node:'))
    expect(offenders, '@eedsh/plan must stay usable without Node builtins').toEqual([])
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

  it('exposes the typed authoring surface without the legacy free helpers', async () => {
    const config = (await import('@eedsh/config')) as Record<string, unknown>
    for (const symbol of [
      'rows',
      'presets',
      'row',
      'defineProfile',
      'insert',
      'disable',
      'enable',
      'override',
      'layer',
      'raw',
    ]) {
      expect(symbol in config, `@eedsh/config must not export ${symbol}`).toBe(false)
    }
    for (const symbol of ['defineConfig', 'bundle', 'js', 'group']) {
      expect(typeof config[symbol], `@eedsh/config must export ${symbol}`).toBe('function')
    }
  })

  it('keeps IO and module loading out of @eedsh/config', () => {
    const forbidden = [
      'node:fs',
      'node:fs/promises',
      'node:module',
      'node:child_process',
      'node:readline',
      'node:repl',
      'tsx',
      'typescript',
    ]
    const offenders = offendingImports(
      'config',
      (specifier) =>
        forbidden.includes(specifier) || forbidden.some((name) => specifier.startsWith(`${name}/`)),
    )
    expect(offenders, '@eedsh/config must stay pure and must not load modules or touch IO').toEqual(
      [],
    )
  })

  it('exports no ambient bridge or version state', async () => {
    const config = (await import('@eedsh/config')) as Record<string, unknown>
    for (const symbol of [
      'activeDshBridge',
      'installDshBridge',
      'clearDshBridge',
      'DSH_BRIDGE_KEY',
      'bridgeCapability',
      'dshVersion',
      'resolutionTrace',
      'takeResolutionTrace',
      'clearResolutionTrace',
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

  it('limits the authoring package to the schema and result Effect modules', () => {
    const offenders = offendingImports(
      'config',
      (specifier) =>
        (specifier === 'effect' || specifier.startsWith('effect/')) &&
        !ALLOWED_EFFECT_MODULES.includes(specifier),
    )
    expect(offenders, '@eedsh/config may import only effect/Schema and effect/Result').toEqual([])
  })

  it('limits authoring DSH imports to Effect-free helpers', () => {
    const offenders = offendingImports(
      'config',
      (specifier) =>
        specifier.startsWith('@deepseek-ai/') && !ALLOWED_DSH_HELPERS.includes(specifier),
    )
    expect(offenders, '@eedsh/config may import only Effect-free DSH helpers').toEqual([])
    for (const dependency of dependencyNames('config')) {
      if (!dependency.startsWith('@deepseek-ai/')) continue
      expect(ALLOWED_DSH_HELPERS, `@eedsh/config must not depend on ${dependency}`).toContain(
        dependency,
      )
    }
  })

  it('rejects new expected-failure exception control flow', () => {
    expect(exceptionSites('throw new Error("x")')).toEqual(['throw'])
    expect(exceptionSites('try { throw 1 } catch {}')).toEqual(['throw', 'try'])
    expect(exceptionSites('promise.catch(() => {})')).toEqual(['.catch'])
    expect(exceptionSites('Effect.catch(() => {})')).toEqual([])
    expect(exceptionSites('Effect.try({ try: () => 1, catch: () => 2 })')).toEqual([])
  })

  it('declares no production DSH dependency in the published CLI or authoring package', () => {
    for (const name of ['cli', 'config'] as const) {
      const production = Object.keys(manifest(name).dependencies ?? {})
      expect(
        production.filter(FORBIDDEN_DSH_DEPENDENCY),
        `@eedsh/${name} must not depend on a DSH package in production`,
      ).toEqual([])
    }
  })

  it('contains no static DSH import in published sources', () => {
    const offenders = ['cli', 'config'].flatMap((name) =>
      offendingImports(name as PackageName, FORBIDDEN_DSH_DEPENDENCY),
    )
    expect(offenders, 'published sources must not statically import DSH').toEqual([])
  })

  it('publishes no DSH engine gate on generated or runtime bundles', () => {
    const runtime = manifest('runtime')
    expect(runtime.engines?.dsh, '@eedsh/runtime must not declare engines.dsh').toBeUndefined()
    expect(runtime.engines?.node, '@eedsh/runtime must keep engines.node').toBeDefined()
    const generated = readFileSync(
      join(root, 'packages/cli/src/materialize/generated-bundle.ts'),
      'utf8',
    )
    expect(generated, 'the generated manifest must not build an engines field').not.toMatch(
      /\bengines\b/,
    )
  })

  it('has no version-1 plan reader', () => {
    const constants = readFileSync(join(root, 'packages/plan/src/constants.ts'), 'utf8')
    expect(constants).toContain('PLAN_VERSION = 2')
    for (const file of sourceFiles(join(root, 'packages/plan/src'))) {
      expect(readFileSync(file, 'utf8'), `${file} must not accept version 1`).not.toMatch(
        /version:\s*1\b/,
      )
    }
  })

  it('confines exception control flow to the single authoring defect boundary', () => {
    expect(exceptionViolations()).toEqual([])
  })

  it('keeps the single entry safety net in the config loader', () => {
    expect(throwFiles()).toEqual([AUTHORING_DEFECT_BOUNDARY])
    const loader = readFileSync(join(root, 'packages/cli/src/config.ts'), 'utf8')
    expect(
      loader,
      'the config loader converts a thrown authoring defect into an Effect defect',
    ).toMatch(/Effect\.die\(/)
    const boundary = readFileSync(join(root, AUTHORING_DEFECT_BOUNDARY), 'utf8')
    expect(boundary, 'the boundary exports the one defect constructor').toMatch(
      /export function defect\(/,
    )
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
/** Production files that must locate DSH without asking a package manager. */
const QUERY_FREE_FILES = [
  'packages/cli/src/dsh-discovery.ts',
  'packages/cli/src/doctor.ts',
  'packages/cli/src/repl/session.ts',
  'packages/cli/src/repl/prompt.ts',
  'packages/cli/src/repl/views.ts',
  'packages/cli/src/repl/preview.ts',
  'packages/cli/src/repl/completion.ts',
  'packages/cli/src/repl/diff.ts',
]

const PACKAGE_MANAGER_QUERY = /pnpm\s+list|npm\s+root|cmd-shim-target/
const PROCESS_LAUNCH = /child_process|spawnSync|execFileSync/

const PNPM_QUERY = /['"]pnpm['"]\s*,\s*\[\s*['"]list['"]/
const NPM_QUERY = /['"]npm['"]\s*,\s*\[\s*['"]root['"]/

describe('installation anchor boundaries', () => {
  it('keeps package-manager queries out of discovery, doctor, and repl', () => {
    for (const file of QUERY_FREE_FILES) {
      const text = readFileSync(join(root, file), 'utf8')
      expect(text, `${file} must not query a package manager or parse a shim`).not.toMatch(
        PACKAGE_MANAGER_QUERY,
      )
    }
    for (const file of ['packages/cli/src/dsh-discovery.ts', 'packages/cli/src/doctor.ts']) {
      expect(
        readFileSync(join(root, file), 'utf8'),
        `${file} must not launch external commands`,
      ).not.toMatch(PROCESS_LAUNCH)
    }
  })

  it('imports the bootstrap only from the setup command path', () => {
    const importers = sourceImports('cli')
      .filter(({ specifier }) => /(^|\/)dsh-bootstrap$/.test(specifier))
      .map(({ file }) => relative(root, file).replaceAll('\\', '/'))
    // `services.ts` names the discovery service's bootstrap method; the live
    // layer is the composition root that wires the bootstrap implementation.
    expect(importers, 'only the setup path may import the bootstrap').toEqual([
      'packages/cli/src/internal/effect/layer.ts',
      'packages/cli/src/internal/effect/services.ts',
    ])
  })

  it('imports the command runner only from discovery and the setup paths', () => {
    const importers = sourceImports('cli')
      .filter(({ specifier }) => specifier.endsWith('/command-runner'))
      .map(({ file }) => relative(root, file).replaceAll('\\', '/'))
      .sort()
    // Discovery and bootstrap hold the runner seam; the services module names
    // its type. The live layer binds the runner to the child-process spawner,
    // and the repl preview uses the shared invocation helper.
    expect(importers).toEqual([
      'packages/cli/src/dsh-bootstrap.ts',
      'packages/cli/src/dsh-discovery.ts',
      'packages/cli/src/internal/effect/layer.ts',
      'packages/cli/src/internal/effect/services.ts',
      'packages/cli/src/repl/preview.ts',
    ])
  })

  it('keeps the pnpm and npm metadata commands in the bootstrap module', () => {
    const querySources = sourceFiles(join(root, 'packages/cli/src')).filter((file) => {
      const text = readFileSync(file, 'utf8')
      return PNPM_QUERY.test(text) || NPM_QUERY.test(text)
    })
    expect(
      querySources.map((file) => relative(root, file).replaceAll('\\', '/')),
      'only the bootstrap may ask pnpm or npm for metadata',
    ).toEqual(['packages/cli/src/dsh-bootstrap.ts'])
  })

  it('has no cmd-shim-target parser in production sources', () => {
    for (const name of packages) {
      for (const file of sourceFiles(join(root, 'packages', name, 'src'))) {
        expect(readFileSync(file, 'utf8'), `${file} must not parse a shim`).not.toMatch(
          /cmd-shim-target/,
        )
      }
    }
  })

  it('keeps the installation anchor outside the config project', async () => {
    const { installationAnchorPathForEnv } = await import('../packages/cli/src/installation-anchor')
    const path = installationAnchorPathForEnv({
      DSH_HOME: '/dsh-home',
      XDG_CONFIG_HOME: '/xdg-config',
    })
    expect(path).toBe(join(resolve('/dsh-home'), '.local', 'state', 'installation.json'))
    expect(path.startsWith(resolve('/xdg-config'))).toBe(false)

    const source = readFileSync(join(root, 'packages/cli/src/installation-anchor.ts'), 'utf8')
    expect(source, 'the anchor helper must not read the config project location').not.toMatch(
      /config-path|XDG_CONFIG_HOME|configDirectory/,
    )
  })
})

/**
 * The platform adapters that implement a service by calling Node IO directly.
 * Every other module reaches these capabilities through a provided service.
 */
const CLI_PLATFORM_ADAPTERS = new Set([
  'packages/cli/src/spawn.ts',
  'packages/cli/src/internal/lock-posix.ts',
  'packages/cli/src/internal/lock-win32.ts',
])

/** Node IO modules no command may import directly. */
const CLI_NODE_IO_MODULES = new Set([
  'node:fs',
  'node:fs/promises',
  'node:child_process',
  'node:readline',
  'node:repl',
])

/** Effect runtime entry points only the process entry may call. */
const RUNTIME_START =
  /\bEffect\.run(?:Promise|PromiseExit|Sync|SyncExit|SyncEither|Fork|Callback)\b|\bManagedRuntime\b|\bRuntime\.make\b/

/** Function type names imported from other modules that no input may carry. */
const CALLABLE_TYPE_NAMES = new Set(['CommandRunnerShape', 'ComposePlan', 'SyncPlan'])

/** The body of every `interface <Name> { ... }` declaration. */
function interfaceBodies(text: string): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = []
  for (const match of text.matchAll(/(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\s*\{/g)) {
    const open = (match.index ?? 0) + match[0].length - 1
    let depth = 0
    let close = -1
    for (let index = open; index < text.length; index += 1) {
      if (text[index] === '{') depth += 1
      else if (text[index] === '}') {
        depth -= 1
        if (depth === 0) {
          close = index
          break
        }
      }
    }
    if (close !== -1) found.push({ name: match[1] as string, body: text.slice(open + 1, close) })
  }
  return found
}

/** Callable type aliases declared in one source text. */
function callableAliases(text: string): Set<string> {
  const aliases = new Set<string>()
  for (const match of text.matchAll(
    /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?)(?=\n(?:export\s+)?(?:type|interface|const|function|class)\b|\n\s*$)/g,
  )) {
    if ((match[2] as string).includes('=>')) aliases.add(match[1] as string)
  }
  return aliases
}

/**
 * Optional function-typed properties on an invocation input. The check finds
 * direct function types and aliases declared locally or imported from the
 * services module, so a capability hidden behind a named type is still found.
 */
function callableOptionProperties(): string[] {
  const violations: string[] = []
  for (const name of ['cli', 'config'] as const) {
    for (const file of sourceFiles(join(root, 'packages', name, 'src'))) {
      const text = readFileSync(file, 'utf8')
      const aliases = callableAliases(text)
      for (const block of interfaceBodies(text)) {
        if (!block.name.endsWith('Options') && !block.name.endsWith('Input')) continue
        for (const match of block.body.matchAll(
          /(?:^|\n)\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\?\s*:\s*([\s\S]*?)(?=\n\s*(?:readonly\s+)?[A-Za-z_$][\w$]*\??\s*:|\n\s*$)/g,
        )) {
          const type = (match[2] as string).replace(/\s+/g, ' ').trim()
          const base = type.replace(/\s*\|\s*undefined$/, '').trim()
          const simple = base.replace(/<.*$/, '').trim()
          if (base.includes('=>') || aliases.has(simple) || CALLABLE_TYPE_NAMES.has(simple)) {
            violations.push(relative(root, file) + ': ' + String(match[1]))
          }
        }
      }
    }
  }
  return violations.sort()
}

describe('effect-native enforcement', () => {
  it('keeps Node IO imports inside the CLI platform adapters', () => {
    const violations = sourceImports('cli')
      .filter(
        ({ file, specifier }) =>
          CLI_NODE_IO_MODULES.has(specifier) &&
          !CLI_PLATFORM_ADAPTERS.has(relative(root, file).replaceAll('\\', '/')),
      )
      .map(({ file, specifier }) => `${relative(root, file).replaceAll('\\', '/')}: ${specifier}`)
    expect(violations, 'Node IO must be reached through a provided service').toEqual([])
  })

  it('starts the Effect runtime only in the process entry point', () => {
    const violations = sourceFiles(join(root, 'packages/cli/src'))
      .map((file) => relative(root, file).replaceAll('\\', '/'))
      .filter((file) => file !== 'packages/cli/src/bin.ts')
      .filter((file) => RUNTIME_START.test(readFileSync(join(root, file), 'utf8')))
    expect(violations, 'only bin.ts may start a runtime').toEqual([])
  })

  it('receives no optional callable capability on an invocation input', () => {
    expect(
      callableOptionProperties(),
      'an invocation input must not carry an optional capability',
    ).toEqual([])
  })
})
