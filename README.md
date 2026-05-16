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

## Early Local Flow

1. Open a Unity project that has `Packages/com.crispywonton.unity-mcp-ghost` installed.
2. The bridge auto-starts on `http://127.0.0.1:6400/unity-mcp-ghost/`. Use `Window > Unity MCP Ghost` to inspect status, stop it, or restart it.
3. Run the MCP server from this repo:

```bash
npm install
npm run build
node dist/index.js --transport stdio --unity-host 127.0.0.1 --unity-port 6400
```

To enable the durable file-queue fallback that survives Unity domain reloads, pass either the Unity project path or the queue directory:

```bash
node dist/index.js --transport stdio --unity-host 127.0.0.1 --unity-port 6400 --unity-project-path C:/Path/To/UnityProject
```

## Smoke Test

Run the read-only/dry-run smoke suite against an open Unity project with the Ghost bridge started:

```bash
npm run smoke -- --unity-host 127.0.0.1 --unity-port 6400 --request-timeout-ms 20000
```

Add `--unity-project-path` to exercise the durable file queue fallback:

```bash
npm run smoke -- --unity-host 127.0.0.1 --unity-port 6400 --unity-project-path C:/Path/To/UnityProject --request-timeout-ms 20000
```

Run the Phase 3 repair-loop smoke against an open Unity project:

```bash
npm run phase3:repair-smoke -- --unity-host 127.0.0.1 --unity-port 6400 --unity-project-path C:/Path/To/UnityProject --request-timeout-ms 30000
```

Add `--allow-mutation` only for a controlled scratch-script rollback test. It creates and removes `Assets/UnityMcpGhostScratch`.

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
        "--unity-host",
        "127.0.0.1",
        "--unity-port",
        "6400"
      ]
    }
  }
}
```

## Current Status

Phase 1 is validated against the live KOTOR Unity project via both direct HTTP JSON-RPC and the durable queue fallback. Phase 2 parity tooling now includes component, prefab, asset, script, package manager, test-runner, ranged-edit, and resource-template support.

Phase 3 moat work now includes structured console diagnostics, compiler-pipeline diagnostics, `script_validate`, polling-aware `compile_wait`, `patch_propose`, `repair_apply_edits`, repeatable repair smoke tests, GUID-based asset/prefab back-reference tracing, UnityEvent binding discovery, Animator graph analysis, asset hygiene scans, C# call-path/class impact analysis, Unity-specific lint rules, `project_index_summary`/`unity://semantic/index`, `test_scope_suggest`, and the first `repair_loop_run` diagnostic-pass scaffold. Next target: wire semantic test-scope suggestions into repair-loop orchestration.
