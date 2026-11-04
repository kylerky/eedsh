# generated-layer-hmr Specification

## Purpose
Reloads a published generated bundle layer into a running DSH profile through the existing HMR queue, while leaving GUI and machine overrides in their normal precedence.

## Requirements

### Requirement: The runtime watcher is mounted statically
The materialized profile SHALL include a static runtime bundle that mounts the generated-layer watcher. The watcher SHALL register only when the profile provides profile context, an active HMR service, and the `watchConfig` and `reconcileProfile` methods it uses. A missing profile context, HMR service, or method SHALL leave the profile booting normally without a watcher registration.

#### Scenario: HMR-enabled profile registers the watcher
- **WHEN** a profile with HMR, profile context, and both required HMR methods boots
- **THEN** the watcher registers on the generation record

#### Scenario: HMR-disabled composition does not register
- **WHEN** a profile boots without HMR
- **THEN** the watcher does not register and the profile continues to boot normally

#### Scenario: Non-profile boot does not register
- **WHEN** the composition has no profile context
- **THEN** the watcher does not register

#### Scenario: Incomplete HMR service does not register
- **WHEN** an HMR service is present but lacks `watchConfig` or `reconcileProfile`
- **THEN** the watcher does not register
- **AND** the runtime reports the missing capability without failing the process

### Requirement: Generation and runtime version drift is reported

When the runtime can read both the generation record's exact `dshVersion` and the running DSH installation version, it SHALL compare them. A mismatch SHALL produce a warning that names both versions and tells the user to run `eedsh sync`. The warning SHALL NOT fail the process or prevent a later generation from being observed. When either version is unavailable, the runtime SHALL NOT claim that the generation matches the running DSH.

#### Scenario: Generation was published with another DSH

- **WHEN** the generation record names `0.2.1-rc.2` and the running installation is `0.2.1-rc.5`
- **THEN** the runtime logs a warning naming both versions and recommending `eedsh sync`
- **AND** the watcher remains registered

#### Scenario: Generation and runtime agree

- **WHEN** the record's `dshVersion` equals the running installation version
- **THEN** the runtime logs no drift warning

#### Scenario: Running version is unavailable

- **WHEN** the profile context does not expose an installation manifest the runtime can read
- **THEN** the runtime does not claim compatibility and does not fail

### Requirement: A published generation reloads through HMR
When the generation record changes to a new generation identifier, the watcher SHALL run DSH profile reconciliation inside the HMR exclusive queue. Reconciliation SHALL reread bundle layers, the profile patch, the home patch, and invocation overlays and apply the new generation without restarting the process.

#### Scenario: Patch-layer change applies without restart
- **WHEN** a new generation changes an inserted row or its configuration
- **THEN** the running composition reflects the change without a process restart

#### Scenario: Successive generations apply
- **WHEN** two new generations are published in sequence
- **THEN** both are applied and the watcher remains registered

#### Scenario: Duplicate generation identifier does not reload
- **WHEN** the generation record is observed again with the same identifier
- **THEN** no reconciliation is run

### Requirement: Layer precedence survives reload
Reconciliation SHALL preserve DSH layer precedence: generated bundle layers are reread, the profile patch and home patch are reapplied, and invocation overlays remain in force. A profile patch override SHALL continue to win over the generated layer after reload.

#### Scenario: Profile patch override wins after reload
- **WHEN** the profile patch overrides a row that the new generation changes
- **THEN** the running composition uses the profile patch value

#### Scenario: GUI edit is not lost
- **WHEN** a plugin toggle is written to the profile patch while a generation is published
- **THEN** both changes settle with the profile patch still effective

### Requirement: Reload failures are contained
An unreadable or malformed generation record, or a reconciliation failure, SHALL be reported without terminating the process. The watcher SHALL remain registered so a later valid generation can be applied.

#### Scenario: Malformed generation record is reported
- **WHEN** the generation record cannot be parsed
- **THEN** the watcher reports the failure and the process keeps running

#### Scenario: Later generation recovers
- **WHEN** a malformed generation is followed by a valid one
- **THEN** the valid generation is applied

### Requirement: Restart-required outcomes are surfaced
When reconciliation reports that a change requires a restart, the watcher SHALL report that outcome. The system SHALL NOT claim that such a change was hot-reloaded.

#### Scenario: Pending module reports restart
- **WHEN** reconciliation reports pending modules or a restart reason
- **THEN** the watcher reports a restart-required diagnostic

#### Scenario: Hot reload claim is limited to applied changes
- **WHEN** reconciliation applies a patch-layer change without a restart reason
- **THEN** no restart-required diagnostic is reported

### Requirement: Only published generations trigger reload
The runtime SHALL NOT evaluate the TypeScript configuration. Editing the configuration file without publishing a new generation SHALL NOT reload the running composition.

#### Scenario: Config edit alone does nothing
- **WHEN** the author edits the TypeScript configuration without running a publish command
- **THEN** the running composition is unchanged

#### Scenario: Publish triggers reload
- **WHEN** the author publishes a new generation after editing the configuration
- **THEN** the watcher reloads the published generation

### Requirement: HMR-disabled surfaces apply changes on restart
A profile composed without HMR SHALL continue to run its current composition after a new generation is published. The new generation SHALL take effect on the next process start.

#### Scenario: No hot reload without HMR
- **WHEN** a generation is published while an HMR-disabled profile is running
- **THEN** the running composition remains unchanged

#### Scenario: Next boot uses the new generation
- **WHEN** that profile starts again
- **THEN** it composes the published generation

### Requirement: The runtime records the running installation anchor

On every profile boot that provides `profileContext`, `@eedsh/runtime` SHALL write or refresh `$DSH_HOME/.eedsh/installation.json` from `profileContext.installAnchor` and `profileContext.home`, even without HMR. The runtime SHALL validate that the anchor names `@deepseek-ai/dsh` with a readable version.

#### Scenario: HMR-enabled boot refreshes the anchor

- **WHEN** an eedsh-managed profile with profile context and HMR boots
- **THEN** the runtime writes or refreshes the installation anchor from `profileContext.installAnchor`
- **AND** the watcher still registers as before

#### Scenario: HMR-disabled boot still records the anchor

- **WHEN** an eedsh-managed profile boots with profile context but no HMR service
- **THEN** the runtime still writes or refreshes the installation anchor
- **AND** no generated-layer watcher is registered

#### Scenario: Invalid anchor is not recorded

- **WHEN** `profileContext.installAnchor` does not name `@deepseek-ai/dsh`, cannot be read, or declares no version
- **THEN** the runtime warns and writes no anchor
- **AND** the profile continues to boot

#### Scenario: Upgrade refreshes the recorded installation

- **WHEN** a profile boots after the user's DSH installation changes path or version
- **THEN** the runtime replaces the anchor with the new `installAnchor`
- **AND** the next `eedsh sync` can use the refreshed anchor

### Requirement: Anchor recording never fails the profile

A missing `profileContext` SHALL write nothing. A failed anchor write SHALL be reported and SHALL NOT fail or alter the profile. The runtime SHALL preserve the existing watcher behavior and HMR registration requirements.

#### Scenario: Non-profile boot writes nothing

- **WHEN** the runtime loads without `profileContext`
- **THEN** it does not write an installation anchor
- **AND** the composition continues to boot normally

#### Scenario: Anchor write failure does not fail the profile

- **WHEN** the runtime cannot create or write the anchor cache
- **THEN** it reports the failure
- **AND** the profile continues to boot unchanged
