import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decodeInstallationAnchor,
  encodeInstallationAnchor,
  installationAnchorPath,
  readInstallationAnchorFile,
  writeInstallationAnchorFile,
} from '../src/installation-anchor'

const root = process.cwd()

async function tempHome(): Promise<string> {
  await mkdir(join(root, '.tmp'), { recursive: true })
  return mkdtemp(join(root, '.tmp', 'anchor-'))
}

function installAnchorAt(home: string): string {
  return join(home, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
}

describe('installation anchor path', () => {
  it('places the record below the DSH home', () => {
    const home = join(root, '.tmp', 'home')
    expect(installationAnchorPath(home)).toBe(join(home, '.local', 'state', 'installation.json'))
  })
})

describe('installation anchor record', () => {
  it('encodes and decodes every recorded field', async () => {
    const home = await tempHome()
    const anchor = {
      format: 1,
      installAnchor: installAnchorAt(home),
      version: '0.2.1-rc.2',
      launcher: join(home, 'bin', 'dsh'),
      manager: 'pnpm' as const,
      recordedBy: 'sync',
      recordedAt: '2026-11-03T08:00:00.000Z',
    }
    const decoded = decodeInstallationAnchor(encodeInstallationAnchor(anchor))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.anchor).toEqual(anchor)
  })

  it('accepts the required fields without the optional provenance', async () => {
    const home = await tempHome()
    const record = { format: 1, installAnchor: installAnchorAt(home) }
    const decoded = decodeInstallationAnchor(JSON.stringify(record))
    expect(decoded).toEqual({ ok: true, anchor: record })
  })

  it('rejects a record with no installAnchor', () => {
    const decoded = decodeInstallationAnchor(JSON.stringify({ format: 1 }))
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.reason).toContain('installAnchor')
  })

  it('rejects a relative installAnchor', () => {
    const decoded = decodeInstallationAnchor(
      JSON.stringify({ format: 1, installAnchor: 'node_modules/@deepseek-ai/dsh/package.json' }),
    )
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.reason).toContain('installAnchor')
  })

  it('rejects an installAnchor that is not a package.json', async () => {
    const home = await tempHome()
    const decoded = decodeInstallationAnchor(
      JSON.stringify({ format: 1, installAnchor: join(home, 'dsh') }),
    )
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.reason).toContain('package.json')
  })

  it('rejects an unsupported format version', async () => {
    const home = await tempHome()
    const decoded = decodeInstallationAnchor(
      JSON.stringify({ format: 2, installAnchor: installAnchorAt(home) }),
    )
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.reason).toContain('format')
  })

  it('rejects malformed JSON and non-object records', () => {
    for (const text of ['{ not json', '[]', 'null', '"anchor"']) {
      const decoded = decodeInstallationAnchor(text)
      expect(decoded.ok, text).toBe(false)
    }
  })

  it('rejects malformed optional fields', async () => {
    const home = await tempHome()
    const installAnchor = installAnchorAt(home)
    for (const extra of [
      { version: 3 },
      { launcher: 'relative/dsh' },
      { manager: 'yarn' },
      { recordedBy: '' },
      { recordedAt: 7 },
    ]) {
      const decoded = decodeInstallationAnchor(
        JSON.stringify({ format: 1, installAnchor, ...extra }),
      )
      expect(decoded.ok, JSON.stringify(extra)).toBe(false)
    }
  })
})

describe('installation anchor file', () => {
  it('writes owner-only atomic JSON and reads it back', async () => {
    const home = await tempHome()
    const anchor = {
      format: 1,
      installAnchor: installAnchorAt(home),
      version: '0.2.1-rc.2',
      recordedBy: 'runtime',
    }
    await writeInstallationAnchorFile(home, anchor)
    const path = installationAnchorPath(home)
    const text = await readFile(path, 'utf8')
    expect(JSON.parse(text)).toEqual(anchor)
    expect(text.endsWith('\n')).toBe(true)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o077).toBe(0)

    const decoded = await readInstallationAnchorFile(home)
    expect(decoded).toEqual({ ok: true, anchor })
  })

  it('replaces a previous record', async () => {
    const home = await tempHome()
    await writeInstallationAnchorFile(home, {
      format: 1,
      installAnchor: installAnchorAt(home),
      version: '0.2.1-rc.2',
    })
    await writeInstallationAnchorFile(home, {
      format: 1,
      installAnchor: installAnchorAt(home),
      version: '0.2.1-rc.5',
    })
    const decoded = await readInstallationAnchorFile(home)
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.anchor.version).toBe('0.2.1-rc.5')
  })

  it('removes the retired record and its empty directory after a write', async () => {
    const home = await tempHome()
    await mkdir(join(home, '.eedsh'), { recursive: true })
    await writeFile(join(home, '.eedsh', 'installation.json'), '{}', 'utf8')

    await writeInstallationAnchorFile(home, {
      format: 1,
      installAnchor: installAnchorAt(home),
    })

    expect(existsSync(join(home, '.eedsh'))).toBe(false)
    expect(existsSync(installationAnchorPath(home))).toBe(true)
  })

  it('leaves a retired directory that holds other content', async () => {
    const home = await tempHome()
    await mkdir(join(home, '.eedsh'), { recursive: true })
    await writeFile(join(home, '.eedsh', 'installation.json'), '{}', 'utf8')
    await writeFile(join(home, '.eedsh', 'keep.txt'), 'keep', 'utf8')

    await writeInstallationAnchorFile(home, {
      format: 1,
      installAnchor: installAnchorAt(home),
    })

    expect(existsSync(join(home, '.eedsh', 'installation.json'))).toBe(false)
    expect(await readFile(join(home, '.eedsh', 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('reports a missing or malformed record instead of throwing', async () => {
    const home = await tempHome()
    const missing = await readInstallationAnchorFile(home)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toContain('installation.json')

    await mkdir(join(home, '.local', 'state'), { recursive: true })
    await writeFile(installationAnchorPath(home), '{ nope', 'utf8')
    const malformed = await readInstallationAnchorFile(home)
    expect(malformed.ok).toBe(false)
  })
})
