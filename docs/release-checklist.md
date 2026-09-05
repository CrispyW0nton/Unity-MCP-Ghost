# Unity MCP Ghost release checklist

## Candidate

- Version: `0.2.0-rc.1`
- Supported baseline: Unity `2022.3.62f1` on Windows; Node.js 20, 22, and 24 are configured in CI.
- Qualification: **GAM 215-equivalent fixture complete; real course-project certification pending.**

Do not advertise macOS, Linux, Unity 2021, Unity 6, or another Unity 2022 patch as certified until the exact matrix result is observed green and recorded in `docs/progress.md`. Do not add a CI badge until that workflow has actually passed in the repository.

## Release gates

From a clean checkout:

```text
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
npm run test:protocol
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
npm run test:course
```

Confirm success, failure, timeout, cancellation, and reload paths restore the fixture source hash and leave zero retained source transactions. The evidence directories under `test-project/Library/UnityMcpGhost/evidence` are local build evidence and must not be committed.

## Package and secret review

- `npm run check:catalog` reports 90 current tools and the generated C# parity test passes.
- `dist/index.js`, root legal/security/change files, and the UPM package legal/change files are present.
- Root npm, TypeScript, Unity C#, and UPM versions agree.
- The UPM manifest pins Newtonsoft and advertises only Unity 2022.3.
- No token, identity file, `Library/`, `Logs/`, `Temp/`, `UserSettings/`, course asset, or evidence bundle is tracked.
- `npm pack --dry-run` contains only the intended server distribution.

## Installation and migration

Install the UPM package from the repository subdirectory and build the companion Node server from the same version. Generate a client entry with `npm run config:client -- --unity-project-path <project>`. Existing clients that relied on all tools being listed must add `--tool-profile all`, or select only the required authoring/code/runtime/validation profiles.

The bridge identity format now requires a project token and separate HTTP/WebSocket ports. Opening the Unity window regenerates missing local identity files; never migrate or copy a token between projects.

## Rollback

Stop the bridge, stop Play mode, and allow any in-flight scenario to finish restoration before rollback. Pin both the Git UPM dependency and Node server to the same prior commit/version. If the bridge identity is incompatible, remove only `Library/UnityMcpGhost/bridge-identity.json` and restart the prior package; preserve evidence and source-transaction files until restoration is verified. Do not use a mixed Node/UPM version.

## External certification

Variablekiller and Conditionalkiller are user-supplied copyrighted projects and are never packaged. When available, duplicate them or use clean working copies, enable no destructive/package/network capability, run non-destructive manifests through the same scenario loop, and record discrepancies without silently editing course assets. Until both pass, retain the release-candidate qualification above.
