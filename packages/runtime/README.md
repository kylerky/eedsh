# @eedsh/runtime

The static eedsh profile bundle and plugin. It mounts a watcher on the published
generated bundle manifest and reloads a new generation through DSH's HMR service.
It has no Effect dependency and imports only Node builtins at runtime.

```
cordis.patch.yml   inserts the '@eedsh/runtime' row
lib/index.js       the bundled Cordis plugin (exports name + apply) and watcher
```

The package builds one bundled ESM entry, `lib/index.js`, with its declaration and
source maps in `lib/`; the watcher is inlined and tests import the source module
directly.

`dsh.bundle.patch` points at `./cordis.patch.yml`. The package declares
`engines.node` and no `engines.dsh`: DSH does not gate eedsh bundles by version,
and eedsh's CLI and doctor enforce the supported range instead. The materializer places this bundle
immediately before `@eedsh/generated` so it survives every regeneration; it is never
inside the generated bundle.

## Behavior

- Registers only inside `ctx.inject(['hmr'], ...)` and only when
  `profileContext` is present and the HMR service provides `watchConfig` and
  `reconcileProfile`. Without HMR, profile context, or either method, nothing is
  mounted and the composition keeps running unchanged until the next start; a
  missing method is reported as a warning.
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
