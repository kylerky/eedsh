# @eedsh/bundle

Build-time TypeScript authoring for a DeepSeek Harness (DSH) plugin bundle's
`cordis.patch.yml`. It is **not** a runtime bundle and is never loaded by a
profile: a plugin repository uses it as a development dependency to generate
the patch file that the published plugin ships.

The generated file is ordinary DSH YAML. A profile started by a plain DSH
installation reads the plugin exactly like any other bundle; it needs no
`@eedsh` package, profile, or runtime.

## Install

```sh
pnpm add -D @eedsh/bundle
```

## Define the bundle patch

```ts
// src/cordis.ts
import { defineBundlePatch, group, js } from '@eedsh/bundle'

export default defineBundlePatch((patch) => {
  patch
    .insert({ id: 'my-plugin', name: 'my-plugin', config: { enabled: true } })
    .insert(
      group('my-tools', { name: 'cordis:group', isolate: { myTool: true } }, [
        { id: 'my-tool', name: 'my-plugin/tool' },
      ]),
    )
    .insert({
      id: 'my-plugin-on-windows',
      name: 'my-plugin/windows',
      disabled: js("process.platform !== 'win32'"),
    })
})
```

The surface is deliberately only the bundle's Loader patch layer. It has no
profile selection, bundle queries, package/source declarations, generated
layer marker, or preset selection.

## Generate and check the file

The plugin's build script imports the definition and writes the artifact. Run
the script with the plugin's TypeScript runner, such as `tsx`.

```ts
// scripts/bundle.ts
import { checkBundlePatch, writeBundlePatch } from '@eedsh/bundle'
import type { BundlePatch } from '@eedsh/bundle'
import { pathToFileURL } from 'node:url'

const definition = (await import(pathToFileURL('src/cordis.ts').href)) as {
  default: BundlePatch
}

const output = 'cordis.patch.yml'
if (process.argv.includes('--check')) {
  const result = checkBundlePatch(definition.default, output)
  if (!result.ok) {
    console.error(result.message)
    process.exit(1)
  }
} else {
  writeBundlePatch(definition.default, output)
}
```

`writeBundlePatch` replaces the file atomically. `checkBundlePatch` never
writes; it reports a missing or stale file so CI fails instead of publishing a
drift.

## Package metadata

```json
{
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "files": ["lib", "cordis.patch.yml"]
}
```

Commit the generated `cordis.patch.yml` and include it in `files`; the final
tarball is self-contained. Keep `@eedsh/bundle` in `devDependencies` only. The
plugin's runtime entry stays a normal Cordis plugin and imports no eedsh code.

## Output contract

- A top-level YAML array of DSH Loader patch entries.
- `group` emits `group: true`, the optional `isolate` map, and ordered
  `config` children.
- `js(source)` emits a DSH `!!js` scalar, never an eedsh expression node.
- Output is deterministic: authored order, stable keys, no timestamps,
  absolute paths, or generator version.
- Only `insert`, `override`, `disable`, `enable`, `raw`, `group`, and `js` are
  authored here. Target resolution and composition remain DSH's job.

## License

MIT
