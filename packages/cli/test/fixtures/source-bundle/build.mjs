import { mkdir, writeFile } from 'node:fs/promises'

await mkdir('lib', { recursive: true })
await writeFile('lib/index.js', 'export const activate = () => {}\n')
await writeFile('lib/client.js', "export const panel = 'source-bundle'\n")
