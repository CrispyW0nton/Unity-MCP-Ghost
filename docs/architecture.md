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

## Initial Tool Slice

- `ping`
- `unity_get_editor_state`
- `unity_get_console_logs`
- `unity_get_scene_hierarchy`
- `manage_gameobject`
- `manage_scene`
- `batch_execute`

## Safety Model

The bridge will classify tools by risk:

- `read` for state inspection.
- `safe-write` for undoable scene changes.
- `asset-write` for project asset changes.
- `code-write` for script edits and compile validation.
- `destructive` for deletes and package removals.
- `build-system` for builds, package installs, and long-running jobs.

Destructive and remote operations require explicit opt-in once those transports are implemented.
