# Unity MCP Ghost

Unity MCP Ghost is a Cursor-first Unity automation bridge inspired by the Unreal MCP Ghost architecture: inspect, mutate, validate, repair, test, and document Unity projects through deterministic MCP tools.

This repository currently contains the initial project scaffold:

- `server/` - TypeScript MCP server, tool registry, Unity bridge client, and stdio transport entry point.
- `Packages/com.crispywonton.unity-mcp-ghost/` - Unity UPM editor bridge package skeleton.
- `docs/` - architecture and development notes for the Ghost roadmap.

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

Destructive, package/network, arbitrary-code, and reflection capabilities default to disabled per project. Review [SECURITY.md](SECURITY.md) before enabling any of them in the Unity window.

## Smoke Test

Run the read-only/dry-run smoke suite against an open Unity project with the Ghost bridge started:

```bash
npm run smoke -- --unity-project-path C:/Path/To/UnityProject --request-timeout-ms 20000
```

Override the port with an unused loopback port to force the durable queue fallback:

```bash
npm run smoke -- --unity-project-path C:/Path/To/UnityProject --unity-port 6400 --request-timeout-ms 20000
```

Run the Phase 3 repair-loop smoke against an open Unity project:

```bash
npm run phase3:repair-smoke -- --unity-project-path C:/Path/To/UnityProject --request-timeout-ms 30000
```

Add `--allow-mutation` only for a controlled scratch-script rollback test. It creates and removes `Assets/UnityMcpGhostScratch`.

Run the repeatable security boundary smoke, including missing/wrong credentials, browser Origin rejection, capability default-deny, fragmented WebSocket delivery, and the WebSocket message-size limit:

```bash
npm run smoke:security -- --unity-project-path C:/Path/To/UnityProject
```

Run the normal Play-mode smoke against the repository test project to prove Console boundaries, PageUp/PageDown and pointer delivery, exact single-frame stepping, reload-resilient project identity, and typed rejection when no backend can verify an input:

```bash
npm run smoke:runtime -- --unity-project-path C:/Path/To/Unity-MCP-Ghost/test-project
```

`input_simulate` reports its selected backend and evidence. Ghost first uses an active Unity Input System device, then a project-scoped `IUnityMcpInputDriver`; it does not claim legacy Input Manager delivery without observable proof. The repository fixture supplies a deterministic course-test driver. Requests fail with `UNSUPPORTED_INPUT_BACKEND` when neither path accepts and verifies them.

Run the durable scenario smoke to exercise green, compiler-failure, assertion-failure, timeout, and cancellation paths. Each case proves byte-identical source restoration and writes a local evidence bundle under the selected project's ignored `Library/UnityMcpGhost/evidence` directory:

```bash
npm run smoke:scenario -- --unity-project-path C:/Path/To/Unity-MCP-Ghost/test-project --request-timeout-ms 60000
```

`scenario_matrix_run` starts a project- and editor-pinned job. Use `operation_get`, `operation_list`, `operation_cancel`, and `operation_result` with its UUID. `evidence_bundle_create` materializes deterministic JSON, Markdown, source-diff, compiler, Console, and screenshot artifacts; it never uploads them.

## Cursor MCP Config

```json
{
  "mcpServers": {
    "unity-mcp-ghost": {
      "command": "node",
      "args": [
        "C:/Dev/Unity-MCP-Ghost/server/dist/index.js",
        "--transport",
        "stdio",
        "--unity-project-path",
        "C:/Path/To/UnityProject"
      ]
    }
  }
}
```

## Current Status

Phase 1 is validated against the live KOTOR Unity project via both direct HTTP JSON-RPC and the durable queue fallback. Phase 2 parity tooling now includes component, prefab, asset, script, package manager, test-runner, ranged-edit, and resource-template support.

Phase 3 moat work includes generation-scoped compiler diagnostics, truthful test and repair outcomes, transactional script mutations, durable operations, authenticated project-pinned transport, structured Console boundaries, normal Play-mode control, exact frame stepping, verified input simulation, semantic inspection, and visual validation. The clean-room runtime fixture proves PageUp/PageDown and pointer delivery without course assets. The active milestone is adding durable scenario matrices, deterministic evidence bundles, and the complete GAM 215-equivalent matrix.
