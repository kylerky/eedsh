import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { readOptional } from '../../src/internal/read-optional'
import { memoryFileSystem } from '../support/fakes'

describe('readOptional', () => {
  it('returns the text of an existing file', async () => {
    const fs = memoryFileSystem({ '/profile/plan.json': '{"generation":"one"}' })
    const result = await Effect.runPromise(readOptional(fs.fs, '/profile/plan.json'))
    expect(result).toEqual(Option.some('{"generation":"one"}'))
  })

  it('returns none for a missing file', async () => {
    const fs = memoryFileSystem()
    const result = await Effect.runPromise(readOptional(fs.fs, '/profile/missing.json'))
    expect(result).toEqual(Option.none())
  })
})
