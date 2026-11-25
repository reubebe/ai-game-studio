# Security notes

## Closed: picomatch ReDoS advisory (GHSA-fc5q-39xc-vjpf)

| Item | Status (checked 2026-11-18, 17:40 UTC) |
|---|---|
| Advisory | [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), "ReDoS through single-branch repeated extglobs" |
| Current state | **Withdrawn by GitHub on 2026-11-18 at 15:38 UTC.** The notice points to the picomatch maintainers' discussion in [PR #235](https://github.com/micromatch/picomatch/pull/235) |
| picomatch in this repo | 4.0.7 (unchanged), through `vite`, `vitest`, `tinyglobby` and `fdir`, all development tooling |
| `npm audit` | 0 vulnerabilities (full tree, development dependencies included) |

Nothing was changed in the repository to close this: no override, no downgrade. Before the withdrawal
there was no patched release to move to, and the only automatic fix on offer (downgrading Vitest) would
not have removed Vite's copy. picomatch only ever evaluated glob patterns written by developers in build
and test configuration, and it is not bundled into the desktop app.
