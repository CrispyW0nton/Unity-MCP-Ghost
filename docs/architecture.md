# Unity MCP Ghost Architecture

## Operation contracts and profiles

Each MCP tool registration is the versioned source for its handler, input schema, stable operation ID, output envelope, risk/execution metadata, related resources, and validated examples. `npm run generate:catalog` materializes the deterministic JSON Schema 2020-12 catalog and the C# direct-operation parity list; `npm run check:catalog`, Node protocol tests, and Unity EditMode tests reject drift.

The production CLI registers the compact `core` profile by default. `authoring`, `code`, `runtime`, and `validation` profiles are explicit opt-ins, while `all` preserves full-surface compatibility for controlled smoke suites. Discovery is bounded and paginated; there is deliberately no generic `operation_call` escape hatch.

Unity MCP Ghost uses a split architecture:

```text
Cursor / MCP client
        |
        | MCP stdio (default) or authenticated loopback Streamable HTTP
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
- Opt-in MCP-facing Streamable HTTP: `127.0.0.1:8080/mcp` by default; configure its separate port with `--mcp-port`.

Each editor session writes `bridge-identity.json` with a stable project ID, session-stable editor instance ID, heartbeat, version/capability handshake, HTTP/WebSocket ports, and token-file location. Requests must pin both IDs. Ghost never falls back to a different open editor. A local discovery copy is written under the current user's local application-data directory.

A failed startup includes an additive `startupFailure` receipt naming the stage, transport, configured port, and typed native error. Only a verified address-in-use bind failure is `BRIDGE_ENDPOINT_CONFLICT`; `running: false` alone is not proof of a port collision. Heartbeats preserve the failure receipt until a subsequent successful start. Exception messages are excluded from the receipt to avoid publishing credentials or user configuration.

The MCP-facing CLI defaults to stdio; `--transport streamable-http` enables the separate authenticated, project/editor-pinned loopback endpoint. `server/src/mcpCli.ts` owns executable lifecycle; `server/src/transports/streamableHttp.ts` owns transport authentication, framing, bounded admission/results, protocol-version batch policy and output deadlines. Stateless request servers share one `ScenarioJobManager`. Tool profiles are discovery choices, not a replacement for Unity's capability authorization.

HTTP service `close()` stops admission and closes sockets; it does not claim background jobs have stopped. `drain()` then awaits admitted handler completion and protocol cleanup, including disconnected requests that have not produced their final response. The coordinator next calls `ScenarioJobManager.close()` to await admitted starts, recovery, execution, source/editor restoration and durable finalization before disposing Unity. Signal handlers remain installed through this sequence. The service's `fatalError` promise preserves the first listener/cleanup cause; the CLI reports only sanitized stable codes. Failed drains prevent disposal; retained finalization failures produce an unknown-outcome diagnostic and preserve recovery records/leases. No fixed grace expiry, disconnect cancellation or mutation replay is introduced.

## Durable Queue

The client attempts authenticated HTTP first, then WebSocket and the durable queue when the failure permits fallback. It preserves request identity and never treats an ambiguous mutation outcome as a new mutation. For domain reload resilience, the Unity package watches:

```text
Library/UnityMcpGhost/queue/pending/*.json
Library/UnityMcpGhost/queue/results/*.json
```

When the TypeScript server is started with `--unity-project-path`, failed socket requests can fall back to the durable queue. Queue files use the version 2 envelope `{authProofVersion: 2, requestJson, authProof}`. `requestJson` is the exact serialized inner JSON-RPC text, including nested parameters, replay metadata and project/editor identity. The HMAC-SHA256 input is the UTF-8 prefix `UnityMcpGhost.Queue.v2`, a zero byte, then the exact UTF-8 inner text; the key is the lowercase 64-character token text, not hex-decoded bytes. Both pending and stale claims authenticate before inner parsing. The token itself is not stored in queue files.

Upgrade the Node producer and UPM receiver together. Legacy metadata-only proofs are rejected, not automatically rewritten or re-signed. Retain old claims and recovery evidence until their previous outcomes are reconciled. See [SECURITY.md](../SECURITY.md#durable-queue-request-authentication) for byte limits and the trust boundary, and [the release checklist](release-checklist.md#installation-and-migration) for upgrade handling. Queue authentication alone does not certify every reload, cancellation or stale-claim recovery path.

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

Tools declare their risk classes:

- `read` for state inspection.
- `safe-write` for undoable scene changes.
- `asset-write` for project asset changes.
- `code-write` for script edits and compile validation.
- `destructive` for deletes and package removals.
- `build-system` for builds, package installs, and long-running jobs.

HTTP and WebSocket require a per-project bearer token, reject browser `Origin` requests, enforce request/body/message/concurrency/rate limits, and bind only to loopback. Destructive, package/network, arbitrary-code, and reflection classes default to disabled and require per-project opt-in. Native remote binding is not supported; use an authenticated encrypted tunnel terminating on loopback. See `SECURITY.md`.
