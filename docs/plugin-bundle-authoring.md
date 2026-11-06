# Authoring a plugin bundle patch from TypeScript

A DSH plugin bundle ships a package-relative `cordis.patch.yml` named by
`dsh.bundle.patch`. `@eedsh/bundle` is a build-time TypeScript API that
generates that file and checks it for drift. It is a development dependency
only: the published plugin stays a normal DSH bundle, and a profile started by
a plain DSH installation never loads eedsh.

The first acceptance target is the private `dsh-superagent` plugin, whose
hand-written patch contains real rows, groups with `isolate`, disabled rows,
agent presets, and `!!js` expressions. The API handles that shape; the
migration is described at the end of this note.

## Install

```sh
pnpm add -D @eedsh/bundle
```

The package is ESM with TypeScript declarations, supports Node `>=22.19`, and
depends only on `js-yaml` at runtime. It is not a runtime bundle and does not
declare `dsh.bundle`.

## Define the patch

```ts
// src/cordis.ts
import { defineBundlePatch, group, js } from '@eedsh/bundle'

export default defineBundlePatch((patch) => {
  patch
    .insert({ id: 'my-plugin', name: 'my-plugin' })
    .insert({
      id: 'my-plugin-windows',
      name: 'my-plugin/windows',
      disabled: js("process.platform !== 'win32'"),
    })
    .insert(
      group('my-plugin-tools', { name: 'cordis:group', isolate: { myPlugin: true } }, [
        { id: 'my-plugin-tool', name: 'my-plugin/tool' },
      ]),
    )
})
```

Only the bundle patch layer is authored here: `insert`, `override`, `disable`,
`enable`, `raw`, `group`, and `js`. Profile selection, bundle queries,
package/source declarations, the generated-layer marker, and preset selection
belong to a profile's `config.ts`, not to the plugin.

## Generate and check

```ts
// scripts/bundle.ts
import { checkBundlePatch, writeBundlePatch } from '@eedsh/bundle'
import type { BundlePatch } from '@eedsh/bundle'
import { fileURLToPath } from 'node:url'

const definition = (await import(new URL('../src/cordis.ts', import.meta.url).href)) as {
  default: BundlePatch
}
const output = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

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

Run the script with the repository's TypeScript runner. `writeBundlePatch`
writes exactly the emitted bytes through a same-directory temporary file, so a
failed write leaves the previous file. `checkBundlePatch` never writes and
reports a missing or stale artifact.

Commit the generated `cordis.patch.yml`. Add the check to the repository's
normal checks and to `prepack`, so CI and the tarball cannot publish a stale
file.

## Package metadata

```json
{
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "files": ["lib", "cordis.patch.yml"]
}
```

- Keep `@eedsh/bundle` in `devDependencies` only.
- Keep the runtime entry a normal Cordis plugin; do not import eedsh from it.
- Add no eedsh-specific `dsh` fields.
- Do not put an eedsh package in `dependencies` or `peerDependencies`.

The generated YAML uses the DSH Loader dialect: a top-level patch array,
`group`/`isolate`, and `!!js` expressions. It contains no `$eedsh` nodes and
no generator version. The emitted artifact is deterministic, so a patch
release of `@eedsh/bundle` does not change an unchanged definition.

## Plain-DSH acceptance

A profile that eedsh did not start must compose the plugin directly from its
`cordis.patch.yml`. The repository's
`packages/cli/test/integration/plugin-bundle.test.ts` does this against the
fixture in `packages/bundle/test/fixtures/plugin-bundle`: it copies the fixture
into a profile's `node_modules`, asks DSH's own `loadProfileDirectory` to read
it, and composes the rows without eedsh's CLI, sync, runtime, or generated
layer.

## Migrating `dsh-superagent`

The external repository is not modified by the eedsh change. Its migration is:

1. Move the hand-written `cordis.patch.yml` rows into `src/cordis.ts` using
   `insert`, `group`, `js`, and `override`. Reuse `WORKER_PRESET` and
   `ROUTER_PRESET` from `src/app/sessions.ts` (or a small shared ids module) so
   the preset ids have one source.
2. Generate the committed `cordis.patch.yml` with `writeBundlePatch`; keep the
   `!!js` expressions for platform-specific rows and the two agent presets.
3. Keep the existing DSH-loader test that parses the YAML, and add a
   `checkBundlePatch` check to CI and `prepack`.
4. Keep the published package free of eedsh runtime dependencies; the
   `@eedsh/bundle` dev dependency is all that changes at build time.
5. Update the deployment and architecture notes that currently say the patch
   is hand-authored; point them at the TypeScript definition.

The comments in the old YAML move to the TypeScript definition; the generated
file keeps a short header pointing at the definition.

## Publishing

The package version is `0.1.0`, with public npm access and the repository's MIT
license. The final `npm publish` is performed by the repository owner; the
implementation only leaves the package publish-ready. See
[`packages/bundle/README.md`](../packages/bundle/README.md) for the API.
