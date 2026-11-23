## Why

The CLI still decodes the installation-anchor inputs by hand: the anchor record validator lives in the Effect-free runtime while the CLI is its only production reader, and the DSH package manifest and pnpm metadata are walked with ad-hoc `typeof` checks. That contradicts the repository's stated convention that CLI external contracts are decoded with `effect/Schema`, and it leaves the format rules split from the reader that enforces them.

## What Changes

- Move the installation-anchor record codec from `@eedsh/runtime/installation-anchor` into `packages/cli/src/installation-anchor.ts` as an Effect Schema. The runtime keeps the record type, format constant, path helpers, encoder, and atomic writer; its unused `decodeInstallationAnchor`, `validateInstallationAnchorValue`, and `readInstallationAnchorFile` exports are removed.
- Preserve the existing decode reasons and validation order by decoding once with `Schema.decodeUnknownResult` and mapping the first issue path, following the generation-record precedent.
- Replace the DSH `package.json` walk in `packages/cli/src/installation-anchor.ts` with a Schema record decode plus leaf readers for `name`, `version`, `bin`, and `main`, preserving the current messages and fallbacks (string bin, `bin.dsh`, `main`, then `lib/bin.js`).
- Replace the pnpm metadata object walk in `packages/cli/src/dsh-bootstrap.ts` with tolerant Schema structs, keeping the current "skip malformed roots/entries, keep valid siblings" behavior.
- Update `packages/cli/src/dsh-discovery.ts` and `packages/cli/src/init.ts` for the new manifest record and CLI-owned decoder; update the runtime README's description of the subpath.
- Move the record-codec tests from `packages/runtime/test/installation-anchor.test.ts` to `packages/cli/test/installation-anchor.test.ts`, and add bootstrap and manifest parity cases.

## Capabilities

No capabilities are added or modified. This is a pure refactor with no spec-level behavior change, so the change sets `skip_specs: true`.

### New Capabilities
- None.

### Modified Capabilities
- None.

## Impact

- **Code:** `packages/cli/src/installation-anchor.ts`, `packages/cli/src/dsh-bootstrap.ts`, `packages/cli/src/dsh-discovery.ts`, `packages/cli/src/init.ts`, `packages/cli/src/internal/schema-readers.ts`, `packages/runtime/src/installation-anchor.ts`.
- **Tests:** `packages/cli/test/installation-anchor.test.ts`, `packages/cli/test/dsh-bootstrap.test.ts`, `packages/runtime/test/installation-anchor.test.ts`; existing discovery/init tests remain the acceptance contract.
- **Docs:** `packages/runtime/README.md` only; the root README already documents the CLI Schema convention.
- **Dependencies:** none; `effect@4.0.6` is already a CLI dependency.
- **Compatibility:** no on-disk anchor format, path, CLI flag, exit code, or intended diagnostic change. The runtime subpath stops exporting read-side helpers that have no production runtime callers.
- **Out of scope:** the remaining hand-rolled readers in the REPL, preview, and provisioning modules; those can follow in a separate change.
