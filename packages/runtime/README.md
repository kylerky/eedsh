# @eedsh/runtime

The static eedsh profile bundle and plugin. On every profile boot it records or
refreshes the machine-local DSH installation anchor from the profile context, and
it mounts a watcher on the published generated bundle manifest to reload a new
generation through DSH's HMR service. It has no Effect dependency and imports only
Node builtins at runtime.

```
cordis.patch.yml            generated from src/cordis.ts; inserts the '@eedsh/runtime' row
lib/index.js                the bundled Cordis plugin (exports name + apply) and startup
lib/installation-anchor.js  the shared anchor path, format, and validation helpers
```

The package builds two bundled ESM entries, `lib/index.js` and
`lib/installation-anchor.js`, with their declarations and source maps in `lib/`;
the startup and watcher modules are inlined into the plugin and tests import the
source modules directly. The `./installation-anchor` subpath export is the
Node-only helper the CLI shares for the anchor record; it contains no Effect and
no DSH import.

`cordis.patch.yml` is generated from `src/cordis.ts` with `@eedsh/bundle` and
committed. `pnpm --filter @eedsh/runtime bundle:write` regenerates it;
`pnpm --filter @eedsh/runtime bundle:check` verifies it, and the package test
also fails on drift. `dsh.bundle.patch` points at `./cordis.patch.yml`. The package declares
`engines.node` and no `engines.dsh`: DSH does not gate eedsh bundles by version,
and eedsh's CLI and doctor enforce the supported range instead. The materializer places this bundle
immediately before `@eedsh/generated` so it survives every regeneration; it is never
inside the generated bundle.

## Behavior

- Records `$DSH_HOME/.local/state/installation.json` from `profileContext.home`
  and `profileContext.installAnchor` on every profile boot, whether or not HMR is
  present. A successful write also removes the retired
  `$DSH_HOME/.eedsh/installation.json` and then its directory when it holds nothing
  else. The running manifest must name `@deepseek-ai/dsh` and declare a
  readable version; otherwise the runtime warns and writes nothing. The write is
  atomic and owner-only, and a write failure is reported without failing or
  altering the profile. This is the authoritative self-heal path after a DSH
  upgrade: the next boot replaces the recorded anchor.
- A boot without profile context writes nothing and continues normally.
- Registers the generated-layer watcher only inside `ctx.inject(['hmr'], ...)` and
  only when `profileContext` is present and the HMR service provides
  `watchConfig` and `reconcileProfile`. Without HMR, profile context, or either
  method, no watcher is mounted and the composition keeps running unchanged until
  the next start; a missing method is reported as a warning. Anchor recording is
  independent of this watcher registration.
- Watches `<profile>/.eedsh/generated/package.json` through
  `hmr.watchConfig`, reading `eedsh.generationId`.
- A repeated generation id is ignored. A new one calls `hmr.reconcileProfile()`,
  which rereads every bundle layer plus the profile patch, home patch, and
  invocation overlays, so layer precedence is preserved.
- Reports `generation <id> applied` on success, with any inactive-entry warnings.
  Pending modules or a profile-wide restart reason produce
  `generation <id> requires a restart (...)` — the change is never claimed as a hot
  reload and takes effect on the next start.
- A malformed generation record or a reconciliation failure is logged, the watcher
  stays registered, and a later valid generation is applied.
- When both the record's `dshVersion` and the running installation version are
  readable, a mismatch logs a warning naming both and recommending `eedsh sync`;
  the watcher stays registered. When either version is unavailable the runtime
  makes no compatibility claim and does not fail.
- Only a published generation triggers reload. The runtime never evaluates the
  TypeScript config; editing it without `eedsh sync` does nothing.

Diagnostics are printed to the process console with an `[eedsh]` prefix.
