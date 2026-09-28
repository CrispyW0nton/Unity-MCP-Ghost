# Unity 6000.5 compatibility and Dolphin Cove conversion

The Sirica conversion uses the embedded Ghost package on Unity 6000.5.9f1 through MCPStudio's fixed private host.

## Branch publication — September 27, 2026

This development snapshot is published on `codex/unity-6000.5-compatibility`, not `main`, at the user's request. The conversion evidence below predates this publication check and is not a fresh certification run.

- Passed: `npm run typecheck`, `npm run lint`, `npm run format:check` (after formatting the authoring registration), `npm run release:check`, `npm run test:protocol` (10/10), `npm audit --audit-level=high` (zero vulnerabilities), and `git diff --check`.
- `npm test`: 526/527 passed. The Windows version-probe timeout test failed because its fixture did not create its descendant before the deadline. An isolated rerun, `node --import tsx --test server/test/unityVersionProbe.test.ts`, passed 16/16. This is not a fully green rerun of the entire suite.
- `npm run test:unity:editmode`: failed compilation on Unity 2022.3.62f1. `TestRunnerApi.UnregisterTestCallback` and `TestRunnerApi.CancelTestRun` are unavailable in that fixture's Test Framework. Earlier object-ID fallback code does not make the whole package compatible with the older fixture.
- No Unity 6000.5.9f1 native suite was rerun for publication. The checked local Hub installations contain 2022.3.62f1, 6000.3.2f1, and 6000.3.5f2. The existing test-project version, CI configuration, and package metadata are not a new 6.5 certification matrix.
- Known development limitation: the Windows build handler currently names its executable `DolphinCove.exe`; the generic build-name contract does not yet control that filename. iOS support is implemented but not certified by the Windows conversion evidence.

The raw `conversion-node-tests.log` stays local and is excluded from the commit. No Unity caches, credentials, or course assets are added by this publication.

## Changes

- `ObjectIdentity`: Unity 6.5 EntityId values map to opaque integer protocol handles; native objects resolve through `EditorUtility.EntityIdToObject`. The monotonic handle counter persists in SessionState. Earlier editors retain the original instance-ID implementation. Unity object wrappers are not held through unsupported WeakReference assumptions.
- `editor_state_get`: reports saved/dirty scene state and the latest compile generation state so the caller can gate play/test/build.
- `build_player` / `player.build`: Windows64 build of an existing saved Assets scene into a new contained `Builds/<buildName>` folder. The tool rejects overwrite, invalid names, dirty scenes and busy editors. It returns the actual BuildReport result, warnings/errors and bytes.
- `GhostTestRunRecovery`: reattaches native test tracking after test-framework domain reloads. OperationStore can reattach a live poller without replacing durable metadata. Completion comes from native test results, not elapsed time.

## Evidence and limits

`npm test`: 527 tests passed. TypeScript build and catalog checks passed (91 tools / 58 direct mappings). The DolphinCove native game suite passed 11 tests, including a play-mode transition inside an EditMode UnityTest; its operation remained observable across reloads. A standalone Windows build completed through the host and the resulting player was launched.

The new native ObjectIdentity test source is present, but the consumer project's filter matched zero tests because that package test assembly was not included. This is not reported as a passing native test. Real authoring calls exercised handles during this conversion.

MCPStudio must provide a sufficiently long native request timeout for builds; its original 30-second default expired just before the first successful build completed. That unknown result was reconciled from the durable native response and editor log. A fresh build then returned normally after the host deadline fix. Do not replay uncertain builds into existing outputs.

This is Windows project-specific evidence, not a Mac build or universal Studio containment qualification. Existing unrelated `docs/progress.md` work was not changed.
