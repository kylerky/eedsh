## Why

eedsh is preparing for its first public release, but the root README still reads like an internal development guide, and its tested example is only a copied fixture, so the documentation can drift from the test. The package README that ships with `@eedsh/cli` is also behind the shipped CLI: no `doctor` or `--adopt-ownership`, the old plan layout and `path: message` errors, and a deferred-packaging claim.

## What Changes

- Reorder the root README for a public audience: install and CLI usage first; build-from-source, development, and architecture last.
- Add an Install section for the published packages: Node.js >= 26, pnpm on PATH, `npm install -g @eedsh/cli`, and `npm install --save-dev @eedsh/config` in the project that holds the config, plus `typescript` for `eedsh check`. No pre-release warnings or "not yet published" caveats.
- Add a runnable Quick start with a minimal `eedsh.config.ts` (real DSH bundles and existing patch targets), `eedsh sync`, `eedsh doctor`, `eedsh run -- --port 3080`, and the published profile location.
- Add a dedicated Example configuration section with the fuller annotated config (bundle stack, `generated()`, a profile-local package, `insert`, `disable`, `override`, `js`) and a patch-helper reference table.
- Move the CLI reference up; add `--explain` to the `sync` synopsis, describe it, and remove the duplicated `check` prose.
- Keep the technical sections (layer model, what `sync` writes, publication guarantees, ownership, hot reload, Effect boundaries) but relocate them after the user-facing material.
- Move `pnpm install` / `pnpm build` and the TypeScript 7 / tsdown details to the back under Build from source and Development.
- Remove `published npm packaging` from Deferred, since the README now documents the published install.
- Bring `packages/cli/README.md` in line with the shipped CLI: add `doctor` and `--adopt-ownership`, fix the exit-code and native-error text, document the authoritative plan and mirror, update the publication guarantees, note dependency-section cleanup, remove the deferred-packaging limitation, correct `@effect/cli` to `effect/cli`, and add a one-line pointer to the root README.
- Add a shared `test/support/readme.ts` helper that extracts the `ts` blocks under `## Quick start` and `## Example configuration`, evaluates them as temporary modules through Vitest, validates the plans, and cleans up. Replace the fixture-based tests with this helper, delete `packages/cli/test/fixtures/readme/eedsh.config.ts`, and keep the full example's canonical JSON/hash constants by deriving the plan from the README.

## Capabilities

### New Capabilities

None. This is a documentation and documentation-test change; no runtime or externally observable behavior changes. `.openspec.yaml` sets `skip_specs: true`.

### Modified Capabilities

None.

## Impact

- `README.md`, `packages/cli/README.md`, `packages/cli/test/cli.test.ts`, `packages/config/test/plan/hash-parity.test.ts`, and the new `test/support/readme.ts`; delete `packages/cli/test/fixtures/readme/eedsh.config.ts`. No production source, package metadata, or release automation change.
- Assumes `@eedsh/cli` and `@eedsh/config` are published (or will be) so the install commands are accurate; package publication itself is out of scope.
- The root README's full example remains plan-identical to the pinned canonical JSON and hash; the hash test now derives the plan from the README.
- `packages/config/README.md` and `packages/runtime/README.md` remain out of scope.
