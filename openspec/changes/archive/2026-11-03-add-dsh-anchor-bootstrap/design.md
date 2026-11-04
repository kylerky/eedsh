## Context

See proposal.md for the motivation. The current implementation discovers DSH in packages/cli/src/dsh-discovery.ts: explicit --dsh, EEDSH_DSH_ANCHOR, a PATH launcher mapped through realpathSync and an ancestor package.json walk, then a project-local package. A pnpm shim is a regular shell file, so the PATH step cannot reach the package, and the command reports dsh.not_found.

Three existing facts shape the design:

- DSH's profileContext already exposes installAnchor (the running installation's package.json) and home. packages/runtime/src/watcher.ts already reads installAnchor for version-drift reporting, so an eedsh-managed profile can record its own installation without any DSH change.
- "pnpm list -g --depth=0 --json" exposes the exact installed @deepseek-ai/dsh package path; "npm root -g" plus @deepseek-ai/dsh covers npm.
- adopt-external-dsh is complete but not archived. external-dsh is therefore not yet in openspec/specs/; this change introduces the new dsh-installation-anchor capability and extends the pending discovery contract rather than editing an unarchived delta.

## Goals / Non-Goals

**Goals:**

- Resolve a working pnpm- or npm-installed DSH on the first sync without parsing launcher shims or requiring an upstream DSH change.
- Record a validated, machine-local installation anchor that discovery can use after direct PATH mapping fails.
- Refresh the anchor authoritatively from DSH's existing profile context on every eedsh profile boot.
- Keep package-manager queries confined to setup paths and make the first-sync failure actionable.
- Re-bootstrap on any sync with no valid anchor so a DSH upgrade can self-heal.

**Non-Goals:**

- Upstream "dsh --print-package-root" or any DSH change.
- Parsing cmd-shim-target, reading shim files, or probing a launcher's package root.
- Supporting Yarn, Bun, Volta, asdf, Nix, or arbitrary wrappers in the automatic bootstrap.
- Adding a DSH dependency, config value, plan field, or second DSH copy.
- Writing an anchor from doctor or making doctor require DSH.

## Decisions

### 1. The bootstrap is a sync setup step, not a discovery fallback

Add a CLI bootstrap module, separate from discoverDshInstallation. The sync command and the sync step of run call it only after normal discovery returns dsh.launcher_unresolved and no explicit selection or anchor is present. Discovery itself stays free of package-manager queries; doctor, repl, and "run --no-sync" never call the bootstrap.

The bootstrap validates and records the installation, and sync then uses that installation directly (or re-runs discovery against the fresh anchor). Writing the cache before bridge loading is acceptable: the cache is a location, and a broken bridge is reported as dsh.bridge_unavailable with the anchor.

Alternatives considered: run the bootstrap inside discovery (leaks package-manager queries into every command and doctor); run it in every sync unconditionally (repeated cost and ignores explicit selection); run it only in init (does not cover existing config projects).

### 2. Bootstrap through pnpm and npm global metadata only

The adapters are deliberately narrow:

- **pnpm:** "pnpm list -g --depth=0 --json", read the @deepseek-ai/dsh dependency's path and version. No "pnpm root -g" scan and no shim parsing. A pnpm version that omits path yields no candidate.
- **npm:** "npm root -g", then "<root>/@deepseek-ai/dsh", read its manifest and version.

Run "dsh --version" once (synchronous, bounded, captured) and require the candidate version to equal it. Validate the candidate through the existing anchor reader: absolute package.json, name "@deepseek-ai/dsh", a version satisfying the supported range, and a resolvable JS entry. Deduplicate candidates by realpath. If exactly one remains, use it; if several remain, prefer the manager indicated by the PATH launcher path, and fail with dsh.launcher_unresolved naming the candidates and --dsh if that does not resolve it.

The commands are fixed-argument, read-only, and have no network requirement. They run through a small injectable command runner so tests can supply pnpm/npm/dsh --version output without spawning. Windows .cmd invocation goes through the same shell-aware runner used for other external tools.

Alternatives considered: scan the pnpm global hash layout (layout-coupled, multiple entries); parse cmd-shim-target (internal format, stale-marker skew); query Yarn/Bun/Volta (explicitly out of scope); use "npm ls -g" JSON instead of "npm root -g" (no need for the extra shape).

### 3. A machine-local anchor at DSH_HOME/.eedsh/installation.json

