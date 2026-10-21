import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/bin.ts',
  outDir: 'lib',
  tsconfig: '../../tsconfig.base.json',
  fixedExtension: false,
  target: false,
  sourcemap: true,
  dts: false,
  deps: { neverBundle: [/^@eedsh\//] },
})
