import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@eedsh/runtime/installation-anchor',
        replacement: fileURLToPath(
          new URL('packages/runtime/src/installation-anchor.ts', import.meta.url),
        ),
      },
      {
        find: '@eedsh/bundle',
        replacement: fileURLToPath(new URL('packages/bundle/src/index.ts', import.meta.url)),
      },
      {
        find: '@eedsh/config',
        replacement: fileURLToPath(new URL('packages/config/src/index.ts', import.meta.url)),
      },
      {
        find: '@eedsh/plan',
        replacement: fileURLToPath(new URL('packages/plan/src/index.ts', import.meta.url)),
      },
      {
        find: '@eedsh/runtime',
        replacement: fileURLToPath(new URL('packages/runtime/src/index.ts', import.meta.url)),
      },
    ],
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
