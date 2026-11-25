# Implementation plan

| Gate | Deliverable | Acceptance | State |
|---|---|---|---|
| 0 | Monorepo, docs, tests | typecheck + tests pass | Done |
| 1 | Desktop shell, project CRUD, recents, settings | project survives restart and reopen in the real app | Verified (desktop self-test, UI tests) |
| 2 | Godot bridge | template imports, runs headlessly, editor opens without script errors | Verified with Godot 4.7.2 |
| 3 | Oware slice | sourced variant, 30+ tests, replay, undo | Verified (64 tests) |
| 4 | Visual rules | node edit changes gameplay | Verified (unit tests, UI tests, desktop self-test) |
| 5 | Agent execution | scoped edit, diff, rollback | Verified (local model inside the desktop app, UI tests) |
| 6 | Genre foundations | RPG, education, XR, C++ | Foundations built and tested |
| 7 | XR | headset test | Blocked: no headset or OpenXR runtime on this Mac |
| 8a | Unity adapter | create, open, build for macOS, built game passes its self-test | Verified with Unity 6000.6.9f1 (integration test, desktop self-test) |
| 8b | Unreal adapter | compile, open, package for macOS, packaged game passes its self-test | Verified with Unreal Engine 5.8.4 (integration test, desktop self-test) |
| 9 | Godot export | macOS app exported from the studio passes its own self-test | Verified (integration test, desktop self-test) |

Next tasks: C# and C++ ports of the rules VM so Unity and Unreal run the same compiled rules (target: the 22 conformance steps in each); Windows, Linux and Web exports (the templates are installed, but those builds cannot be run on this Mac); Ayò and Ludo rule domains; a 3D viewport preview inside the studio.
