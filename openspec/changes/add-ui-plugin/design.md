## Context

See `proposal.md` for motivation. The design is constrained by the existing eedsh and DSH boundaries:

- eedsh compiles `config.ts` into a published DSH profile. The CLI owns evaluation, materialization, dependency reconciliation, publication, and the profile lock. Published state lives under `$DSH_HOME/profiles/<name>/.eedsh/` (`plan.json` and `generated/package.json`); the generated package manifest contains the generation record.
- DSH Web is a browser-side Cordis application. A package declares `dsh.client` in `package.json`, exports `./client`, and is served by the `dsh-client-modules` graph. A Loader row's `main` is the Host half.
- Settings pages are Slot contributions: a feature calls `ctx.slots.inject('settings.section', ...)` and registers a component with `ctx.slots.register`.
- A Host plugin can register named HTTP routes with `ctx.webServer.register`. `@deepseek-ai/dsh-host-open-in-app` is the existing precedent for the same `connection.requestRejection` fence over Host-owned routes.
- DSH `^0.2.1-rc.2` and `0.2.2-alpha.3` provide the Slot, route, connection, `profileContext`, and generation-record shapes used here. The client-bundle build format is not published as a standalone external build tool; this is the main implementation risk.

## Goals / Non-Goals

**Goals:**

- Give eedsh a first-class, optional Web surface without modifying DSH, duplicating plan/doctor, or changing the profile format.
- Make published profile status and the two common operations (sync, doctor) available from Settings.
- Keep the Host surface small and auditable: read published artifacts, spawn the CLI with fixed argv, never evaluate config.
- Ship in phases so a read-only page can be reviewed before any mutation is exposed.

**Non-Goals:**

- Editing `config.ts`, visual profile authoring, or a browser REPL.
- Adding new eedsh CLI commands or changing the plan/generation format.
- A sidebar page, command-palette integration, or a second app shell in v1.
- Supporting profiles whose DSH composition has no `webServer` or `connection`.

## Decisions

### 1. Add an optional `@eedsh/ui` bundle, not part of `@eedsh/runtime`

`@eedsh/runtime` boots in every eedsh profile, including headless and CLI-only profiles. Bundling browser code there would make every profile install and load a UI it does not use. A separate `@eedsh/ui` bundle keeps the existing runtime behavior and composition weight unchanged.

**Alternatives:** put the UI row in `@eedsh/runtime` and disable it conditionally; rejected because install/load still carries the browser dependency and the runtime's anchoring/HMR contract stays simpler. A standalone web app is rejected because it duplicates DSH auth, theme, layout, and HMR and is not the requested plugin form.

### 2. One package, one Loader row, Host and browser halves together

The package's `main` is the Cordis Host plugin; `dsh.client` plus `./client` is the browser half. One Loader row loads the Host plugin and makes the browser module available. This matches the DSH package shape and avoids a second registration/version pair.

### 3. Put the page in Settings → eedsh for v1

Settings is the existing surface for configuration and diagnostics, and its shell already owns the panel, navigation, focus, Escape, and responsive behavior. A sidebar page would be more discoverable but requires page chrome, icon, navigation, and more layout integration; it is deferred.

### 4. Read published artifacts, not `config.ts`

The Host status reader reads:

- `$DSH_HOME/profiles/<name>/package.json` for the profile manifest and bundle selection;
- `.eedsh/plan.json` for the validated plan summary;
- `.eedsh/generated/package.json` for the generation record and validation;
- the generated file's mtime for the publish time.

It does not evaluate TypeScript, does not import the config project, and does not expose the config text. This keeps status cheap, side-effect free, and safe. The trade-off is that profiles declared in config but never synced (and therefore having no profile directory) cannot be listed in v1.

**Alternatives:** evaluate the config through the CLI on every status read; rejected for cost, side effects, and secret exposure. Add a read-only `eedsh status` command; deferred because v1 can meet the goal without a new CLI surface.

### 5. Run sync and doctor through the CLI in a child process

The Host spawns the configured `eedsh` executable with fixed argv (`sync [--profile=<name>]`, `doctor --profile=<name>`) and no shell. It captures a bounded output tail and the exit code. This keeps the CLI as the only writer and avoids importing Effect, `tsx`, and the materializer into the DSH Host process.

