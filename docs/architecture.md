# Unity MCP Ghost Architecture

Unity MCP Ghost uses a split architecture:

```text
Cursor / MCP client
        |
        | MCP stdio or Streamable HTTP
        v
TypeScript MCP server
        |
        | localhost WebSocket JSON-RPC
        | durable queue files under Library/UnityMcpGhost/queue
        v
Unity editor bridge package
        |
        | UnityEditor / UnityEngine APIs
        v
Unity Editor project
```

## Principles

- Unity Editor state changes go through Unity C# APIs.
- Scene, prefab, asset, test, build, and package operations are executed by the editor bridge on the Unity main thread.
- The MCP server owns schemas, tool routing, batching, remote auth, and client-facing output.
- Mutating commands should be undoable, verifiable, or both.
- Tool responses should contain human-readable text and structured data.

## Default Ports

- Unity editor bridge: `127.0.0.1:6400`
- Future HTTP MCP transport: `127.0.0.1:8080`

## Durable Queue

The WebSocket path is the hot path for low-latency editor automation. For domain reload resilience, the Unity package also watches:

```text
Library/UnityMcpGhost/queue/pending/*.json
Library/UnityMcpGhost/queue/results/*.json
```

When the TypeScript server is started with `--unity-project-path` or `--unity-queue-dir`, failed socket requests can fall back to the durable queue. This keeps game-development loops alive while Unity recompiles scripts or reloads assemblies.

## Initial Tool Slice

- `ping`
- `unity_get_editor_state`
- `unity_get_console_logs`
- `unity_get_scene_hierarchy`
- `manage_gameobject`
- `manage_scene`
- `batch_execute`

## MCP Resources and Prompts

Ghost follows a resource-first pattern for read-heavy Unity state:

- `unity://capabilities` - tool catalog, risk levels, dry-run support, related resources, and operating principles.
- `unity://editor/state` - current Unity editor state.
- `unity://scenes/active` - active scene hierarchy.
- `unity://console/errors` - recent console errors for validation and repair loops.

Ghost also exposes prompts that encode preferred orchestration patterns:

- `ghost_inspect_project` - read-only project inspection using resources before tools.
- `ghost_repair_loop_plan` - dry-run-first validate, repair, test planning.

## Safety Model

The bridge will classify tools by risk:

- `read` for state inspection.
- `safe-write` for undoable scene changes.
- `asset-write` for project asset changes.
- `code-write` for script edits and compile validation.
- `destructive` for deletes and package removals.
- `build-system` for builds, package installs, and long-running jobs.

Destructive and remote operations require explicit opt-in once those transports are implemented.