The record is versioned and deliberately small:

    {
      "format": 1,
      "installAnchor": "/.../node_modules/@deepseek-ai/dsh/package.json",
      "version": "0.2.1-rc.2",
      "launcher": "/home/user/.local/share/pnpm/bin/dsh",
      "manager": "pnpm",
      "recordedBy": "sync",
      "recordedAt": "2026-11-03T..."
    }

launcher, manager, recordedAt, and version are optional for a runtime record. installAnchor and format are required. The anchor lives under the DSH home, not the config project, so it is machine-local and does not enter the config repository. The path resolver uses the existing resolveDshHome(env); the runtime uses profileContext.home, so both resolve the same home when the invocation uses the same environment.

Put the pure path and encode/decode helpers in a Node-only subpath of @eedsh/runtime (for example @eedsh/runtime/installation-anchor). The runtime already hosts the recorder and the CLI already depends on the package; a new package for a path and a small schema is unnecessary. The CLI and init write through their existing atomic file seam; the runtime uses a small Node fs atomic write (temp file plus rename) and best-effort error handling.

Validation on every read is in the CLI, not trusted from the record:

- parse and check the format;
- require an absolute installAnchor;
- require a @deepseek-ai/dsh manifest with a supported version;
- resolve the package entry;
- when a PATH launcher exists, compare the launcher's "dsh --version" with the recorded package version; a mismatch makes the anchor invalid;
- if the record names a launcher and it differs from the current PATH launcher, treat the anchor as a hint that no longer matches and let sync bootstrap.

A malformed or stale anchor is ignored rather than fatal. The cache is a hint for location; the manifest and version remain the authority.

Alternatives considered: store the anchor in config.ts or the config project (machine-specific, reintroduces a DSH value, gets committed); store only the version (does not locate the package); store only the launcher shim path (still requires shim parsing); scan DSH homes for profiles (no stable installation record).

### 4. Discovery consults the anchor after PATH mapping and before project-local

The revised order is:

1. --dsh
2. EEDSH_DSH_ANCHOR
3. direct PATH mapping (realpath/ancestor and standard Node resolution)
4. recorded anchor
5. project-local @deepseek-ai/dsh
6. tagged failure

If a PATH dsh exists but step 3 fails and the anchor is invalid or absent, discovery returns dsh.launcher_unresolved with the launcher path. It does not fall through to a project-local package, because that can select a different installation than the user's dsh command. If no PATH dsh exists, the anchor may still be used; project-local remains the last fallback.

Add dsh.launcher_unresolved to the DshFailure code union and add a recorded (or equivalent) discovery source for diagnostics. The existing not_found failure remains for no PATH launcher, no anchor, and no project package. The failure messages for an unresolved launcher include the launcher path, the pnpm/npm-only boundary, --dsh, EEDSH_DSH_ANCHOR, and the boot-once refresh path.

The cache version check is a "dsh --version" probe, not a locator. It runs only when a PATH launcher and a record exist, is bounded, and does not inspect the package root. If the probe fails, the launcher is treated as unresolved.

