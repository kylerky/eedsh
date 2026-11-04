## ADDED Requirements

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
