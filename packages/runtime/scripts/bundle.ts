import { fileURLToPath } from 'node:url'
import { checkBundlePatch, writeBundlePatch } from '@eedsh/bundle'
import definition from '../src/cordis.ts'

const output = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

if (process.argv.includes('--check')) {
  const result = checkBundlePatch(definition, output)
  if (!result.ok) {
    console.error(result.message)
    process.exit(1)
  }
} else {
  writeBundlePatch(definition, output)
}
