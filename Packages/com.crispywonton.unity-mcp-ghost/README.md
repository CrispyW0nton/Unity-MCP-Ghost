# Unity MCP Ghost Editor Bridge

This package provides the Unity-side editor bridge for Unity MCP Ghost.

Open the bridge window from:

```text
Window > Unity MCP Ghost
```

The bridge is editor-only, binds to loopback, and requires its generated project token plus exact project/editor identity. It executes Unity API commands on the editor main thread and returns JSON-RPC responses to the external MCP server.

By default the bridge starts after editor reload on a deterministic project-specific port. The window remains the control surface for status, enabled risk classes, command history, queue status, and manual stop/start. Runtime identity and credentials stay under the project's ignored `Library/UnityMcpGhost` directory.

## Status

Supported baseline: Unity **2022.3.62f1 on Windows**. Other platforms and Unity versions remain uncertified until their CI runs are observed green.

Install the package from a local checkout or a Git URL with the package subdirectory:

```text
https://github.com/CrispyW0nton/Unity-MCP-Ghost.git?path=/Packages/com.crispywonton.unity-mcp-ghost
```

The package includes:

- Editor window.
- Bridge configuration.
- Main-thread dispatcher.
- Command registry.
- Phase 1 bridge commands: `ping`, `health`, `editor.get_state`, `console.get_logs`, `scene.get_hierarchy`, `scene.save`, `gameobject.create`, `gameobject.create_primitive`, `gameobject.set_transform`, and synchronous `screenshot.capture`.
- Early Phase 2 compatibility commands: `scene.save_all`, `scene.list_open`, `scene.get_setup`, `gameobject.find`, `gameobject.get`, `gameobject.delete`, and `batch.execute`.
- Phase 2 scene and hierarchy commands: `scene.create`, `scene.open`, `scene.set_active`, `scene.unload`, `gameobject.duplicate`, and `gameobject.set_parent`.
- Phase 2 slice commands for components, assets, and prefabs: `component.add`, `component.get`, `component.modify`, `component.remove`, `asset.find`, `asset.create_folder`, `asset.refresh`, `prefab.create`, and `prefab.instantiate`.
- Phase 2 asset/script commands: `asset.move`, `asset.copy`, `asset.delete`, `script.read`, `script.create`, `script.write`, `script.apply_edits`, and `script.delete`.
- Phase 2 package/test commands: `package.list`, `package.search`, `package.add`, `package.remove`, `operation.get`, `operation.list`, and `tests.run`.
- Early Phase 3 diagnostics commands: `console.diagnostics_get`, `compile.diagnostics_get`, `script.validate`, and `compile.wait`.
- Early Phase 3 semantic commands: `semantic.asset_references_trace`, `prefab.references_trace`, `semantic.unity_event_bindings_find`, `semantic.animator_analyze`, `semantic.meta_integrity_check`, `semantic.unused_assets_find`, `semantic.class_impact_analyze`, `semantic.call_path_find`, `semantic.lint_unity_run`, `semantic.project_index_summary`, and `semantic.test_scope_suggest`.
- Early Phase 3 visual validation commands: `screenshot.diff`, `screenshot.baselines_list`, and `screenshot.baselines_cleanup`.
- MCP-level Phase 3 orchestration now includes `compile_wait`, `patch_propose`, `repair_apply_edits`, `repair_loop_run`, and `visual_validation_report` resources in the TypeScript server.
- Dry-run previews for mutating scene, GameObject, screenshot, and batch commands.
- Durable queue fallback at `Library/UnityMcpGhost/queue` with `pending` and `results` subfolders.
- HTTP JSON-RPC hot path with durable queue fallback for reload-prone Unity workflows.
- Bridge-session console log buffering for game-development diagnostics.
- Normal Play mode, Console boundary, verified input, durable scenario-source, and runtime assertion controllers.
- A generated TypeScript/C# operation parity catalog and EditMode/PlayMode test assemblies.

The companion Node server exposes only a compact core profile unless the client opts into authoring, code, runtime, validation, or all tools. Destructive and package/network capability classes remain disabled by default even when their tools are discoverable.

License and release history are in `LICENSE.md` and `CHANGELOG.md` within this package.
