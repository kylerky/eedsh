/**
 * The pure completion adapter around a session: domain hits, the evaluator
 * fallback, and contained failures. The TTY editor that consumes it is
 * covered by tty-input.test.ts.
 */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { completeShellLine } from '../../src/repl/prompt'

describe('shell completion adapter', () => {
  it('returns domain hits with the token to replace', async () => {
    const session = {
      complete: () => Effect.succeed({ start: 12, hits: ['row', 'rows'] }),
      completeGeneric: () => Effect.succeed([[], ''] as const),
    }
    expect(await Effect.runPromise(completeShellLine(session, "bundle('x').ro"))).toEqual([
      ['row', 'rows'],
      'ro',
    ])
  })

  it('falls back to the evaluator when the domain engine has no hits', async () => {
    let calls = 0
    const session = {
      complete: () => Effect.succeed({ start: 0, hits: [] }),
      completeGeneric: () => {
        calls += 1
        return Effect.succeed([['value'], 'val'] as const)
      },
    }
    expect(await Effect.runPromise(completeShellLine(session, 'val'))).toEqual([['value'], 'val'])
    expect(calls).toBe(1)
  })

  it('contains a failing completion without ending the session', async () => {
    const session = {
      complete: () => Effect.fail(new Error('completion broke')),
      completeGeneric: () => Effect.succeed([[], ''] as const),
    }
    expect(await Effect.runPromise(completeShellLine(session, 'x'))).toEqual([[], 'x'])
  })

  it('falls back when a quoted token has no matching names', async () => {
    let calls = 0
    const session = {
      complete: () => Effect.succeed({ start: 7, hits: [] }),
      completeGeneric: () => {
        calls += 1
        return Effect.succeed([[], ''] as const)
      },
    }
    expect(await Effect.runPromise(completeShellLine(session, `bundle('`))).toEqual([[], ''])
    expect(calls).toBe(1)
  })
})