Alternatives considered: always prefer the anchor over PATH (can ignore the user's current launcher); always fall through to project-local (silent version skew); make dsh.launcher_unresolved a warning and continue (still guesses).

### 5. Sync re-bootstraps on any invalid or missing anchor

sync treats an anchor as valid only after the discovery validation above. If the record is missing, unreadable, malformed, points to a missing package, declares an unsupported version, or fails the launcher version comparison, sync calls the bootstrap. Once a valid anchor is used, sync makes no package-manager query. The bootstrap runs before config evaluation and publication; a failure imports no config, loads no bridge, publishes no generation, and boots nothing.

run inherits this through its sync step. "run --no-sync", repl, and doctor do not bootstrap; they use explicit selection, direct PATH mapping, or the anchor, and commands that require DSH report dsh.launcher_unresolved/dsh.not_found with the sync-once remedy.

Alternatives considered: bootstrap only when the cache file is absent (a stale cache after an upgrade would strand sync); bootstrap on every sync (repeated cost and package-manager coupling on every run); have non-sync commands bootstrap (breaks the read-only/query-free boundary and makes doctor spawn package managers).

### 6. Init records an explicit anchor and stays query-free

Add an optional "--dsh <package dir|package.json>" to the init command. Validate it before writing project files; an invalid explicit path fails with the existing tagged discovery failure and creates no project files. On success, record the anchor and keep the existing non-destructive init behavior. Without --dsh, init reads and validates an existing anchor, reports it, and never queries pnpm/npm or parses a launcher. With no DSH and no anchor it succeeds and prints the first-sync/bootstrap hint.

The anchor write uses the init command's Effect FileSystem and the existing atomic write helper, with the cache path resolved from resolveDshHome(runtime.env). Init's tests use the memory FS and can inject a temp DSH home; an injected anchor locator keeps tests from spawning real package managers.

Alternatives considered: make init run the bootstrap (duplicates the sync path and makes init depend on DSH availability timing); make init fail when no anchor can be recorded (breaks init without DSH); add a DSH dependency to the config project (reintroduces a second installation and skew).

### 7. The runtime refreshes the anchor from profileContext

@eedsh/runtime already reads profileContext.installAnchor for drift. Add an independent recorder at plugin apply (or an equivalent startup hook) that:

- reads profileContext.home and profileContext.installAnchor;
- validates the anchor names @deepseek-ai/dsh and has a readable version;
- writes/refreshes <home>/.eedsh/installation.json with recordedBy: "runtime";
- runs whether or not HMR is present;
- catches and logs write failures; never fails the profile.

The watcher's existing registration and behavior are unchanged. The recorder is best-effort and does not depend on the generated layer being present. This is the authoritative self-heal path: after a DSH upgrade, the next boot of any eedsh-managed profile rewrites the anchor.

Alternatives considered: write the anchor only from the watcher (skips HMR-disabled profiles); make the write failure fatal (breaks the profile for eedsh state); add the recorder to the generated bundle (it would be replaced/regenerated and is not static).

### 8. Keep the no-general-locator boundary and document the archive order

The bootstrap and init's explicit --dsh are the only package-manager/anchor setup paths. Discovery, doctor, repl, and "run --no-sync" do not parse shim files or query package managers. Other launchers use --dsh, EEDSH_DSH_ANCHOR, or a prior eedsh profile boot.

adopt-external-dsh is the pending source of external-dsh; external-dsh is not yet a main spec. This change adds dsh-installation-anchor and modifies config-project and generated-layer-hmr. Archive adopt-external-dsh before archiving this change so the external-DSH discovery contract and this extension apply in order. Do not edit the completed unarchived change.

Alternatives considered: modify external-dsh now (its base spec is not archived); create a second copy of the discovery contract (overlapping specs); block this change until adopt-external-dsh is archived (unnecessary for planning and implementation).

## Risks / Trade-offs

- **pnpm metadata shape** -> rely only on the current "pnpm list -g --depth=0 --json" path field; older pnpm versions without it fail the bootstrap and need --dsh or a prior boot. Document the supported pnpm behavior.
- **Manager ambiguity or same-version different installations** -> version match plus manager inference; if still ambiguous, fail with --dsh instead of guessing. The runtime refresh corrects a same-version first anchor after the first boot.
- **Stale anchor** -> validate on every read, compare with "dsh --version", re-bootstrap on sync, and refresh from the runtime. A same-version different install can still be selected until a boot refreshes it; --dsh overrides.
- **Anchor write failure** -> warn and continue the current sync with the validated installation; a later sync re-bootstraps. Init keeps the config project; the runtime continues booting.
- **Bootstrap cost** -> only on a sync with no valid anchor; a valid cache avoids pnpm/npm entirely.
- **"dsh --version" probe** -> safe, bounded, and only for cache validation with a PATH launcher. A broken launcher is unresolved rather than silently ignored.
- **Windows launchers** -> pnpm/npm and "dsh --version" may be .cmd; use a shell-aware, fixed-argument runner and cover paths with spaces.
- **Runtime side effect** -> owner-only, atomic, best-effort, and outside the profile/config; a write failure never alters the profile.
- **Archive order** -> archive adopt-external-dsh first; otherwise the new capability and the pending external-DSH delta are applied out of order.

## Migration Plan

1. Land the CLI bootstrap, anchor cache, discovery integration, dsh.launcher_unresolved, and init --dsh together with tests.
2. Land the runtime recorder; existing profiles get it on the next sync/publication, and any already-published eedsh profile starts refreshing the anchor on its next boot.
3. No config, plan, profile-format, or published-manifest migration is required. Existing config projects keep working; the next sync with no valid anchor bootstraps through pnpm/npm.
4. For a DSH upgrade: a sync with a stale anchor bootstraps again; alternatively, boot an eedsh-managed profile and the runtime refreshes the anchor.
5. Rollback is additive: remove the cache file or the new code; no published artifact or config schema depends on the anchor. The previous eedsh release ignores DSH_HOME/.eedsh/installation.json.
6. Archive adopt-external-dsh before archiving this change.
