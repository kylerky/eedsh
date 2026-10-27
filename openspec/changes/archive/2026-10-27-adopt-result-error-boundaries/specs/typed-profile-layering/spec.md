## REMOVED Requirements

### Requirement: Validation uses Effect-native results and errors

**Reason**: The requirement names Effect `Either` and a throwing authoring boundary that no longer exist. The `profile-plan-validation` capability owns the `Result` contract and the synchronous authoring entry point.

**Migration**: Use `validatePlan` for a `Result<ProfilePlan, Schema.SchemaError>` and `defineProfile` for synchronous Result-returning authoring. See the `profile-plan-validation` specification.