**Alternatives:** import `@eedsh/cli` and call its program in-process; rejected for lifecycle coupling and the risk of a second writer inside DSH. Reimplement plan/doctor in the Host; rejected as a second source of truth and a large correctness risk.

### 6. Use same-origin HTTP routes rather than Typert Remotes

DSH's generated Remote contributions are selected by the first-party `@deepseek-ai/dsh-api-remotes` assembly at build time. There is no stable external-package registration path for a new generated namespace. `webServer` named routes are the supported escape hatch for a plugin-owned HTTP surface, with `connection.requestRejection` providing the Host/Origin fence and browser authentication. The browser uses a document-relative `fetch('eedsh/...')`, following the open-in-app precedent.

### 7. Model actions as in-memory jobs

Sync and doctor can outlive a single request. The Host owns a small job table: one sync job per profile, sync-all mutually exclusive with single-profile jobs, an output ring buffer (64 KiB), a cancellation path (`SIGTERM`, then `SIGKILL` within a grace period), and a TTL. The client polls the job while it is open. This avoids SSE for v1 and keeps the transport simple; a later SSE/JSON contract can replace polling without changing the page's user-visible behavior.

### 8. Conservative security defaults

- Every route calls `connection.requestRejection` first; if `connection` is absent, the plugin does not register routes and DSH reports the unresolved dependency.
- Only `GET /eedsh/status` is read-only; mutations are POST.
- Bodies are `application/json` and at most 64 KiB. Profile names must satisfy the eedsh safe-name rule and are passed as one `--profile=<name>` argv.
- Command, config path, and installation path come only from Host config. The browser cannot add CLI flags.
- Job output is bounded and never includes config contents or environment values.
- When `webServer` binds a non-loopback address, mutations are disabled by default; a Host config flag can opt in. This is stricter than the connection fence alone and protects a local admin operation from authenticated remote browsers.

## Architecture

```
Settings → eedsh (browser half, settings.section)
  GET  eedsh/status
  POST eedsh/sync       { profile?: string }
  POST eedsh/doctor     { profile: string }
  GET  eedsh/jobs/<id>
  POST eedsh/jobs/<id>/cancel
        │ same-origin fetch
        ▼
@eedsh/ui Host (Cordis row: name, inject ['webServer', 'connection'], apply)
  webServer routes ──► connection.requestRejection first
  status reader ─────► $DSH_HOME/profiles/<name>/.eedsh/*
  job runner ────────► spawn eedsh sync/doctor (fixed argv, no shell)
```

### Wire surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/eedsh/status` | `{ command, currentProfile, dsh, hmr, profiles[] }` |
| `POST` | `/eedsh/sync` | Start a sync job; body `{ profile?: string }` |
| `POST` | `/eedsh/doctor` | Start a doctor job; body `{ profile: string }` |
| `GET` | `/eedsh/jobs/<id>` | Job state, bounded output tail, exit code, timestamps |
| `POST` | `/eedsh/jobs/<id>/cancel` | Cancel a running job |

Job routes use a `/eedsh/jobs/` prefix; the remaining path segment is the id. All others are exact registrations. Every registration is owned by `ctx.effect` and disposed with the plugin.

### Package shape

```
packages/ui/
  package.json        main lib/index.js; dsh.client; dsh.bundle.patch
  cordis.patch.yml    inserts the single @eedsh/ui row
  tsdown.config.ts    Node entry + browser entry
  src/index.ts        Host: routes, jobs, status reader
  src/shared.ts       route constants and wire types
  src/client/index.ts browser: settings.section, components, fetch
  src/client/styles.ts
  locale/en.json
  locale/zh.json
```

The browser bundle is not a normal ESM artifact. It must register a factory:

```js
window.__ModuleLoader__.load({
  id: '@eedsh/ui',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    // bundle body; react, cordis, ui-slots are resolved from the shell table
    return module.exports
  }
})
```

