/**
 * The pure, chain-aware completion engine. It recognizes shell commands and
 * their arguments, the typed authoring chain, and the argument slots that take
 * profile, bundle, row, preset, or package names. It is shell-agnostic: the
 * prompt adapter supplies the line up to the cursor and renders the result.
 * @module @eedsh/cli/repl/completion
 */

/** The shell commands the session knows, in help order. */
export const COMMAND_NAMES = [
  '.help',
  '.profile',
  '.reload',
  '.resolve',
  '.sync',
  '.clear',
  '.exit',
] as const

/** One resolution root a chain establishes. */
export interface CompletionRoot {
  /** A profile name under the shared DSH home. */
  readonly profile?: string
  /** A package directory, absolute or relative to the config file. */
  readonly packageDir?: string
}

/** The domain data completion may consult. Every resolver may fail silently. */
export interface CompletionCatalogs {
  /** Shell command names. */
  readonly commands: readonly string[]
  /** Declared profile names. */
  readonly profiles: readonly string[]
  /** Authored, installed, pinned, and preview bundle names. */
  readonly bundles: readonly string[]
  /** Declared package names. */
  readonly packages: readonly string[]
  /** Resolve a bundle's row ids under one root. */
  readonly rows: (bundle: string, root: CompletionRoot) => readonly string[]
  /** Resolve a bundle's preset ids under one root. */
  readonly presets: (bundle: string, root: CompletionRoot) => readonly string[]
}

/** One completion request. */
export interface CompletionRequest {
  /** The full line; only the text before `cursor` is inspected. */
  readonly line: string
  /** The cursor position, in UTF-16 code units. */
  readonly cursor: number
  /** The domain catalogs for this evaluation. */
  readonly catalogs: CompletionCatalogs
}

/** The token start and the matching hits, or no hits. */
export interface CompletionResult {
  /** The index where the completed token starts. */
  readonly start: number
  /** The matching completions, already carrying a quote when one was typed. */
  readonly hits: readonly string[]
}

type MethodKind = 'bundle' | 'bundle-query' | 'row' | 'preset' | 'config' | 'profile' | 'plan'

const METHODS: Record<MethodKind, readonly string[]> = {
  bundle: [
    'fromPackageDir',
    'fromProfile',
    'origin',
    'packageDir',
    'preset',
    'presets',
    'row',
    'rows',
    'toJSON',
    'version',
  ],
  'bundle-query': ['origin', 'packageDir', 'preset', 'presets', 'row', 'rows', 'version'],
  row: ['bundle', 'data', 'disable', 'enable', 'id', 'override', 'toJSON'],
  preset: [
    'bundle',
    'data',
    'disable',
    'disabled',
    'enable',
    'id',
    'name',
    'order',
    'override',
    'rowId',
    'toJSON',
  ],
  config: ['defaultProfile', 'dsh', 'profile', 'profiles'],
  profile: ['bundles', 'error', 'layers', 'name', 'plan', 'result', 'valid'],
  plan: ['bundles', 'dsh', 'format', 'layers', 'packages', 'profile', 'version'],
}

const SYNC_VALUES = ['on', 'off'] as const

const PROTOTYPE_NOISE = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
])

/**
 * Filter a generic completer's hits for obvious prototype noise and duplicates.
 * @param hits - the completer's raw hits.
 * @returns the filtered hits in their original order.
 */
export function filterCompletionHits(hits: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const hit of hits) {
    const name = hit.trim()
    if (name === '' || PROTOTYPE_NOISE.has(name) || name.startsWith('__')) continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push(hit)
  }
  return out
}

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_$@/-]/.test(char)
}

/** The open string at the end of the text, when the cursor is inside one. */
function openString(before: string): { readonly start: number; readonly quote: string } | undefined {
  let quote: string | undefined
  let start = -1
  for (let index = 0; index < before.length; index += 1) {
    const char = before[index] as string
    if (quote === undefined) {
      if (char === "'" || char === '"' || char === '`') {
        quote = char
        start = index
      }
    } else if (char === quote && before[index - 1] !== '\\') {
      quote = undefined
      start = -1
    }
  }
  return quote === undefined || start < 0 ? undefined : { start, quote }
}

/** The start of the trailing unquoted word. */
function wordStart(before: string): number {
  let index = before.length
  while (index > 0) {
    const char = before[index - 1] as string
    if (!isWordChar(char)) break
    index -= 1
  }
  return index
}

function stripQuotes(value: string): string {
  const first = value[0]
  if (first !== "'" && first !== '"' && first !== '`') return value
  const last = value[value.length - 1]
  return last === first ? value.slice(1, -1) : value.slice(1)
}

function safeNames(resolve: () => readonly string[]): readonly string[] {
  try {
    return resolve()
  } catch {
    return []
  }
}

interface ChainInfo {
  readonly kind: MethodKind | undefined
  readonly rooted: boolean
  readonly root: CompletionRoot
  readonly bundle: string
}

const EMPTY_CHAIN: ChainInfo = { kind: undefined, rooted: false, root: {}, bundle: '' }

