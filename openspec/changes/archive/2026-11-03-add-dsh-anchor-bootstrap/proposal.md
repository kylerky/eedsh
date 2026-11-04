## Why

eedsh's PATH discovery assumes the `dsh` launcher is a symlink into, or a file inside, the `@deepseek-ai/dsh` package. pnpm installs a generated shell shim instead, and npm installs on Windows use wrapper files, so a working `dsh` can be present while eedsh reports `dsh.not_found`. We need a first-sync bootstrap that uses package-manager metadata for the two supported global managers, then a recorded anchor that later commands reuse. No upstream DSH change is available for the supported release line.

## What Changes

- Add a **first-sync bootstrap** to `eedsh sync` (and the sync step of `eedsh run`) when no valid recorded anchor exists and a `dsh` launcher is on PATH. The bootstrap queries only **pnpm** and **npm** global metadata, matches the candidate against `dsh --version`, validates the package, records the anchor, and continues the sync.
- Re-run the bootstrap on **any sync with no valid anchor**, including a missing, malformed, missing-path, or version-mismatched reading. Once a valid anchor is recorded, sync does not query the package manager again.
- Add a machine-local **installation anchor** at `$DSH_HOME/.eedsh/installation.json`. Discovery consults it after explicit selection and PATH mapping and before the project-local package. The anchor is validated on every read and never overrides `--dsh` or `EEDSH_DSH_ANCHOR`.
- Have `@eedsh/runtime` record and refresh the anchor from DSH's existing `profileContext.installAnchor` and `profileContext.home` on every eedsh profile boot, independently of HMR and as a best-effort write.
- Extend `eedsh init` with an optional `--dsh <package dir|package.json>` that validates and records the anchor. Init reads and reports an existing valid anchor but does not query package managers. Init still needs no DSH installation and still writes only the three config-project files.
- Add a tagged `dsh.launcher_unresolved` failure for a PATH `dsh` whose package cannot be located. The failure names `--dsh`, `EEDSH_DSH_ANCHOR`, and the boot-once refresh path.
- Keep discovery free of package-manager and shim lookups. The bootstrap runs only in setup paths (`sync`, `run`'s sync step, and explicit `init --dsh`); `doctor`, `repl`, `run --no-sync`, and ordinary discovery never query pnpm or npm.
- Support **pnpm and npm only** for the automatic bootstrap. No `cmd-shim-target` parsing, no Yarn/Bun/Volta/asdf/Nix adapters; those installations use `--dsh`, `EEDSH_DSH_ANCHOR`, or a prior eedsh profile boot.
- Keep the existing external-DSH model unchanged: no DSH production dependency, no config DSH field, no second DSH copy, and no upstream DSH release required.

## Capabilities

### New Capabilities
- `dsh-installation-anchor`: first-sync bootstrap through pnpm/npm global metadata, the recorded anchor, discovery integration, validation and no-general-locator boundaries, and the launcher-unresolved failure.

### Modified Capabilities
- `config-project`: init accepts an explicit `--dsh` anchor and reports a recorded anchor without querying package managers; it still works without DSH and preserves its project files.
- `generated-layer-hmr`: the runtime records and refreshes the running DSH installation anchor independently of the HMR watcher, best effort and without failing the profile.

## Impact

- **CLI**: new bootstrap module and sync-path integration; `init --dsh`; a new `dsh.launcher_unresolved` code; no change to config resolution or plan format.
- **Runtime**: one new best-effort write from `profileContext.installAnchor`/`home`; the existing watcher behavior and HMR requirements are unchanged.
- **State**: a machine-local `$DSH_HOME/.eedsh/installation.json` schema shared by the CLI and runtime; no config-project manifest field and no DSH dependency.
- **Managers**: pnpm and npm global metadata only; pnpm's JSON must expose the package path. Ambiguous candidates fail with the anchor remedies rather than guessing.
- **Existing installations**: the first sync after this change may query and record; later syncs use the anchor. After a DSH upgrade, a sync with a stale anchor queries again, or a prior profile boot refreshes it.
- **Prerequisite**: `adopt-external-dsh` is complete but not archived; `external-dsh` is not yet in `openspec/specs/`. This change extends that pending discovery contract through the new capability. Archive `adopt-external-dsh` before archiving this change so both deltas apply in order.
- **Out of scope**: upstream `dsh --print-package-root`, shim parsing, non-pnpm/npm package managers, and writes from `doctor`.
