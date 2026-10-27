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
    globalSetup: ['./test/global-setup.ts'],
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/lib/**', '**/.tmp/**', '**/*.slow.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
