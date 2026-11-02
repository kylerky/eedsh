## MODIFIED Requirements

### Requirement: Doctor verifies record, plan, and mirror consistency
Doctor SHALL verify that the record's managed bundle order and plan-declared package specifications agree with the authoritative plan, and that `.eedsh/plan.json` contains the same plan. An inconsistent record and plan SHALL be an error; a missing or differing mirror SHALL be a warning. The provenance sidecar SHALL NOT participate in this check: an absent, unreadable, or generation-mismatched sidecar SHALL NOT produce a finding and SHALL NOT change the exit status.

#### Scenario: Record disagrees with the plan
- **WHEN** the record's managed bundle order or plan package specifications differ from the authoritative plan
- **THEN** doctor reports an error identifying the inconsistency

#### Scenario: Mirror differs
- **WHEN** `.eedsh/plan.json` is missing or contains a different plan
- **THEN** doctor reports a warning naming the mirror path
- **AND** does not modify the file

#### Scenario: Provenance sidecar is advisory
- **WHEN** `.eedsh/provenance.json` is missing, malformed, or names a different generation
- **THEN** doctor reports no finding for it
- **AND** the command exit status is unaffected
