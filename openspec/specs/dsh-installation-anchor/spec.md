# dsh-installation-anchor Specification

## Purpose

Lets eedsh bootstrap a pnpm- or npm-installed DSH on the first sync, record its package anchor, and reuse that anchor so later commands do not depend on the launcher wrapper format.

## Requirements

### Requirement: First sync bootstraps through pnpm or npm

`eedsh sync`, and the sync step of `eedsh run`, SHALL bootstrap an installation when no valid anchor exists and a `dsh` launcher is on `PATH`. It SHALL use pnpm or npm global package metadata, SHALL match the candidate to the launcher's `dsh --version`, and SHALL validate it as a supported `@deepseek-ai/dsh` package before recording the anchor.

#### Scenario: pnpm global metadata supplies the shim's package

- **WHEN** no valid anchor exists, a `dsh` launcher on `PATH` is a pnpm-generated shim, and pnpm global metadata exposes a matching `@deepseek-ai/dsh` package
- **THEN** the sync bootstrap validates that package, records its anchor, and continues the sync
- **AND** no project-local installation is required

#### Scenario: npm global metadata supplies the package

- **WHEN** no valid anchor exists, a `dsh` launcher on `PATH` is an npm global launcher, and npm global metadata exposes the same `@deepseek-ai/dsh` version
- **THEN** the sync bootstrap validates that package, records its anchor, and continues the sync

#### Scenario: Launcher version mismatch is not selected

- **WHEN** pnpm or npm metadata exposes a package whose version differs from `dsh --version`
- **THEN** that candidate is not selected as the anchor
- **AND** the bootstrap fails when no other candidate matches

#### Scenario: Multiple candidates require an explicit choice

- **WHEN** pnpm and npm expose distinct matching installations and the launcher cannot deterministically select one
- **THEN** `eedsh sync` exits 1 with `dsh.launcher_unresolved` naming the candidates and `--dsh`
- **AND** no generation is published

### Requirement: The bootstrap uses no shim or other manager metadata

The bootstrap SHALL NOT parse launcher shim files and SHALL NOT use metadata from any package manager other than pnpm and npm.

#### Scenario: Unsupported manager is not guessed

- **WHEN** the PATH launcher has no matching pnpm or npm global package and no valid anchor exists
- **THEN** `eedsh sync` exits 1 with `dsh.launcher_unresolved`
- **AND** it reports that automatic bootstrap supports pnpm and npm only
- **AND** no generation is published and no profile is booted

#### Scenario: Shim metadata alone is not used

- **WHEN** a PATH launcher contains package-manager shim metadata but matches no pnpm or npm global package
- **THEN** the bootstrap does not parse that metadata
- **AND** the command fails with the launcher remedies

### Requirement: Sync bootstraps whenever the anchor is invalid

`eedsh sync` SHALL bootstrap whenever it cannot use a valid installation anchor, including when the record is missing, unreadable, malformed, points to a missing package, or no longer matches the launcher's version. Once a valid anchor exists, sync SHALL NOT query package managers.

#### Scenario: First sync queries and later syncs reuse the anchor

- **WHEN** the first `eedsh sync` finds no valid anchor and the bootstrap succeeds
- **THEN** it records the anchor
- **AND** a later `eedsh sync` with that valid anchor does not query pnpm or npm

#### Scenario: Missing recorded package triggers a new bootstrap

- **WHEN** the recorded anchor points to a package directory that no longer exists
- **THEN** the next `eedsh sync` treats the anchor as invalid and bootstraps again

#### Scenario: Version mismatch triggers a new bootstrap

- **WHEN** the recorded package version differs from the PATH launcher's `dsh --version`
- **THEN** the next `eedsh sync` treats the anchor as invalid and bootstraps again

#### Scenario: Run's sync step bootstraps

- **WHEN** `eedsh run` performs its sync step with no valid anchor
- **THEN** that sync step bootstraps through pnpm or npm
- **AND** the subsequent boot uses the installation selected by the bootstrap

### Requirement: Only sync bootstraps

The bootstrap SHALL run only in `eedsh sync` and the sync step of `eedsh run`. `eedsh doctor`, `eedsh repl`, `eedsh run --no-sync`, and discovery performed by other commands SHALL NOT bootstrap.

#### Scenario: Non-bootstrap commands do not query package managers

- **WHEN** `eedsh doctor`, `eedsh repl`, or `eedsh run --no-sync` runs with no valid anchor
- **THEN** it does not query pnpm or npm
- **AND** a command that requires DSH fails with remedies naming `eedsh sync`, `--dsh`, and `EEDSH_DSH_ANCHOR`
- **AND** `eedsh doctor` remains usable without DSH

#### Scenario: No PATH launcher does not start a bootstrap

- **WHEN** no `dsh` launcher exists on `PATH` and no valid anchor exists
- **THEN** `eedsh sync` reports a not-found failure naming the install command, `--dsh`, and `EEDSH_DSH_ANCHOR`
- **AND** it does not query package-manager metadata

### Requirement: Discovery consults a validated anchor

After explicit `--dsh`, `EEDSH_DSH_ANCHOR`, and direct PATH resolution, and before a project-local package, discovery SHALL consult the recorded anchor. It SHALL validate the record, absolute anchor, `@deepseek-ai/dsh` manifest, supported version, and package entry on every read. A valid anchor SHALL NOT override explicit selection.

