# Development Plan

## Phase 0 - Project Baseline

- Choose TypeScript for the MCP server.
- Use `com.crispywonton.unity-mcp-ghost` as the Unity package name.
- Target Unity 2021.3 LTS minimum and Unity 6.x as the forward-looking target.
- Keep the Unity bridge localhost-only by default.

## Phase 1 - Unity Bridge MVP

- UPM package.
- Editor window.
- WebSocket JSON-RPC listener.
- Main-thread dispatcher.
- Command registry.
- `ping`, `editor.get_state`, `console.get_logs`, `scene.get_hierarchy`.
- Basic scene mutation commands with Undo support.

## Phase 2 - MCP Server MVP

- MCP stdio transport for Cursor.
- Unity bridge client.
- Tool schemas.
- `unity_get_editor_state`.
- `manage_scene`.
- `manage_gameobject`.
- `batch_execute`.

## Phase 3 - Assets, Prefabs, Materials

- AssetDatabase-backed asset operations.
- PrefabUtility-backed prefab operations.
- Material creation and shader property editing.
- GUID/path conversion.

## Phase 4 - Scripts, Compile, Tests

- Script create/edit/apply patch.
- Compile wait and console diagnostic parsing.
- EditMode and PlayMode test execution through `TestRunnerApi`.
- Code index for Unity types.

## Phase 5 - Diagnostics and Repair

- Project health.
- Missing scripts.
- Broken references.
- Compile errors.
- Scene and prefab validation.
- Safe repair commands.

## Phase 6+ - Rich Unity Workflows

- UI, Input System, physics, animation, rendering, ProBuilder, profiler, screenshots, builds, remote HTTP, auth, and knowledge-base resources.
