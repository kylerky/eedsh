## REMOVED Requirements

### Requirement: One config declares named profiles with a shared DSH pin

**Reason**: The config no longer declares a DSH value. Discovery selects the installation, and the profile plan no longer has a DSH field.

**Migration**: Delete `.dsh(...)` from the config. No replacement value is needed.

### Requirement: Config-level defects fail the whole config

**Reason**: DSH range defects no longer exist, and a legacy `dsh` field is an unsupported config field rather than a range to validate.

**Migration**: Delete `.dsh(...)` and any plain-config `dsh` field.

## ADDED Requirements

### Requirement: One config declares named profiles without a DSH value

The authoring surface SHALL accept an optional default profile name and a record of named profiles. Each key SHALL be a safe profile name and the profile's sole identity. Each profile SHALL accept ordered bundles, ordered layers, and package dependencies. The config SHALL NOT accept a DSH value or require one. Records built dynamically from spreads, computed keys, loops, or environment values SHALL be accepted.

#### Scenario: Several profiles produce separate plans

- **WHEN** a config declares profiles `work` and `home`
- **THEN** eedsh produces one profile plan for `work` and one for `home`

#### Scenario: No DSH value is required

- **WHEN** a config declares a profile and no DSH value
- **THEN** the config validates

#### Scenario: The record key is the profile name

- **WHEN** a profile is declared under the key `work`
- **THEN** its plan names the profile `work`

#### Scenario: Profiles can be built dynamically

- **WHEN** a config constructs its profile record with a spread or a computed key
- **THEN** every resulting key produces a profile with that key as its name

### Requirement: Config-level defects fail the whole config before publication

Config-level defects SHALL fail the whole config before any profile is selected or published: a legacy `dsh` field, an empty profile record, an unsafe profile key, or a default profile name that is not a key. The failure SHALL be Effect's native schema failure, the command SHALL exit 1, and no profile SHALL be published or booted.

#### Scenario: Empty profile record is rejected

- **WHEN** a config declares no profiles
- **THEN** the command exits 1 with the native schema failure
- **AND** no profile is published or booted

#### Scenario: Unsafe profile key is rejected

- **WHEN** a profile key is empty, contains a path separator, or is otherwise unusable as a profile directory
- **THEN** the command exits 1 with the native schema failure identifying the key

#### Scenario: Unknown default profile is rejected

- **WHEN** `defaultProfile` names a key that is not declared
- **THEN** the command exits 1 with the native schema failure identifying the default name

#### Scenario: Legacy DSH value is rejected

- **WHEN** a config supplies a `dsh` field or calls the removed `.dsh()` method
- **THEN** the config does not validate
- **AND** the diagnostic identifies the unsupported DSH value
