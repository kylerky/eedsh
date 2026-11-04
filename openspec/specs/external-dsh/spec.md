# external-dsh Specification

## Purpose

Lets eedsh operate on a user-installed DSH: discover one installation, enforce a supported version range, load composition capabilities from it, and publish bundles without DSH version gates.

## Requirements

### Requirement: Runtime commands require a discovered DSH installation

`eedsh sync`, `eedsh run`, and `eedsh repl` SHALL require a discovered `@deepseek-ai/dsh` installation. `eedsh init`, `eedsh check`, and `eedsh doctor --profile` SHALL remain usable when no DSH installation is present. When a required installation is missing, the command SHALL fail with a tagged failure that names the available remedies and SHALL NOT publish a profile, boot DSH, or write a config project.

#### Scenario: Sync without DSH fails before publication

- **WHEN** the user runs `eedsh sync` and no DSH installation can be discovered
- **THEN** the command exits 1 with a failure naming the install command, `--dsh`, and `EEDSH_DSH_ANCHOR`
- **AND** no generation is published

#### Scenario: Init and check work without DSH

- **WHEN** the user runs `eedsh init --no-install` or `eedsh check` on a machine with no DSH installation
- **THEN** the command succeeds without discovering DSH

#### Scenario: Doctor by profile works without DSH

- **WHEN** the user runs `eedsh doctor --profile work` and no DSH installation is present
- **THEN** doctor inspects the published profile and reports its file findings
- **AND** the absence of DSH is not an error

### Requirement: Discovery selects one installation with explicit precedence

Discovery SHALL use, in order: an explicit `--dsh <path>`, `EEDSH_DSH_ANCHOR`, a `dsh` launcher on `PATH`, then a project-local package. It SHALL verify the selected package, report its path and version, fail an invalid explicit selection instead of falling through, and select one installation per invocation.

#### Scenario: Explicit selection wins

- **WHEN** the user passes `--dsh` and other DSH installations are also discoverable
- **THEN** eedsh uses the explicit installation for the whole invocation

#### Scenario: PATH provides the installation

- **WHEN** no explicit selection or anchor is supplied and `dsh` is on `PATH`
- **THEN** eedsh resolves the launcher's package root and uses that installation

#### Scenario: Invalid explicit selection fails

- **WHEN** `--dsh` names a missing path or a package that is not `@deepseek-ai/dsh`
- **THEN** the command exits 1 with a tagged discovery failure naming the path
- **AND** it does not fall back to another installation

#### Scenario: No installation is found

- **WHEN** no explicit selection, anchor, PATH launcher, or project-local package is available
- **THEN** the command exits 1 with a tagged discovery failure naming all discovery remedies
- **AND** no profile is published or booted

#### Scenario: Sync and run use the same installation

- **WHEN** `eedsh run` syncs a profile and then boots it
- **THEN** resolution, preflight, the generation record, and the spawned launcher all come from the one selected installation

### Requirement: The supported DSH version range is enforced for the discovered installation

eedsh SHALL declare one supported DSH range, `^0.2.1-rc.2`, as CLI policy. A discovered DSH version SHALL satisfy it. A version outside the range SHALL fail before publication or boot with a tagged failure reporting the discovered version and the supported range. No config value or published artifact SHALL change the supported range.

#### Scenario: The current release line is accepted

- **WHEN** the discovered DSH is `0.2.1-rc.2`, `0.2.1-rc.5`, or `0.2.2-alpha.2`
- **THEN** it satisfies the supported range

#### Scenario: A future version outside the range is rejected

- **WHEN** the discovered DSH is outside the supported range
- **THEN** the command exits 1 with a tagged unsupported-version failure
- **AND** no generation is published or booted

#### Scenario: The config supplies no competing range

- **WHEN** a config is evaluated and the discovered DSH is within the supported range
- **THEN** discovery and the supported range are the only version inputs
- **AND** no config value can narrow or widen them

### Requirement: Composition capabilities come from the discovered installation

Before config evaluation or publication preflight, eedsh SHALL load bundle resolution, manifest reading, patch loading, and entry composition from the discovered installation. A missing capability SHALL fail with a tagged failure naming it. The published CLI SHALL declare no production DSH or app-boot dependency.

#### Scenario: Queries and preflight use the discovered DSH

- **WHEN** a config queries a bundle and sync preflights the generated layers
- **THEN** both use the composition capabilities of the selected installation

#### Scenario: A required capability is missing

- **WHEN** the selected installation does not provide entry composition
- **THEN** the command exits 1 with a tagged capability failure naming the missing capability
- **AND** no generation is published

#### Scenario: The CLI ships no DSH implementation

- **WHEN** the published CLI package manifest is inspected
- **THEN** it declares no production dependency on `@deepseek-ai/dsh`, `@deepseek-ai/dsh-app-boot`, or the patch-entry include package

### Requirement: Published profile artifacts declare no DSH engine and keep exact provenance

The generated bundle and the `@eedsh/runtime` package SHALL NOT declare `engines.dsh`. The generation record SHALL keep the exact discovered DSH version as `dshVersion`. DSH SHALL load the bundles without an eedsh version gate; eedsh's CLI and doctor enforce the supported range and report record drift.

#### Scenario: The generated manifest has no DSH engine

- **WHEN** a generated package manifest is inspected
- **THEN** it contains no `engines.dsh` field
- **AND** it still declares its bundle patch files

#### Scenario: The runtime package has no DSH engine

- **WHEN** the `@eedsh/runtime` package manifest is inspected
- **THEN** it contains no `engines.dsh` field
- **AND** it still declares its bundle patch file

#### Scenario: The record keeps the exact version

- **WHEN** a profile is published
- **THEN** the generation record records the exact discovered version as `dshVersion`

#### Scenario: DSH does not gate eedsh bundles by version

- **WHEN** the running DSH version changes within or outside the supported range
- **THEN** DSH itself does not skip the generated or runtime bundle because of `engines.dsh`
- **AND** eedsh's CLI and doctor report supported-range or record-drift findings