/** Read the typed receiver at the end of a completed chain. */
function chainInfo(text: string): ChainInfo {
  const trimmed = text.trim()
  if (trimmed === '') return EMPTY_CHAIN
  const base = /^([A-Za-z_$][\w$]*)/.exec(trimmed)?.[1]
  let kind: MethodKind | undefined
  if (base === 'bundle') kind = 'bundle'
  else if (base === 'config') kind = 'config'
  else if (base === 'selectedProfile') kind = 'profile'
  else if (base === 'plan') kind = 'plan'
  let rooted = false
  let root: CompletionRoot = {}
  let bundle = ''
  const calls = /([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/g
  for (const match of trimmed.matchAll(calls)) {
    const name = match[1]
    const argument = stripQuotes((match[2] ?? '').trim())
    if (name === 'bundle') {
      if (argument !== '') bundle = argument
      kind = 'bundle'
      rooted = false
      root = {}
    } else if (name === 'fromProfile') {
      kind = 'bundle-query'
      rooted = true
      root = argument === '' ? {} : { profile: argument }
    } else if (name === 'fromPackageDir') {
      kind = 'bundle-query'
      rooted = true
      root = argument === '' ? {} : { packageDir: argument }
    } else if (name === 'row') {
      kind = 'row'
    } else if (name === 'preset') {
      kind = 'preset'
    } else if (name === 'rows' || name === 'presets' || name === 'bundles' || name === 'layers') {
      kind = undefined
    } else if (name === 'profile') {
      kind = 'profile'
    } else if (name === 'plan') {
      kind = 'plan'
    }
  }
  return { kind, rooted, root, bundle }
}

function quotedHits(names: readonly string[], token: string): string[] {
  const quote = token[0] === "'" || token[0] === '"' || token[0] === '`' ? token[0] : undefined
  const hits = names.map((name) => (quote === undefined ? name : `${quote}${name}${quote}`))
  return hits.filter((hit) => hit.startsWith(token))
}

function methodHits(info: ChainInfo, token: string): string[] {
  if (info.kind === undefined) return []
  const methods =
    info.kind === 'bundle' && info.rooted ? METHODS['bundle-query'] : METHODS[info.kind]
  return methods.filter((method) => method.startsWith(token))
}

/** Complete an argument slot, or return undefined when the slot has no catalog. */
function argumentCompletion(
  before: string,
  start: number,
  token: string,
  catalogs: CompletionCatalogs,
): CompletionResult | undefined {
  const prefix = before.slice(0, start)
  const bracket = /plan\s*\.\s*packages\s*\[\s*$/.exec(prefix)
  if (bracket !== null) {
    return {
      start,
      hits: quotedHits(
        safeNames(() => catalogs.packages),
        token,
      ),
    }
  }
  const open = /([A-Za-z_$][\w$]*)\s*\(\s*$/.exec(prefix)
  if (open === null) return undefined
  const callee = open[1] as string
  const chainText = prefix.slice(0, open.index)
  const info = chainInfo(chainText)
  switch (callee) {
    case 'bundle':
      return {
        start,
        hits: quotedHits(
          safeNames(() => catalogs.bundles),
          token,
        ),
      }
    case 'fromProfile':
      return {
        start,
        hits: quotedHits(
          safeNames(() => catalogs.profiles),
          token,
        ),
      }
    case 'profile':
      return info.kind === 'config' || chainText.trim() === 'config.'
        ? {
            start,
            hits: quotedHits(
              safeNames(() => catalogs.profiles),
              token,
            ),
          }
        : undefined
    case 'row':
      return {
        start,
        hits: quotedHits(
          safeNames(() => catalogs.rows(info.bundle, info.root)),
          token,
        ),
      }
    case 'preset':
      return {
        start,
        hits: quotedHits(
          safeNames(() => catalogs.presets(info.bundle, info.root)),
          token,
        ),
      }
    default:
      return undefined
  }
}

function commandCompletion(
  before: string,
  catalogs: CompletionCatalogs,
): CompletionResult | undefined {
  if (before.trim() === '') {
    return { start: 0, hits: [...safeNames(() => catalogs.commands)] }
  }
  const trimmed = before.trimStart()
  if (!trimmed.startsWith('.')) return undefined
  const whole = /^\s*(\.[^\s]*)$/.exec(before)
  if (whole !== null) {
    const token = whole[1] as string
    return {
      start: before.length - token.length,
      hits: safeNames(() => catalogs.commands).filter((command) => command.startsWith(token)),
    }
  }
  const sync = /^\s*\.sync\s+(\S*)$/.exec(before)
  if (sync !== null) {
    const token = sync[1] as string
    return {
      start: before.length - token.length,
      hits: SYNC_VALUES.filter((value) => value.startsWith(token)),
    }
  }
  const profile = /^\s*\.profile\s+(\S*)$/.exec(before)
  if (profile !== null) {
    const token = profile[1] as string
    return {
      start: before.length - token.length,
      hits: safeNames(() => catalogs.profiles).filter((name) => name.startsWith(token)),
    }
  }
  return { start: wordStart(before), hits: [] }
}

/**
 * Compute completions for the text before the cursor. The walk never throws:
 * a failing catalog contributes no hits, and an unrecognized expression yields
 * an empty result so the prompt can fall back to JavaScript completion.
 * @param request - the line, cursor, and domain catalogs.
 * @returns the token start and matching hits.
 */
export function complete(request: CompletionRequest): CompletionResult {
  try {
    const before = request.line.slice(0, request.cursor)
    const command = commandCompletion(before, request.catalogs)
    if (command !== undefined) return command
    const string = openString(before)
    if (string !== undefined) {
      const token = before.slice(string.start)
      return (
        argumentCompletion(before, string.start, token, request.catalogs) ?? {
          start: string.start,
          hits: [],
        }
      )
    }
    const start = wordStart(before)
    const token = before.slice(start)
    if (start > 0 && before[start - 1] === '.') {
      const info = chainInfo(before.slice(0, start - 1))
      return { start, hits: methodHits(info, token) }
    }
    const argument = argumentCompletion(before, start, token, request.catalogs)
    if (argument !== undefined) return argument
    return { start, hits: [] }
  } catch {
    return { start: request.cursor, hits: [] }
  }
}
