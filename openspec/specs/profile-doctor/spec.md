# profile-doctor Specification

## Purpose

Defines the read-only `eedsh doctor` command: how it selects a published profile, which integrity and installed-resolution checks it performs, how it reports findings, and the exit status callers can rely on. Doctor diagnoses; it never repairs.

## Requirements

### Requirement: Doctor is read-only

`eedsh doctor` SHALL NOT create, modify, or delete any profile file, directory, lock, package, or generated artifact. It SHALL NOT acquire the sync lock and SHALL NOT require the pinned DSH installation to be present.

#### Scenario: Doctor leaves the profile unchanged

- **WHEN** doctor runs against a valid published profile
- **THEN** every profile file has the same bytes before and after
- **AND** no lock file is created or left behind

#### Scenario: Doctor does not need the DSH installation

- **WHEN** the pinned DSH installation is unavailable
- **THEN** doctor still inspects the selected profile

### Requirement: Doctor selects one published profile

Doctor SHALL inspect the profile named by `--profile <name>` or, without that flag, the profile named by the discovered config. When `--profile` is given, doctor SHALL NOT evaluate a config; otherwise it SHALL use config evaluation only to obtain the profile name and SHALL NOT report unpublished config changes. `--profile` and `--config` SHALL be mutually exclusive.

#### Scenario: Doctor inspects without the config

- **WHEN** the user runs `eedsh doctor --profile work`
- **THEN** doctor does not evaluate an eedsh config
- **AND** it inspects the `work` profile under the resolved DSH home

#### Scenario: Doctor discovers the profile from the config

- **WHEN** the user runs `eedsh doctor` in a directory containing a config
- **THEN** doctor obtains the profile name from that config
- **AND** inspects the published profile

#### Scenario: Profile and config are mutually exclusive

- **WHEN** the user supplies both `--profile` and `--config`
- **THEN** doctor reports a usage error and exits with status 2

#### Scenario: Selected profile does not exist

- **WHEN** the selected profile directory does not exist
- **THEN** doctor reports an error and exits with status 1

### Requirement: Doctor validates the generation record

Doctor SHALL read the generated package manifest and validate its eedsh generation record: format, version, generation identifier, plan hash, and non-empty managed bundles and package specifications. A missing, malformed, foreign, empty, or unsupported-version record SHALL be an error. An unsupported newer version SHALL name the required eedsh upgrade and SHALL NOT suggest ownership adoption.

#### Scenario: Missing record

- **WHEN** the selected profile has no readable generation record
- **THEN** doctor reports an error naming the record path
- **AND** exits with status 1

#### Scenario: Unsupported record version

- **WHEN** the record declares a version newer than the command supports
- **THEN** doctor reports an error instructing the user to upgrade eedsh
- **AND** does not suggest `--adopt-ownership`

#### Scenario: Valid record

- **WHEN** the record satisfies the generation-record contract
- **THEN** doctor continues with the remaining checks

### Requirement: Doctor verifies the authoritative plan

Doctor SHALL verify that `.eedsh/generated/plans/<generationId>.json` exists, contains the canonical plan whose content hashes to the record's plan hash, and decodes as a valid profile plan. A missing plan SHALL be a warning; a wrong hash or invalid content SHALL be an error.

#### Scenario: Missing authoritative plan

- **WHEN** the record is valid but its plan file is absent
- **THEN** doctor reports a warning that `eedsh sync` republishes it
- **AND** exits with status 0 unless `--strict` is set

#### Scenario: Corrupt authoritative plan

- **WHEN** the plan file's canonical content does not hash to the record's plan hash or the file is not a valid plan
- **THEN** doctor reports an error
- **AND** exits with status 1

### Requirement: Doctor verifies record, plan, and mirror consistency

Doctor SHALL verify that the record's managed bundle order and plan-declared package specifications agree with the authoritative plan, and that `.eedsh/plan.json` contains the same plan. An inconsistent record and plan SHALL be an error; a missing or differing mirror SHALL be a warning.

#### Scenario: Record disagrees with the plan

- **WHEN** the record's managed bundle order or plan package specifications differ from the authoritative plan
- **THEN** doctor reports an error identifying the inconsistency

#### Scenario: Mirror differs

- **WHEN** `.eedsh/plan.json` is missing or contains a different plan
- **THEN** doctor reports a warning naming the mirror path
- **AND** does not modify the file