DSH's `packages/client/tsdown.client.ts` implements this format plus CSS modules, asset revisions, and source maps, but it is repository-local, not a published external build helper. The implementation must either reproduce the minimal wrapper in eedsh or vendor the pattern, keep baseline modules external (`react`, `react/jsx-runtime`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-store`), and verify the result in a real `dsh web` profile. The first implementation task is a spike for this reason.

### Opt-in configuration

`@eedsh/ui` is an optional package and bundle. Selecting it requires both a dependency
and a bundle selection because bundle selection never declares a dependency:

```ts
import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('work', (profile) => {
    profile
      .bundle('@deepseek-ai/dsh-base')
      .bundle('@deepseek-ai/dsh-web-app')
      .package('@eedsh/ui', '^0.1.0') // version follows the eedsh release
      .bundle('@eedsh/ui')
      .generated()
      .layer((layer) => {
        layer.override('eedsh-ui', {
          configPath: '/home/me/.config/eedsh/config.ts',
          command: 'eedsh',
        })
      })
  })
  .build()
```

`configPath` is needed only when the profile was published from a non-default XDG
config; `command` names the executable when it is not on `PATH`. Both are Host config
and cannot be set by the browser. `@eedsh/runtime` remains automatically managed and
keeps its position and HMR behavior.

### UI outline

```
Settings → eedsh                                  [Refresh] [Sync all]
  Typed profiles for DeepSeek Harness
  ● web  current                          synced · 2 minutes ago
    generation 8f3a9c21 · DSH 0.2.1-rc.2 · 4 bundles · 12 layers
    [Details] [Doctor] [Sync]
  ○ work                                 no generation yet
    [Details] [Sync]
  Running: syncing web… [Cancel]
    > pnpm install
    > published profile "web" (generation 8f3a9c21)
  Doctor: 0 errors, 2 warnings
```

The page uses `--dsw-*` tokens and standard primitives; dictionary-driven copy in Chinese
and English; no color-only status. Loading, empty, invalid, failed, cancelled, and
connection-loss states are explicit and never presented as a successful stale result.

## Risks / Trade-offs

- **External client-bundle format is not a public build contract** → Make the first task a real Web-load spike in both supported DSH versions. If the format cannot be reproduced reliably, stop and propose a published DSH build helper instead of shipping an unverified `lib/client.js`.
- **DSH Slot/route APIs can drift between 0.2.1-rc.2 and 0.2.2-alpha.3** → Keep the supported range explicit, run a compatibility smoke test in the DSH matrix, and avoid private APIs beyond the established `connection.requestRejection` fence.
- **Profile directories are the only discovery source in v1** → Show only directory-backed profiles; document the limitation. A read-only `status --json` can close it later without changing v1 requirements.
- **No preflight warning history** → Do not imply that published state is warning-free; doctor is the on-demand source for findings.
- **The UI cannot prove HMR applied a generation** → Report HMR availability and the runtime's documented behavior, never "applied".
- **A sync can be long and package managers can prompt** → Close stdin and use the CLI's non-interactive behavior; if a prompt would block, surface a failure instead of hanging.
- **Remote mutations** → Default to read-only on non-loopback bindings; opt-in is explicit Host config.
- **Duplicated read logic** → Keep the v1 status reader small and read-only. If it grows, extract a shared read-only inspector for CLI/REPL/UI rather than teaching the UI to evaluate config.

## Migration Plan

1. Ship `@eedsh/ui` as a new optional package; no existing profile changes until the user adds `.package()` and `.bundle()`.
2. Document the opt-in example and the `configPath`/`command` row config.
3. Land read-only status first; review the page and the route fence before enabling mutations.
4. Add sync/doctor jobs behind the same fence; verify cancellation and failure paths.
5. Keep the change active in OpenSpec until the implementation tasks are complete; archive only after the full task list and verification are done.

Rollback is removing the bundle selection and dependency; the CLI and published profiles are untouched. No profile format or data migration is involved.

## Open Questions

- Whether a later release should add a sidebar entry/status chip instead of, or in addition to, the Settings section. This does not change the v1 spec or tasks.
- Whether a later release should add a read-only `eedsh status --json` or a shared inspector package for declared-but-unpublished profiles. This is an enhancement to the documented v1 limitation, not a blocker.
