import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { resolveTypeScript } from '../src/check'
import { findTsconfigPath } from '../src/internal/tsconfig'

function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'eedsh-check-test-'))
}

describe('tsconfig discovery', () => {
  it('finds the nearest tsconfig at or above the config', async () => {
    const dir = await tempProject()
    const nested = join(dir, 'src', 'config')
    await mkdir(nested, { recursive: true })
    const tsconfigPath = join(dir, 'tsconfig.json')
    await writeFile(tsconfigPath, '{}\n')
    const configPath = join(nested, 'config.ts')
    await writeFile(configPath, 'export default {}\n')
    expect(findTsconfigPath(configPath)).toEqual(Option.some(tsconfigPath))
  })

  it('returns none when no tsconfig is found', async () => {
    const dir = await tempProject()
    const configPath = join(dir, 'config.ts')
    await writeFile(configPath, 'export default {}\n')
    expect(findTsconfigPath(configPath)).toEqual(Option.none())
  })
})

describe('TypeScript resolution', () => {
  it('resolves the project installation', async () => {
    const dir = await tempProject()
    const packageDir = join(dir, 'node_modules', 'typescript')
    await mkdir(join(packageDir, 'bin'), { recursive: true })
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({ version: '5.9.0', bin: { tsc: 'bin/tsc' } }),
    )
    await writeFile(join(packageDir, 'bin', 'tsc'), '')
    expect(resolveTypeScript(dir)).toEqual(
      Option.some({ version: '5.9.0', binPath: join(packageDir, 'bin', 'tsc') }),
    )
  })

  it('returns none when the project has no TypeScript', async () => {
    const dir = await tempProject()
    expect(resolveTypeScript(dir)).toEqual(Option.none())
  })
})
