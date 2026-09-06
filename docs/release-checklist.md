# Unity MCP Ghost release checklist

## Candidate

- Version: `0.2.0-rc.1`
- Supported baseline: Unity `2022.3.62f1` on Windows; Node.js 20, 22, and 24 are configured in CI.
- Status: implementation and final complete-series verification are incomplete; this checklist is not a release certificate.
- Target qualification, only after every required local gate in [the approved completion contract](course-ready-local-rc-goal.md) passes: **Locally verified Course-Ready release candidate; remote CI and real course-project certification pending.**

Do not advertise macOS, Linux, Unity 2021, Unity 6, or another Unity 2022 patch as certified until the exact matrix result is observed green and recorded in `docs/progress.md`. Do not add a CI badge until that workflow has actually passed in the repository.

## Release gates

From a clean checkout:

On Windows 10+, install PowerShell 7, ensure `pwsh.exe` is on PATH and permit `Add-Type` before running the tests. Version probes assign a Windows Job Object atomically before the executable runs; success requires observed root exit and an empty job. Other owned-process cleanup uses .NET process-tree termination. Helper failures remain failed gates even when the root process exits. Regressions include root-first exit, cancellation, timeout, supervisor loss, real descendants and an unrelated sentinel process. This fixed runner helper is not a sandbox for hostile executables and is not exposed as an MCP arbitrary-code capability.

```text
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
npm run test:protocol
npm run test:unity:concurrent
npm run test:unity:concurrent:cancel
npm run test:unity:editmode
npm run test:unity:playmode
npm audit --audit-level=high
npm run release:check
npm run release:pack
git diff --check
```

With the repository fixture open in Unity and its authenticated bridge active, also run:

```text
npm run smoke:security -- --unity-project-path test-project
npm run smoke:runtime -- --unity-project-path test-project
npm run smoke:scenario -- --unity-project-path test-project --request-timeout-ms 60000
npm run phase3:repair-smoke -- --request-timeout-ms 60000
npm run test:course
```

Confirm success, failure, timeout, cancellation, and reload paths restore the fixture source hash and leave zero retained source transactions. The evidence directories under `test-project/Library/UnityMcpGhost/evidence` are local build evidence and must not be committed.

`npm run test:course:live` starts an owned fixture Editor, runs the course suite, and closes that Editor. Do not run it against a fixture already open in another Editor. It must not remove or adopt another Editor's identity. The standalone Unity test runners check the actual executable's `-version` output and require a fresh, nonempty NUnit result with every test passed; an exit code alone is not certification. Each run keeps its uniquely named XML and log evidence. Historical `editmode-results.xml` and `playmode-results.xml` aliases are no longer updated or used: consumers must use the invocation's printed paths and successful command result. No historical evidence is deleted by this change.

Standalone EditMode/PlayMode runs default to a 20-minute work deadline, including executable verification. Set `UNITY_TEST_TIMEOUT_MS` to a positive integer no greater than `3600000` to adjust it. Cancellation via SIGINT/SIGTERM or deadline expiry fails the command and still waits for bounded cleanup of the owned Editor, so process cleanup can extend the wall-clock duration beyond the work deadline. A cleanup failure remains an error even if the root exits. Inspect the unique log and XML paths reported on success or failure; early failures can occur before those files are created. Do not use an older aggregate XML or a green XML from a command that failed cleanup as certification.

## Package and secret review

- `npm run check:catalog` reports 90 current tools and the generated C# parity test passes.
- `dist/index.js`, root legal/security/change files, and the UPM package legal/change files are present.
- Root npm, TypeScript, Unity C#, and UPM versions agree.
- The UPM manifest pins Newtonsoft and narrows its advertised Unity baseline to `2022.3.62f1` (`unity: 2022.3`, `unityRelease: 62f1`).
- No token, identity file, `Library/`, `Logs/`, `Temp/`, `UserSettings/`, course asset, or evidence bundle is tracked.
- `npm pack --dry-run` contains only the intended server distribution.

## Installation and migration

Install the UPM package from the repository subdirectory and build the companion Node server from the same version. Generate a client entry with `npm run config:client -- --unity-project-path <project>`. Existing clients that relied on all tools being listed must add `--tool-profile all`, or select only the required authoring/code/runtime/validation profiles.

The bridge identity format now requires a project token and separate HTTP/WebSocket ports. Opening the Unity window regenerates missing local identity files; never migrate or copy a token between projects.

Queue authentication version 2 requires matching Node and UPM commits. Stop admitting new work and let in-flight operations settle before upgrading both sides. The new receiver rejects old raw JSON-RPC queue files and metadata-only proofs with `QUEUE_PROOF_VERSION_UNSUPPORTED`; do not automatically rewrite or re-sign them. Retain old claims, deadletters, operation receipts and source backups until their prior outcomes are reconciled. Rejection by the new receiver does not prove that an old in-flight mutation never executed.

With the fixture open and its bridge ready, run `node --import tsx server/src/queueSmoke.ts --unity-project-path test-project`. This performs only health requests, forces actual Node-to-Unity queue fallback, and verifies tampered parameters/replay/identity fields and legacy requests are rejected. It also checks the unmodified signed request and its exact response identity. Rejected probe files may remain in the fixture's ignored deadletter directory; the probe never removes active claims or an entire queue directory. A passing queue smoke is not a full course or recovery certification.

## Rollback

Stop the bridge, stop Play mode, and allow any in-flight scenario to finish restoration before rollback. Pin both the Git UPM dependency and Node server to the same prior commit/version. If the bridge identity is incompatible, remove only `Library/UnityMcpGhost/bridge-identity.json` and restart the prior package; preserve evidence and source-transaction files until restoration is verified. Do not use a mixed Node/UPM version.

## External certification

Variablekiller and Conditionalkiller are user-supplied copyrighted projects and are never packaged. When available, duplicate them or use clean working copies, enable no destructive/package/network capability, run non-destructive manifests through the same scenario loop, and record discrepancies without silently editing course assets. Until both pass, retain the release-candidate qualification above.
