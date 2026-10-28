import { completeShellLine } from '../../src/repl/prompt'
import { describe, expect, it } from 'vitest'

describe('readline completion adapter', () => {
  it('returns domain hits with the token to replace', async () => {
    const session = {
      complete: async () => ({ start: 12, hits: ['row', 'rows'] }),
      completeGeneric: async (): Promise<readonly [string[], string]> => [[], ''],
    }
    expect(await completeShellLine(session, "bundle('x').ro")).toEqual([['row', 'rows'], 'ro'])
  })

  it('falls back to the evaluator when the domain engine has no hits', async () => {
    let calls = 0
    const session = {
      complete: async () => ({ start: 0, hits: [] }),
      completeGeneric: async (): Promise<readonly [string[], string]> => {
        calls += 1
        return [['value'], 'val']
      },
    }
    expect(await completeShellLine(session, 'val')).toEqual([['value'], 'val'])
    expect(calls).toBe(1)
  })

  it('contains a failing completion without ending the session', async () => {
    const session = {
      complete: async (): Promise<{ start: number; hits: string[] }> => {
        throw new Error('completion broke')
      },
      completeGeneric: async (): Promise<readonly [string[], string]> => [[], ''],
    }
    expect(await completeShellLine(session, 'x')).toEqual([[], 'x'])
  })

  it('falls back when a quoted token has no matching names', async () => {
    let calls = 0
    const session = {
      complete: async () => ({ start: 7, hits: [] }),
      completeGeneric: async (): Promise<readonly [string[], string]> => {
        calls += 1
        return [[], '']
      },
    }
    expect(await completeShellLine(session, "bundle('")).toEqual([[], ''])
    expect(calls).toBe(1)
  })
})
