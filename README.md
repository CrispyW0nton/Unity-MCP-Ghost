# Unity MCP Ghost

> **Branch notice — Unity 6.5 development snapshot:** `codex/unity-6000.5-compatibility` contains the conversion targeting **Unity 6000.5.9f1**. It currently fails compilation with the repository's Unity 2022.3.62f1 test fixture because the new test-run recovery calls require newer Test Framework APIs. The baseline support statement below describes the earlier release, not certification of this branch. See [conversion evidence and current verification limits](docs/unity-6-5-conversion.md). Do not treat this snapshot as a cross-version release.

Unity MCP Ghost is a Cursor-first Unity automation bridge inspired by the Unreal MCP Ghost architecture: inspect, mutate, validate, repair, test, and document Unity projects through deterministic MCP tools.

The `0.2.0-rc.1` release candidate contains:

- `server/` - TypeScript MCP server, tool registry, Unity bridge client, default stdio transport, and opt-in authenticated Streamable HTTP.
- `Packages/com.crispywonton.unity-mcp-ghost/` - Unity UPM editor bridge package.
- `docs/` - architecture and development notes for the Ghost roadmap.

Supported baseline: **Unity 2022.3.62f1 on Windows**, with local Node verification on **24.11.1**. The development toolchain requires Node 20.19+, 22.13+, or 24+; CI is configured for the latest 20/22/24 patches, but those remote results are not yet observed. Other Unity versions and operating systems are not certified until their CI jobs are observed green.

Windows tests that launch owned child processes also require **Windows 10+ and PowerShell 7 (`pwsh.exe` on PATH, with `Add-Type` permitted)** for bounded process cleanup. Version probes use an atomically assigned Windows Job Object and fail if cleanup cannot be verified. These are test-runner prerequisites, not dependencies of the MCP server or Unity package.

See [docs/development-plan.md](docs/development-plan.md) for the full strategic roadmap, including the competitive pattern map, phased tool catalog, semantic-analysis moat, durable transport plan, and mobile/runtime milestones. See [docs/progress.md](docs/progress.md) for implementation progress and [docs/mcp-book-guidance.md](docs/mcp-book-guidance.md) for the MCP-specific design guidance applied from the local protocol reference books.

## Goals

- Expose safe Unity Editor workflows to MCP clients such as Cursor.
- Route Unity state changes through Unity editor APIs rather than direct file edits.
- Wrap mutating operations in Undo groups where possible.
- Return structured JSON for reliable follow-up tool calls.
- Build toward diagnostics, repair loops, tests, screenshots, and knowledge-base guided workflows.

## Secure Local Flow

1. Open a Unity project that has `Packages/com.crispywonton.unity-mcp-ghost` installed.
2. Open `Window > Unity MCP Ghost`. Ghost creates an owner-only project token plus a project/editor identity under `Library/UnityMcpGhost`, selects a deterministic per-project loopback port, and starts the bridge.
3. Use the window's **Copy Cursor Config Snippet**, or run the MCP server with the exact Unity project path:

```bash
npm ci
npm run build
node dist/index.js --transport stdio --unity-project-path C:/Path/To/UnityProject
```

`--unity-project-path` reads the generated identity, token-file location, editor instance, HTTP port, and separately advertised WebSocket port, then enables the authenticated durable queue. Ghost refuses unpinned projects, stale editor identities, missing tokens, and non-loopback bridge hosts. Custom `--unity-port` and `--unity-websocket-port` values are only needed for transport-fallback testing or explicitly persisted ports.

The CLI exposes only the compact `core` profile by default. Opt into one or more additional profiles with `--tool-profile authoring,code,runtime,validation`, or use `--tool-profile all` for the complete catalog. `capabilities_search` can inspect disabled profiles without executing them.

Destructive, package/network, arbitrary-code, and reflection capabilities default to disabled per project. Review [SECURITY.md](SECURITY.md) before enabling any of them in the Unity window.

### Optional local Streamable HTTP

```text
node dist/index.js --transport streamable-http --mcp-host 127.0.0.1 --mcp-port 8080 --unity-project-path C:/Path/To/UnityProject
```

The MCP endpoint is `http://127.0.0.1:8080/mcp`, separate from Unity's own bridge ports. Only literal loopback binding (`127.0.0.1` or `::1`) is allowed. Each POST needs `Authorization: Bearer <project token>`, `X-Ghost-Project-Id`, and `X-Ghost-Editor-Id`; take the IDs and token-file location from the project's generated identity. Store credentials through the client's protected configuration, not command-line arguments, source control, logs, or evidence. The token file must have owner-only permissions.

This is a stateless, bounded JSON-response transport, not the older HTTP+SSE transport. Browser `Origin` requests are rejected; no CORS or remote listener is enabled. Use durable operation tools to query/cancel jobs; a disconnected HTTP request does not cancel or replay its mutation. On SIGINT/SIGTERM, Ghost stops accepting requests and drains admitted handlers and scenario restoration before disposing Unity. Repeated signals share that cleanup path; force-killing the process is not a graceful shutdown. Failures use sanitized diagnostics and a nonzero exit status. These local lifecycle checks do not replace the remaining [readiness gates](docs/course-ready-verification.md).

## Smoke Test

Run the read-only/dry-run smoke suite against an open Unity project with the Ghost bridge started:

```bash
npm run smoke -- --unity-project-path C:/Path/To/UnityProject --request-timeout-ms 20000
```

Override the port with an unused loopback port to force the durable queue fallback:

```bash
npm run smoke -- --unity-project-path C:/Path/To/UnityProject --unity-port 6400 --request-timeout-ms 20000
```

