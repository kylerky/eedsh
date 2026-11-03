import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

describe('installation anchor documentation', () => {
  it('documents the first-sync bootstrap and the pnpm/npm boundary', () => {
    for (const path of ['README.md', 'packages/cli/README.md']) {
      const text = read(path)
      expect(text, path).toContain('installation.json')
      expect(text, path).toContain('dsh.launcher_unresolved')
      expect(text, path).toContain('pnpm')
      expect(text, path).toContain('npm')
      expect(text, path).toContain('cmd-shim-target')
      expect(text, path).toContain('--dsh')
      expect(text, path).toContain('EEDSH_DSH_ANCHOR')
    }
  })

  it('documents init --dsh and the anchor boundary', () => {
    for (const path of ['README.md', 'packages/cli/README.md']) {
      expect(read(path), path).toMatch(/eedsh init\s+\[--no-install\] \[--dsh <path>\]/)
    }
    expect(read('packages/cli/README.md')).toContain('## Installation anchor')
    expect(read('packages/cli/README.md')).toMatch(/never query/)
  })

  it('documents runtime anchor recording independently of HMR', () => {
    const runtime = read('packages/runtime/README.md')
    expect(runtime).toContain('installation.json')
    expect(runtime).toContain('whether or not HMR')
    expect(runtime).toContain('installation-anchor')
    expect(runtime).toContain('self-heal')
  })

  it('documents upgrade recovery and the archive order', () => {
    const text = read('README.md')
    expect(text).toContain('re-bootstraps')
    expect(text).toContain('runtime refreshes the anchor')
    expect(text).toContain('adopt-external-dsh')
    expect(text).toContain('no config or plan migration')
    expect(text).toContain('ignores')
    expect(text).toContain('`$DSH_HOME/.eedsh/installation.json`')
  })
})
