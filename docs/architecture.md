# Unity MCP Ghost Architecture

Unity MCP Ghost uses a split architecture:

```text
Cursor / MCP client
        |
        | MCP stdio or Streamable HTTP
        v
TypeScript MCP server
        |
        | authenticated loopback HTTP/WebSocket JSON-RPC
        | HMAC-authenticated durable queue files under Library/UnityMcpGhost/queue
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
- The MCP server owns schemas, tool routing, batching, project/editor pinning, and client-facing output.
- Mutating commands should be undoable, verifiable, or both.
- Tool responses should contain human-readable text and structured data.

## Project identity and ports

- Unity editor HTTP bridge: a deterministic per-project port in `6400..7399`, persisted in `Library/UnityMcpGhost/bridge-settings.json`.
- Unity editor WebSocket bridge: a separately derived per-project port in `16400..26399`, persisted and advertised alongside the HTTP port. This avoids relying on the incomplete WebSocket upgrade behavior in Unity 2022.3's Mono `HttpListener`.
- Future HTTP MCP transport: `127.0.0.1:8080`

Each editor session writes `bridge-identity.json` with a stable project ID, session-stable editor instance ID, heartbeat, version/capability handshake, HTTP/WebSocket ports, and token-file location. Requests must pin both IDs. Ghost never falls back to a different open editor. A local discovery copy is written under the current user's local application-data directory.

## Durable Queue

The WebSocket path is the hot path for low-latency editor automation. For domain reload resilience, the Unity package also watches:

```text
Library/UnityMcpGhost/queue/pending/*.json
Library/UnityMcpGhost/queue/results/*.json
```

When the TypeScript server is started with `--unity-project-path`, failed socket requests can fall back to the durable queue. Queue requests contain an HMAC proof bound to request, method, deadline, idempotency key, project, and editor identity; they do not contain the raw bridge token. This keeps game-development loops alive while Unity recompiles scripts or reloads assemblies without weakening project pinning.

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

HTTP and WebSocket require a per-project bearer token, reject browser `Origin` requests, enforce request/body/message/concurrency/rate limits, and bind only to loopback. Destructive, package/network, arbitrary-code, and reflection classes default to disabled and require per-project opt-in. Native remote binding is not supported; use an authenticated encrypted tunnel terminating on loopback. See `SECURITY.md`.
