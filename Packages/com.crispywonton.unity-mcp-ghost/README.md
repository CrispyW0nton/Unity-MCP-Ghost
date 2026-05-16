# Unity MCP Ghost Editor Bridge

This package provides the Unity-side editor bridge for Unity MCP Ghost.

Open the bridge window from:

```text
Window > Unity MCP Ghost
```

The bridge is editor-only and is intended to listen on localhost. It executes Unity API commands on the editor main thread and returns JSON-RPC responses to the external MCP server.

By default the bridge starts after editor reload on `http://127.0.0.1:6400/unity-mcp-ghost/`. The window remains the control surface for status, command history, queue status, and manual stop/start.

## Status

This package currently includes Phase 1 and Phase 2 bridge tooling:

- Editor window.
- Bridge configuration.
- Main-thread dispatcher.
- Command registry.
- Phase 1 bridge commands: `ping`, `health`, `editor.get_state`, `console.get_logs`, `scene.get_hierarchy`, `scene.save`, `gameobject.create`, `gameobject.create_primitive`, `gameobject.set_transform`, and `screenshot.capture`.
- Early Phase 2 compatibility commands: `scene.save_all`, `scene.list_open`, `scene.get_setup`, `gameobject.find`, `gameobject.get`, `gameobject.delete`, and `batch.execute`.
- Phase 2 scene and hierarchy commands: `scene.create`, `scene.open`, `scene.set_active`, `scene.unload`, `gameobject.duplicate`, and `gameobject.set_parent`.
- Phase 2 slice commands for components, assets, and prefabs: `component.add`, `component.get`, `component.modify`, `component.remove`, `asset.find`, `asset.create_folder`, `asset.refresh`, `prefab.create`, and `prefab.instantiate`.
- Phase 2 asset/script commands: `asset.move`, `asset.copy`, `asset.delete`, `script.read`, `script.create`, `script.write`, `script.apply_edits`, and `script.delete`.
- Phase 2 package/test commands: `package.list`, `package.search`, `package.add`, `package.remove`, `operation.get`, `operation.list`, and `tests.run`.
- Early Phase 3 diagnostics commands: `console.diagnostics_get` and `script.validate`.
- Dry-run previews for mutating scene, GameObject, screenshot, and batch commands.
- Durable queue fallback at `Library/UnityMcpGhost/queue` with `pending` and `results` subfolders.
- HTTP JSON-RPC hot path with durable queue fallback for reload-prone Unity workflows.
- Bridge-session console log buffering for game-development diagnostics.
