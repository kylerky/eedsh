## MODIFIED Requirements

### Requirement: Doctor selects one published profile

Doctor SHALL inspect the profile named by `--profile <name>`. When `--profile` is given, doctor SHALL NOT evaluate a config. Without `--profile`, doctor SHALL evaluate the config, select the default profile when one is declared, otherwise the sole profile, and inspect that published profile. When the config declares more than one profile and no default, doctor SHALL report a usage error and exit 2, listing the available profile names. `--profile` and `--config` SHALL remain mutually exclusive. Config evaluation SHALL be used only to obtain the profile name and SHALL NOT report unpublished config changes. An invalid profile plan SHALL NOT prevent doctor from inspecting that published profile by name.

#### Scenario: Doctor inspects without the config

- **WHEN** the user runs `eedsh doctor --profile work`
- **THEN** doctor does not evaluate an eedsh config
- **AND** it inspects the `work` profile under the resolved DSH home

#### Scenario: Doctor discovers the profile from the config

- **WHEN** the user runs `eedsh doctor` and the XDG config declares one profile or a default
- **THEN** doctor obtains that profile name from the config
- **AND** inspects the published profile

#### Scenario: Ambiguous profile selection is a usage error

- **WHEN** the config declares several profiles, no default, and the user runs `eedsh doctor` without `--profile`
- **THEN** doctor reports a usage error
- **AND** lists the available profile names
- **AND** exits with status 2

#### Scenario: Profile and config are mutually exclusive

- **WHEN** the user supplies both `--profile` and `--config`
- **THEN** doctor reports a usage error and exits with status 2

#### Scenario: Selected profile does not exist

- **WHEN** the selected profile directory does not exist
- **THEN** doctor reports an error and exits with status 1

#### Scenario: Invalid plan does not block diagnosis

- **WHEN** the selected profile's plan is invalid but its published profile exists
- **THEN** doctor inspects the published profile by name
- **AND** does not fail solely because the plan is invalid
