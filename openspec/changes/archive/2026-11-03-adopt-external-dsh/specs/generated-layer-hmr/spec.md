## MODIFIED Requirements

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

## ADDED Requirements

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
