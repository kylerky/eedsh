# Manual acceptance: a real source bundle

This note records how to accept source provisioning against a real,
unpublished bundle. The motivating case is `dsh-superagent-prototype`: it is
not published, its build output is gitignored, and its manifest declares no
`prepare` script, so `pnpm install` alone never produces a bootable package.

## Prerequisites

- A checked-out eedsh workspace with `pnpm verify` passing.
- `git` on `PATH` and network access to the prototype repository (or a local
  `file://` clone of it).
- A DSH profile with a web client, such as the one `eedsh init` creates.

## Config

Declare the prototype as a source dependency and select its bundle. The
`.source()` call provisions and builds the checkout; `.bundle()` selects the
bundle it contributes, which a source declaration does not do on its own.

```ts
import { defineConfig } from '@eedsh/config'

export default defineConfig()
  .profile('work', (profile) => {
    profile
      .bundle('dsh-superagent-prototype')
      .source('dsh-superagent-prototype', {
        from: 'git@github.com:<owner>/dsh-superagent-prototype.git',
        ref: 'main',
      })
      .generated()
      .layer('prototype-state', (layer) => {
        // Point the prototype at a state directory outside the profile so a
        // re-sync does not move the session state.
        layer.override('superagent', {
          stateDir: '/absolute/path/to/superagent-state',
        })
      })
  })
  .build()
```

The git source defaults to `[['pnpm', 'install'], ['pnpm', 'run', 'build']]`.
Use an explicit `prepare` list when the repository builds some other way.

## Run

```sh
eedsh sync --config ~/.config/eedsh/config.ts --rebuild
```

Then boot the profile and open the web client:

```sh
eedsh run --config ~/.config/eedsh/config.ts
```

## What to observe

1. **Checkout.** `$DSH_HOME/.local/sources/<key>/lib` exists and is newer than
   the clone: the default preparation ran. `$DSH_HOME/.local/state/sources/<key>.json`
   records the resolved commit and the steps that ran.
2. **Link.** The profile manifest declares
   `"dsh-superagent-prototype": "link:$DSH_HOME/.local/sources/<key>"`.
   `eedsh doctor` reports no source error.
3. **Entry points.** The checkout's `package.json` names the package, its main
   entry exists, and its `./client` export exists (the prototype declares
   `dsh.client`). A missing build fails the sync naming the package and path.
4. **stateDir override.** The prototype writes its state to the configured
   `stateDir`, not into the profile or the checkout.
5. **Sidebar panel.** After boot and a page load, the prototype's panel appears
   in the web client's sidebar. Opening it exercises the client bundle the
   preparation built.
6. **Idempotence.** Running `eedsh sync` again reports no source change and
   runs no preparation. `eedsh sync --rebuild` runs the steps again.

## Notes

- `eedsh sync --no-build` fails with `provision.no_build` naming the source and
  the commands it would run when the checkout needs preparation; use it in
  environments that must not run builds.
- If the remote is unreachable, a sync with a checkout and record warns and
  keeps the recorded commit. A missing checkout fails and names the source.
- Removing the `.source()` declaration and syncing removes the dependency from
  the manifest but leaves the checkout in place.
