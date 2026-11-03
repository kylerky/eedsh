import { Effect, Layer } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { describe, expect, it } from 'vitest'
import { verifyProvisionedPackage } from '../../src/provision/verify'
import { failureOf } from '../support/effect'
import { memoryFileSystem } from '../support/fakes'

const name = '@scope/plugin'
const checkoutDir = '/dsh-home/.local/sources/plugin-abc'
const manifestPath = `${checkoutDir}/package.json`

function files(manifest: Record<string, unknown>, extra: Record<string, string> = {}) {
  return memoryFileSystem({
    [manifestPath]: JSON.stringify(manifest, null, 2),
    ...extra,
  })
}

function verify(fs: ReturnType<typeof memoryFileSystem>) {
  return verifyProvisionedPackage({ name, packageDir: checkoutDir }).pipe(
    Effect.provide(Layer.succeed(FileSystem.FileSystem, fs.fs)),
  )
}

const mainEntry = './lib/index.js'

describe('provisioned package verification', () => {
  it('accepts a package whose main and client entries exist', async () => {
    const fs = files(
      {
        name,
        main: mainEntry,
        exports: { '.': { default: mainEntry }, './client': { default: './lib/client.js' } },
        dsh: { client: { platform: 'web' } },
      },
      {
        [`${checkoutDir}/lib/index.js`]: 'export {}\n',
        [`${checkoutDir}/lib/client.js`]: 'export {}\n',
      },
    )
    await expect(Effect.runPromise(verify(fs))).resolves.toBeUndefined()
  })

  it('accepts the . export when the manifest declares no main', async () => {
    const fs = files(
      { name, exports: { '.': { import: mainEntry, default: mainEntry } } },
      { [`${checkoutDir}/lib/index.js`]: 'export {}\n' },
    )
    await expect(Effect.runPromise(verify(fs))).resolves.toBeUndefined()
  })

  it('fails when the main entry is missing and names the package and path', async () => {
    const fs = files({ name, main: mainEntry })
    const failure = await failureOf(verify(fs))

    expect(failure._tag).toBe('ProvisionFailure')
    expect(failure.code).toBe('provision.verify_failed')
    expect(failure.packageName).toBe(name)
    expect(failure.path).toBe(`${checkoutDir}/lib/index.js`)
    expect(failure.message).toContain(name)
    expect(failure.message).toContain(`${checkoutDir}/lib/index.js`)
  })

  it('fails when a declared helper is there but the client entry is missing', async () => {
    const fs = files(
      {
        name,
        main: mainEntry,
        exports: { '.': mainEntry, './client': { default: './lib/client.js' } },
        dsh: { client: { platform: 'web' } },
      },
      { [`${checkoutDir}/lib/index.js`]: 'export {}\n' },
    )
    const failure = await failureOf(verify(fs))

    expect(failure.code).toBe('provision.verify_failed')
    expect(failure.path).toBe(`${checkoutDir}/lib/client.js`)
    expect(failure.message).toContain(name)
    expect(failure.message).toContain('client')
  })

  it('fails when the manifest name differs and names both names', async () => {
    const fs = files(
      { name: '@other/plugin', main: mainEntry },
      {
        [`${checkoutDir}/lib/index.js`]: 'export {}\n',
      },
    )
    const failure = await failureOf(verify(fs))

    expect(failure.code).toBe('provision.verify_failed')
    expect(failure.path).toBe(manifestPath)
    expect(failure.message).toContain('@other/plugin')
    expect(failure.message).toContain(name)
  })
})