#### Scenario: Recorded anchor resolves a pnpm shim

- **WHEN** a pnpm-generated `dsh` shim is on `PATH`, direct resolution cannot map it, and a valid anchor exists
- **THEN** discovery selects the anchored installation
- **AND** the sync and bridge use that installation

#### Scenario: Explicit selection wins over the anchor

- **WHEN** the user passes `--dsh` and a different valid anchor exists
- **THEN** the explicit installation is selected
- **AND** the anchor is not consulted further

#### Scenario: Anchor works without a PATH launcher

- **WHEN** no `dsh` launcher is on `PATH` and a valid anchor exists
- **THEN** discovery selects the anchored installation before considering a project-local package

#### Scenario: Project-local remains the last fallback

- **WHEN** no PATH `dsh` and no valid anchor exist, but the working directory resolves a project-local `@deepseek-ai/dsh`
- **THEN** discovery selects the project-local installation

### Requirement: An unresolved PATH launcher does not fall through

If a PATH `dsh` exists but neither direct resolution nor a valid anchor resolves it, commands that do not bootstrap SHALL fail with `dsh.launcher_unresolved` and SHALL NOT use a project-local installation.

#### Scenario: Stale anchor on a non-bootstrap command fails instead of guessing

- **WHEN** a PATH `dsh` exists, its package cannot be resolved directly, and the recorded anchor is invalid
- **THEN** a non-bootstrap command fails with `dsh.launcher_unresolved`
- **AND** it does not use a project-local installation
- **AND** `eedsh sync` may bootstrap again

#### Scenario: Malformed anchor is ignored

- **WHEN** the recorded anchor is unreadable, malformed, names a different package, or declares an unsupported version
- **THEN** discovery ignores it
- **AND** `eedsh sync` bootstraps again while other commands report the remedies

### Requirement: The installation anchor is machine-local state

eedsh SHALL store the anchor at `$DSH_HOME/.eedsh/installation.json`. The record SHALL include a format version, the absolute package.json anchor, the exact version, and the recording source; the launcher and package manager SHALL be included when known. Writes SHALL be atomic and owner-only.

#### Scenario: Anchor is stored outside the config project

- **WHEN** a bootstrap or explicit `init --dsh` records an anchor
- **THEN** the record is written below the DSH home
- **AND** the config project's three files are unchanged
- **AND** the project manifest declares no DSH package or version

#### Scenario: Anchor file is owner-only

- **WHEN** the anchor is created on a platform with POSIX permissions
- **THEN** it is readable and writable only by its owner

### Requirement: The anchor is separate from config and write-failure safe

The anchor SHALL NOT be written into the config project's files and SHALL NOT introduce a DSH dependency or config value. A failed anchor write SHALL be reported and SHALL NOT prevent the sync from using the validated installation for that invocation.

#### Scenario: Anchor write failure does not fail the selected installation

- **WHEN** the bootstrap validates an installation but cannot write the anchor
- **THEN** it reports the write failure
- **AND** the current sync can continue with the validated installation
- **AND** a later sync with no valid anchor bootstraps again

### Requirement: First-sync failure names every bootstrap remedy

When the bootstrap cannot select and validate an installation, `eedsh sync` SHALL exit 1 with `dsh.launcher_unresolved`. The failure SHALL name the launcher, state that automatic bootstrap supports pnpm and npm only, and name `--dsh`, `EEDSH_DSH_ANCHOR`, and booting an eedsh-managed profile once. It SHALL NOT import config, load a bridge, publish, or boot.

#### Scenario: Unresolved launcher reports the launcher and remedies

- **WHEN** a PATH `dsh` exists but the bootstrap finds no matching pnpm or npm package
- **THEN** the command exits 1 with `dsh.launcher_unresolved`
- **AND** the diagnostic contains the launcher path, `--dsh`, `EEDSH_DSH_ANCHOR`, and the boot-once refresh path
- **AND** no profile or generation is written

#### Scenario: No PATH launcher keeps the not-found failure

- **WHEN** no PATH `dsh` and no valid anchor exist
- **THEN** the command exits 1 with the existing not-found discovery failure
- **AND** the diagnostic names installing DSH, `--dsh`, and `EEDSH_DSH_ANCHOR`

### Requirement: No general launcher locator

Outside the sync bootstrap and init's explicit anchor, eedsh SHALL NOT query package managers, parse launcher shim files, execute launcher introspection, or probe wrapper formats to locate a DSH package. `doctor`, `repl`, `run --no-sync`, and ordinary discovery SHALL rely on explicit selection, direct PATH resolution, or the recorded anchor.

#### Scenario: Custom wrapper is not introspected

- **WHEN** a non-pnpm/npm `dsh` wrapper is on `PATH` with no valid anchor
- **THEN** eedsh does not probe the wrapper for its package root
- **AND** the command fails with remedies naming `--dsh`, `EEDSH_DSH_ANCHOR`, and the boot-once refresh

#### Scenario: Doctor remains read-only and query-free

- **WHEN** `eedsh doctor` runs with no valid anchor
- **THEN** it does not query pnpm or npm
- **AND** it does not write an anchor
- **AND** it still inspects the requested profile
