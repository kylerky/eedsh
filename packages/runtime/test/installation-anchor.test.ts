import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as anchorModule from '../src/installation-anchor'
import {
  encodeInstallationAnchor,
  installationAnchorPath,
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
  it('encodes every recorded field as pretty JSON with a trailing newline', async () => {
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
    const text = encodeInstallationAnchor(anchor)
    expect(JSON.parse(text)).toEqual(anchor)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('omits absent provenance fields', async () => {
    const home = await tempHome()
    const anchor = { format: 1, installAnchor: installAnchorAt(home) }
    expect(JSON.parse(encodeInstallationAnchor(anchor))).toEqual(anchor)
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
    const text = await readFile(installationAnchorPath(home), 'utf8')
    expect(JSON.parse(text).version).toBe('0.2.1-rc.5')
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
})

describe('installation anchor module surface', () => {
  it('exports no read-side codec', () => {
    for (const name of [
      'decodeInstallationAnchor',
      'validateInstallationAnchorValue',
      'readInstallationAnchorFile',
    ]) {
      expect(name in anchorModule, name).toBe(false)
    }
  })
})
