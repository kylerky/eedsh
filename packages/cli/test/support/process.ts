import type { ReadableLike, SpawnedProcessLike, SpawnLike, SpawnOptionsLike } from '../../src/spawn'

/** A readable child stream fed directly by a test. */
export class FakeStream implements ReadableLike {
  private readonly listeners: ((chunk: unknown) => void)[] = []

  on(_event: 'data', listener: (chunk: unknown) => void): this {
    this.listeners.push(listener)
    return this
  }

  push(value: string): void {
    for (const listener of this.listeners) listener(value)
  }
}

/** A child process whose events a test finishes explicitly. */
export class FakeChild implements SpawnedProcessLike {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  private exitHandler?: (code: number | null, signal: string | null) => void
  private closeHandler?: (code: number | null, signal: string | null) => void
  private errorHandler?: (error: Error) => void

  on(event: 'exit' | 'close' | 'error', callback: (...args: never[]) => void): this {
    if (event === 'exit') {
      this.exitHandler = callback as (code: number | null, signal: string | null) => void
    } else if (event === 'close') {
      this.closeHandler = callback as (code: number | null, signal: string | null) => void
    } else {
      this.errorHandler = callback as (error: Error) => void
    }
    return this
  }

  finish(code: number | null, stdout = '', stderr = ''): void {
    this.stdout.push(stdout)
    this.stderr.push(stderr)
    this.closeHandler?.(code, null)
    this.exitHandler?.(code, null)
  }

  fail(error: Error): void {
    this.errorHandler?.(error)
  }

  kill(): boolean {
    return true
  }
}

/** Options for {@link fakeSpawner}. */
export interface FakeSpawnOptions {
  exitCode?: number
  stdout?: string
  stderr?: string
  listing?: string
  listingExit?: number
}

/**
 * Spawn seam that records calls and finishes children on the microtask queue.
 * @param options - exit codes and captured output.
 * @returns the recorded calls and the spawn function.
 */
export function fakeSpawner(options: FakeSpawnOptions = {}) {
  const calls: { command: string; args: string[]; options: SpawnOptionsLike }[] = []
  const spawn: SpawnLike = (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions })
    const child = new FakeChild()
    if (args.includes('--listFilesOnly')) {
      const exitCode = options.listingExit ?? 0
      queueMicrotask(() => child.finish(exitCode, options.listing ?? ''))
    } else {
      const exitCode = options.exitCode ?? 0
      queueMicrotask(() => child.finish(exitCode, options.stdout ?? '', options.stderr ?? ''))
    }
    return child
  }
  return { calls, spawn }
}
