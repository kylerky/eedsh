import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Option } from 'effect'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  findConfigPath,
  findUnsupportedConfigPath,
  unsupportedConfigExtensionError,
  validateConfigPath,
} from '../src/config'

describe('config path validation', () => {
  it('accepts a supported TypeScript config path', () => {
    const result = validateConfigPath('/work/eedsh.config.ts')
    expect(Result.isSuccess(result)).toBe(true)
  })

  it('returns a tagged failure for a JavaScript config path', () => {
    const result = validateConfigPath('/work/eedsh.config.js')
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(Error)
      expect(result.failure._tag).toBe('ConfigError')
      expect(result.failure.code).toBe('config.unsupported_extension')
    }
  })

  it('builds tagged config failures', () => {
    const error = unsupportedConfigExtensionError('/work/eedsh.config.js')
    expect(error).toBeInstanceOf(ConfigError)
    expect(error._tag).toBe('ConfigError')
    expect(error.code).toBe('config.unsupported_extension')
    expect(error.message).toContain('eedsh.config.ts')
  })
})

describe('config discovery', () => {
  it('finds the first supported TypeScript config in a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eedsh-config-'))
    const path = join(dir, 'eedsh.config.ts')
    await writeFile(path, 'export default {}\n')
    expect(findConfigPath(dir)).toEqual(Option.some(path))
  })

  it('returns none when the directory has no supported config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eedsh-config-'))
    await writeFile(join(dir, 'eedsh.config.js'), 'export default {}\n')
    expect(findConfigPath(dir)).toEqual(Option.none())
  })

  it('finds a JavaScript config that discovery rejects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eedsh-config-'))
    const path = join(dir, 'eedsh.config.js')
    await writeFile(path, 'export default {}\n')
    expect(findUnsupportedConfigPath(dir)).toEqual(Option.some(path))
  })

  it('returns none when only supported configs exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eedsh-config-'))
    await writeFile(join(dir, 'eedsh.config.ts'), 'export default {}\n')
    expect(findUnsupportedConfigPath(dir)).toEqual(Option.none())
  })
})