Run the project-neutral repair-loop smoke against an open repository fixture:

Explicit repair callers should read the [result contract 2 migration](docs/repair-result-contract-v2.md): applied repairs require rollback, unchecked Console diagnostics are not zero errors, and unknown outcomes must not be replayed.

```bash
npm run phase3:repair-smoke -- --unity-project-path C:/Path/To/UnityProject --request-timeout-ms 30000
```

Use `--script-path Assets/.../Target.cs` for another project. Add `--screenshot-baseline-filter <label>` only when that project already has a named Ghost baseline; when supplied, the smoke requires baseline selection and a passing visual diff.

Add `--allow-mutation` only in a controlled project with an explicit destructive-capability grant for cleanup. The harness checks the selected Editor identity before creating a unique `Assets/GhostRepairScratch_<run-id>.cs`; it never enables capabilities itself or deletes a folder. It accepts the intentional compiler error only after verified rollback and independent byte checks. An uncertain write, test, or cleanup retains recovery receipts and defers further Editor mutations. See [repair-smoke safety and recovery](docs/repair-smoke-safety-verification-2026-09-06.md).

Run the repeatable security boundary smoke, including missing/wrong credentials, browser Origin rejection, capability default-deny, fragmented WebSocket delivery, and the WebSocket message-size limit:

```bash
npm run smoke:security -- --unity-project-path C:/Path/To/UnityProject
```

Run the normal Play-mode smoke against the repository test project to prove Console boundaries, PageUp/PageDown and pointer delivery, exact single-frame stepping, reload-resilient project identity, and typed rejection when no backend can verify an input:

```bash
npm run smoke:runtime -- --unity-project-path C:/Path/To/Unity-MCP-Ghost/test-project
```

`input_simulate` reports its selected backend and evidence. Ghost first uses an active Unity Input System device, then a project-scoped `IUnityMcpInputDriver`; it does not claim legacy Input Manager delivery without observable proof. The repository fixture supplies a deterministic course-test driver. Requests fail with `UNSUPPORTED_INPUT_BACKEND` when neither path accepts and verifies them.

The Input System adapter requires unpaused normal Play mode, Dynamic updates and verified Game View routing; it does not change project input settings. Accepted calls initially return `running`: poll `input.status` through `batch_execute` and verify the intended gameplay outcome. Serialize requests per device. A failed tap/click can still report later release-cleanup evidence without becoming successful; do not replay it blindly. Gameplay and action-callback tests currently run on Input System 1.7.0; optional test assemblies require the source-compatible 1.3.0 API minimum, not certification of every newer version.

Run the durable scenario smoke to exercise green, compiler-failure, assertion-failure, timeout, and cancellation paths. Each case proves byte-identical source restoration and writes a local evidence bundle under the selected project's ignored `Library/UnityMcpGhost/evidence` directory:

```bash
npm run smoke:scenario -- --unity-project-path C:/Path/To/Unity-MCP-Ghost/test-project --request-timeout-ms 60000
```

`scenario_matrix_run` starts a project- and editor-pinned job. Use `operation_get`, `operation_list`, `operation_cancel`, and `operation_result` with its UUID. `evidence_bundle_create` materializes deterministic JSON, Markdown, source-diff, compiler, Console, and screenshot artifacts; it never uploads them.

Run the complete clean-room GAM 215-equivalent Module 1-2 matrix against an open repository test project:

```bash
npm run test:course
```

The gate executes 23 Module 1 cases, 43 Module 2 cases, and a separate cancellation/restoration job per module. See [docs/gam-215-fixture.md](docs/gam-215-fixture.md) for the exact inventory and evidence contract. Earlier fixture passes do not certify the current milestone. The qualified fixture-complete label is permitted only after every other readiness gate passes; real course-project certification additionally requires separate non-destructive runs against user-supplied Variablekiller and Conditionalkiller projects.

## Cursor MCP Config

Generate an absolute, token-free client configuration from the live project's ignored identity file:

```bash
npm run config:client -- --unity-project-path C:/Path/To/UnityProject --tool-profile core,runtime,validation
```

```json
{
  "mcpServers": {
    "unity-mcp-ghost": {
      "command": "node",
      "args": [
        "C:/Dev/Unity-MCP-Ghost/dist/index.js",
        "--transport",
        "stdio",
        "--tool-profile",
        "core,runtime,validation",
        "--unity-project-path",
        "C:/Path/To/UnityProject"
      ]
    }
  }
}
```

## Current Status

Course-Ready Reliability remains **in progress**. Implemented capabilities include authenticated Unity bridge transport, truthful bridge results, generation-scoped compilation, transactional script and batch changes, normal Play/Console/input control, durable scenario matrices, and deterministic evidence bundles. The generated catalog is available at `docs/generated/operation-catalog.json`; every public tool has input/output schemas, a valid example, risk metadata, and a stable operation ID. See [docs/course-ready-verification.md](docs/course-ready-verification.md) for remaining implementation and verification gates; passing fixture matrices alone do not certify the milestone.

Earlier live clean-room runs passed the GAM 215-equivalent Modules 1-2 matrix; complete-series verification is still pending. Use **GAM 215-equivalent fixture complete; real course-project certification pending** only after every other milestone gate passes and the real Variablekiller/Conditionalkiller projects remain unavailable. The unavailable-assets exception does not waive the remaining reliability or test gates.

## Reproducible Verification

```bash
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
git diff --check
```

`npm run test:course` additionally requires the repository test project to be open with its authenticated bridge active. See [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md), and [docs/gam-215-fixture.md](docs/gam-215-fixture.md) before release.
