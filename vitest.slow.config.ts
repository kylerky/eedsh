import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@eedsh/config': fileURLToPath(new URL('packages/config/src/index.ts', import.meta.url)),
      '@eedsh/runtime': fileURLToPath(new URL('packages/runtime/src/index.ts', import.meta.url)),
    },
  },
  test: {
    root,
    include: ['packages/*/test/**/*.slow.test.ts', 'test/**/*.slow.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
})
