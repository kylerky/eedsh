import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/index.ts',
  outDir: 'lib',
  tsconfig: '../../tsconfig.base.json',
  fixedExtension: false,
  target: false,
  sourcemap: true,
  dts: { sourcemap: true },
  deps: { neverBundle: [/^@eedsh\//] },
})
