## Why

`eedsh sync` builds a generation identifier from the canonical plan and the emitted patch layers. The generation record adds environment provenance outside that hash: `eedshVersion` and the exact discovered `dshVersion`. After a DSH upgrade the plan and identifier are unchanged, so the unchanged check treated the run as a no-op and kept the old `dshVersion`. The runtime's drift warning therefore recommended `eedsh sync`, but running it did not clear the warning.

The chosen product direction is to keep syncing manual: after a DSH upgrade the user runs `eedsh sync`, and that sync must actually refresh the published generation's provenance. No automatic sync runs from the runtime.

## What Changes

- The materialization unchanged check also compares the record's `dshVersion` and `eedshVersion` with the current invocation. When they differ, sync takes the normal publication path: reconcile, install if dependencies changed, preflight against the running installation, and commit the same generation identifier with a refreshed generation record.
- No runtime, config, plan, or generation-format change. The runtime keeps its existing drift warning, which now names a remedy that works.
- Document the behavior in the root and CLI READMEs.

## Capabilities

### Modified Capabilities
- `generated-profile-materialization`: the unchanged check covers the record's DSH and eedsh provenance, so a provenance refresh republishes the same generation instead of reporting "unchanged".

## Impact

- **CLI**: `materialize` compares two more record fields; publication, locking, preflight, and artifact layout are unchanged.
- **Artifacts**: only the generation record and generated package manifest are rewritten on a provenance-only refresh; patch files, the authoritative plan, the plan mirror, and the provenance sidecar are unchanged.
- **Runtime**: no change; its existing warning still recommends `eedsh sync`, which now converges the record.
- **Existing profiles**: the first sync after a DSH or eedsh upgrade republishes with the same generation identifier; nothing is migrated or deleted.