### Requirement: Doctor verifies managed manifest entries

Doctor SHALL verify that every managed bundle appears in `dsh.profile.bundles` in the recorded order, and every managed package appears in `dependencies` with the recorded specification. A missing or conflicting managed entry SHALL be an error.

#### Scenario: Managed dependency removed by hand

- **WHEN** the manifest omits a managed package from `dependencies`
- **THEN** doctor reports an error identifying the package
- **AND** exits with status 1

#### Scenario: Managed bundle out of order

- **WHEN** the managed bundles appear in a different order than the record
- **THEN** doctor reports an error identifying the ordering

### Requirement: Doctor reports dependency-section conflicts

Doctor SHALL report managed names declared in `devDependencies` or `optionalDependencies` as warnings, and managed names in `peerDependencies`, `pnpm.overrides`, `overrides`, or `resolutions` as warnings. Doctor SHALL NOT modify any dependency section.

#### Scenario: Duplicate section declaration

- **WHEN** a managed package is also declared in `devDependencies`
- **THEN** doctor reports a warning naming the package and the section
- **AND** leaves the file unchanged

#### Scenario: Override names a managed package

- **WHEN** `pnpm.overrides`, `overrides`, or `resolutions` names a managed package
- **THEN** doctor reports a warning that the resolved version may differ

### Requirement: Doctor verifies the lockfile

Doctor SHALL read `pnpm-lock.yaml` and verify that every managed package is recorded in the root importer with the recorded specification and a resolved version that satisfies the specification when it is a semantic-version range. A missing lockfile, missing entry, or out-of-range version SHALL be an error.

#### Scenario: Resolved version falls outside the managed range

- **WHEN** a managed package's lockfile version falls outside the recorded semver range
- **THEN** doctor reports an error naming the package, the recorded range, and the resolved version
- **AND** exits with status 1

#### Scenario: Package missing from the lockfile

- **WHEN** the root importer has no entry for a managed package
- **THEN** doctor reports an error
- **AND** exits with status 1

#### Scenario: Lockfile absent

- **WHEN** the profile has no `pnpm-lock.yaml`
- **THEN** doctor reports an error that the installed state cannot be verified

### Requirement: Doctor verifies installed packages

Doctor SHALL verify that each managed package is installed and resolvable from the profile and that its installed version matches the lockfile. A missing installation or version mismatch SHALL be an error. Non-semver specifications such as `link:`, `file:`, and `workspace:` SHALL be checked for presence and reported without a range check.

#### Scenario: Package not installed

- **WHEN** a managed package cannot be resolved from the profile
- **THEN** doctor reports an error
- **AND** exits with status 1

#### Scenario: Installed version differs from the lockfile

- **WHEN** a managed package's installed version differs from its lockfile version
- **THEN** doctor reports an error naming both versions

#### Scenario: Linked package

- **WHEN** a managed package uses a `link:` specification and its target exists
- **THEN** doctor reports the resolved version without a range error

### Requirement: Doctor reports a consistent snapshot

Doctor SHALL read the generation identifier before and after its checks. If the identifier changes while doctor is running, doctor SHALL report an error asking the user to rerun it and SHALL NOT present the partial result as a clean profile.

#### Scenario: Sync publishes during diagnosis

- **WHEN** a sync publishes a new generation while doctor is running
- **THEN** doctor reports that the profile changed during diagnosis
- **AND** exits with status 1

### Requirement: Doctor reports findings and exit status

Doctor SHALL print each finding with a stable severity of `error` or `warning`, the affected path or package, and the check that produced it, followed by a summary. It SHALL exit 0 when there are no errors, 1 when there is at least one error, and, with `--strict`, 1 when there is at least one warning. Usage errors SHALL exit 2. Doctor SHALL NOT repair the profile; findings SHALL name the command that can, `eedsh sync` or `eedsh sync --adopt-ownership`.

#### Scenario: Clean profile

- **WHEN** every check passes
- **THEN** doctor prints a clean summary
- **AND** exits with status 0

#### Scenario: Warnings without strict

- **WHEN** doctor finds only warnings and `--strict` is absent
- **THEN** doctor exits with status 0

#### Scenario: Warnings with strict

- **WHEN** doctor finds only warnings and `--strict` is present
- **THEN** doctor exits with status 1

#### Scenario: Error exits

- **WHEN** doctor finds an error
- **THEN** doctor exits with status 1
- **AND** the output names the command that can repair it