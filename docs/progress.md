# Unity MCP Ghost Progress

## Phase 1: Foundation

Status: validated against the live KOTOR Unity project on 2026-05-15; remaining work is automation depth and broader Unity-version coverage.

Completed:

- Structured MCP response envelope with diagnostics, confidence, undo group, and duration fields.
- Tool metadata for risk level, mutation status, dry-run support, related resources, and roadmap phase.
- Phase 1 MCP tools: `ping`, `health`, `editor_state_get`, `console_read`, `scene_hierarchy_get`, `gameobject_create`, `transform_set`, `scene_save`, and `screenshot_capture`.
- Compatibility tools: `unity_get_editor_state`, `unity_get_console_logs`, `unity_get_scene_hierarchy`, `manage_scene`, `manage_gameobject`, and `batch_execute`.
- MCP resources for read-heavy context: `unity://capabilities`, `unity://editor/state`, `unity://scenes/active`, and `unity://console/errors`.
- MCP prompts for resource-first inspection and dry-run-first repair planning.
- Unity bridge commands for editor state, console log buffer, scene hierarchy/save, GameObject create/transform/find/get/delete, screenshot capture, and batch execution.
- Undo groups for GameObject mutations.
- Dry-run previews for mutating scene, GameObject, screenshot, and batch commands.
- Durable file queue under `Library/UnityMcpGhost/queue` with `pending` and `results` folders.
- TypeScript queue fallback via `--unity-project-path` or `--unity-queue-dir`.
- Bridge window status for endpoint, connected clients, durable queue, last request, recent commands, and last error.
- Editor-load bridge service that starts the local bridge automatically on port `6400` unless disabled from the Ghost window.
- HTTP JSON-RPC hot path, with WebSocket and durable queue fallback.

Game-development fit:

- The implemented commands target everyday Unity game development workflows: inspect editor state, read diagnostics, inspect scene hierarchy, create and place objects, save scenes, capture visual state, and batch repetitive scene edits.
- The implementation avoids generic filesystem powers where Unity APIs are safer and more game-aware.
- Mutating commands are undoable or dry-run previewable so agents can iterate without trashing a scene.

Remaining before Phase 1 can be called complete:

- Validate Unity C# compilation inside Unity 2021.3, 2022.3, and Unity 6.
- Add automated EditMode smoke tests for bridge commands.
- Improve screenshot completion reporting after Unity finishes writing the PNG.
- Add a release checklist for v0.1.0.

## Phase 2: Parity Floor

Status: Phase 2 parity floor implemented and validated against the live KOTOR Unity project; remaining work is hardening and broader Unity-version coverage.

Completed in Slice 1:

- Component tools:
  - `component_add`
  - `component_get`
  - `component_modify`
  - `component_remove`
  - `manage_component`
- Asset tools:
  - `asset_find`
  - `asset_create_folder`
  - `asset_refresh`
  - `manage_asset`
- Prefab tools:
  - `prefab_create`
  - `prefab_instantiate`
  - `manage_prefab`

Completed in Slice 2:

- Scene lifecycle tools:
  - `scene_create`
  - `scene_open`
  - `scene_set_active`
  - `scene_unload`
- Hierarchy editing tools:
  - `gameobject_duplicate`
  - `gameobject_set_parent`
- Expanded compatibility tools:
  - `manage_scene` now routes create/open/set-active/unload actions.
  - `manage_gameobject` now routes duplicate and set-parent actions.

Completed in Slice 3:

- Conservative AssetDatabase mutation tools:
  - `asset_move`
  - `asset_copy`
  - `asset_delete`
  - `manage_asset` now routes move/copy/delete actions.
- C# script asset tools constrained to `.cs` files under `Assets/`:
  - `script_read`
  - `script_create`
  - `script_write`
  - `script_delete`
  - `manage_script`
- Improved JSON string parsing in the Unity bridge so script content with escaped newlines and quotes can round-trip more safely.

Game-development fit:

- Component tools let agents assemble real gameplay objects with colliders, rigidbodies, audio sources, renderers, cameras, and project MonoBehaviours through Unity APIs.
- Asset tools let agents locate sprites, models, materials, scenes, scripts, audio clips, prefabs, and folders through `AssetDatabase` instead of guessing paths.
- Prefab tools let agents convert scene prototypes into reusable game content and instantiate existing prefab assets back into scenes.
- Scene lifecycle tools let agents create test scenes, open level scenes, work additively, and set the active authoring target without manual editor clicks.
- Hierarchy editing tools let agents organize gameplay objects under managers, spawn points, level roots, cameras, UI canvases, and prefab containers.
- Mutating component, asset, and prefab operations support dry-run previews where Unity supports meaningful previews.
- Scene-object mutations use Unity Undo where possible.
- Asset and script tools use `AssetDatabase` and project-relative `Assets/` constraints instead of unrestricted filesystem access.

Slice 3 validation on KOTOR Unity project:

- Dry-run `asset.move`, `asset.copy`, and `asset.delete` passed using `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs`.
- Read-only `script.read` passed on `ModuleSpawnPipeline.cs` with a 30k-character script payload.
- Dry-run `script.create`, `script.write`, and `script.delete` passed without changing KOTOR project assets.

Completed in Slice 4:

- Long-running operation registry:
  - `operation_get`
  - `operation_list`
- Unity Package Manager tools:
  - `package_list`
  - `package_search`
  - `package_add`
  - `package_remove`
  - `manage_package`
- Unity Test Runner hook:
  - `tests_run`

Game-development fit:

- Package tools let agents inspect and configure game-development packages such as Cinemachine, Input System, Addressables, AR Foundation, Unity IAP, and platform service packages through Unity Package Manager rather than editing manifests by hand.
- Test execution returns an operation id so long-running EditMode/PlayMode suites can be polled safely instead of blocking the editor or MCP client.
- Mutating package actions support dry-run previews, which is important when working in production-scale projects like the KOTOR port.

Slice 4 validation on KOTOR Unity project:

- Unity compiled the new bridge code in Unity `2022.3.62f1`.
- `package.list` completed successfully and reported 50 registered packages.
- Dry-run `package.add` passed for `com.unity.cinemachine`.
- Dry-run `package.remove` passed for `com.unity.cinemachine`.
- Dry-run `tests.run` passed for an EditMode filter without launching the full KOTOR test suite.

Completed in Slice 5:

- LSP-style ranged script edit tool:
  - `script_apply_edits`
  - `manage_script` now routes `apply_edits`.
- MCP resource templates and state resources:
  - `unity://packages`
  - `unity://operations`
  - `unity://gameobject/{instanceId}`
  - `unity://component/{instanceId}/{type}`
  - `unity://assets/{filter}`
  - `unity://operation/{operationId}`
  - `unity://tests/{mode}`

Game-development fit:

- Ranged script edits let agents make small targeted C# changes without replacing entire scripts, which is safer for gameplay code, import pipelines, and large systems like the KOTOR module loader.
- Resource templates let MCP clients browse Unity state as context before choosing tools, keeping read-heavy inspection cheaper and less risky than tool-first workflows.

Slice 5 validation on KOTOR Unity project:

- Unity compiled the new bridge code in Unity `2022.3.62f1`.
- Dry-run `script.apply_edits` passed against `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs`, reporting original and updated byte counts without changing the file.
- `package.list` still completed successfully and reported 50 registered packages after the resource-template changes.
- `npm run build`, `npm run smoke`, and `git diff --check` passed.

Remaining Phase 2 hardening:

- Validate the same bridge against Unity `2021.3` and Unity `6000.x`.
- Add automated MCP-level resource-template tests.
- Add EditMode tests for bridge command handlers.

## Live Test Project: KOTOR Unity Port

Path: `C:\Users\NewAdmin\Documents\KaiGenInteractive\Kotor-Unity`

Purpose:

- Use the active KOTOR Unity port as the real-world validation project for Ghost.
- Keep validation game-development focused: imported KOTOR assets, prefabs, scenes, module content, materials, and diagnostics.
- Prefer read-only and `dryRun` checks unless an explicit test mutation is planned.

Setup completed:

- Repointed KOTOR Unity package manifest from the old `Unity-MCP` package path to this active `Unity-MCP-Ghost` repo.
- Repointed `Packages/packages-lock.json` to the same active package path.
- Added `npm run smoke` in Ghost to run a repeatable read-only/dry-run bridge validation suite.
- Patched a KOTOR compile blocker in `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs` by initializing two `GameObject root` locals to `null`.

Validation completed on 2026-05-15:

- Unity exited Safe Mode and compiled the Ghost bridge in Unity `2022.3.62f1`.
- `npm run build` passes for the TypeScript MCP server.
- Durable queue smoke test passed through `C:/Users/NewAdmin/Documents/KaiGenInteractive/Kotor-Unity/Library/UnityMcpGhost/queue`.
- Direct HTTP bridge smoke test passed on `http://127.0.0.1:6400/unity-mcp-ghost/`.
- Smoke covered `health`, `editor.get_state`, `scene.get_hierarchy`, `console.get_logs`, `asset.find` for prefabs/materials, and dry-run `gameobject.create` plus `asset.create_folder`.
- Active scene during validation: `Assets/Scenes/GameplayTest.unity`, with three root objects detected.
- Console error smoke returned zero Ghost-captured errors.
- Existing KOTOR warnings remain in scripts such as `CharacterCreationLayoutModels.cs`, `MCPKotorMainMenuBootstrap.cs`, `VmDispatcher.cs`, and `WAVObject.cs`; these are not Ghost bridge blockers.

Direct smoke command:

```bash
npm run smoke -- --unity-host 127.0.0.1 --unity-port 6400 --request-timeout-ms 20000
```

Durable-queue smoke command:

```bash
npm run smoke -- --unity-host 127.0.0.1 --unity-port 6400 --unity-project-path C:/Users/NewAdmin/Documents/KaiGenInteractive/Kotor-Unity --request-timeout-ms 20000
```

## Phase 3: Ghost Moat

Status: in progress, diagnostics substrate and the first repair-loop scaffold implemented.

Completed in Slice 1:

- Structured console diagnostics:
  - `console_diagnostics_get`
- Script validation entry point:
  - `script_validate`
  - `manage_script` now routes `validate`.

Game-development fit:

- Diagnostics are the first building block for the promised validate -> repair -> test workflow.
- `script_validate` imports a C# script through Unity and returns bridge-session diagnostics without guessing from raw files alone.
- Structured diagnostics include severity, message, stack trace, and parsed `Assets/...cs(line,column)` locations when Unity provides them.

Slice 1 validation on KOTOR Unity project:

- Unity compiled the new bridge code in Unity `2022.3.62f1`.
- `script.validate` passed against `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs`.
- `console.diagnostics_get` returned zero diagnostics for that script after the earlier KOTOR compile fix.
- `npm run build`, `npm run smoke`, and `git diff --check` passed.

Completed in Slice 2:

- Polling-aware compile/update wait:
  - Unity bridge command `compile.wait`
  - MCP tool `compile_wait`
- First repair-loop orchestrator scaffold:
  - `repair_loop_run`

Game-development fit:

- `compile_wait` gives agents a reliable way to wait for Unity to finish script compilation and asset refreshes before making follow-up gameplay edits.
- `repair_loop_run` now sequences the Phase 3 loop's read-only half: editor state -> optional script validation -> compile wait -> structured console diagnostics -> scoped test dry-run or test execution.
- The current repair loop deliberately stops before patching. It points agents toward `script_apply_edits` with `dryRun=true` so repair work stays reviewable and Unity-aware while the full patch-generation layer is still being built.

Slice 2 validation on KOTOR Unity project:

- Unity compiled the new bridge code in Unity `2022.3.62f1`.
- Direct `compile.wait` completed successfully after Unity finished updating.
- MCP-level `compile_wait` completed through stdio against the open KOTOR project.
- MCP-level `repair_loop_run` completed a five-step diagnostic pass against `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs`.
- `console_diagnostics_get` returned zero diagnostics for the scoped KOTOR script during the repair-loop pass.

Completed in Slice 3:

- Deterministic patch proposal planner:
  - `patch_propose`
- `repair_loop_run` now attaches patch proposals when diagnostics are present.

Game-development fit:

- `patch_propose` is intentionally conservative: it does not call a model, does not mutate files, and only emits ranged edits for localized compiler diagnostics such as missing semicolons or braces.
- For Unity/gameplay-specific diagnostics such as missing types, unknown symbols, or missing members, it recommends project-aware checks first: asmdefs, package availability, Inspector-wired fields, and component/API mismatches.
- Optional `previewDryRuns` routes proposed edits through `script.apply_edits` with `dryRun=true`, so agents can verify byte-count and range effects before touching gameplay scripts.

Slice 3 validation on KOTOR Unity project:

- MCP-level `patch_propose` converted a synthetic `CS1002` diagnostic for `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs` into one ranged edit proposal.
- `previewDryRuns=true` successfully routed that proposal through Unity `script.apply_edits` with `dryRun=true` without modifying the KOTOR project.
- `npm run build`, `npm run smoke`, and `git diff --check` passed.

Completed in Slice 4:

- Explicit repair application tool:
  - `repair_apply_edits`
- `repair_loop_run` now points accepted edits through `repair_apply_edits` instead of raw script editing.

Game-development fit:

- `repair_apply_edits` backs up the original C# script content, dry-runs ranged edits first, applies only when `dryRun=false`, waits for Unity compile/update, revalidates scoped diagnostics, and can restore the original file if compile/diagnostic/test checks fail.
- The tool is built for gameplay code safety: it works on explicit ranged edits, keeps the script path scoped under Unity's `Assets/`, and treats test execution as an optional validation gate for risky changes.
- This is the first closed-loop repair slice that can move from preview to apply to validation while still protecting project code with rollback.

Slice 4 validation on KOTOR Unity project:

- MCP-level `repair_apply_edits` completed a dry-run preview against `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs`.
- The dry-run path read the original script, produced a backup metadata step, and routed the proposed ranged edit through Unity `script.apply_edits` with `dryRun=true`.
- The KOTOR project was not mutated during this validation.

Completed in Slice 5:

- Repeatable Phase 3 repair smoke command:
  - `npm run phase3:repair-smoke`
  - Optional `--allow-mutation` scratch-script rollback mode

Game-development fit:

- The default smoke keeps production gameplay code safe by validating `repair_apply_edits` in dry-run mode against the target project script.
- The explicit mutation mode creates a controlled scratch C# script under `Assets/UnityMcpGhostScratch`, introduces a compiler error through `repair_apply_edits`, verifies rollback restored the original content, then deletes the scratch asset and folder.
- This gives Ghost a repeatable confidence check for the repair loop's most important promise: a failed automated code repair should not leave the Unity project broken.

Slice 5 validation on KOTOR Unity project:

- `npm run phase3:repair-smoke -- --unity-host 127.0.0.1 --unity-port 6400 --unity-project-path C:/Users/NewAdmin/Documents/KaiGenInteractive/Kotor-Unity --request-timeout-ms 30000` passed in dry-run mode.
- `npm run phase3:repair-smoke -- --unity-host 127.0.0.1 --unity-port 6400 --unity-project-path C:/Users/NewAdmin/Documents/KaiGenInteractive/Kotor-Unity --request-timeout-ms 60000 --allow-mutation` passed in scratch mutation rollback mode.
- The scratch rollback path reported `mode: rolled-back`, `scopedErrorCount: 1`, verified the restored file content matched the original, deleted `Assets/UnityMcpGhostScratch/GhostRepairScratch.cs`, deleted `Assets/UnityMcpGhostScratch`, and waited for compile after cleanup.

Completed in Slice 6:

- Unity compiler-pipeline diagnostic buffer:
  - Unity bridge command `compile.diagnostics_get`
  - MCP tool `compile_diagnostics_get`
- `patch_propose`, `repair_loop_run`, and `repair_apply_edits` now prefer compiler-pipeline diagnostics and fall back to console-derived diagnostics.

Game-development fit:

- Compiler diagnostics now come from `UnityEditor.Compilation.CompilationPipeline.assemblyCompilationFinished`, giving Ghost a more precise source for C# file, line, column, severity, compiler code, and assembly path.
- This improves gameplay-script repair loops because compile errors can be scoped to the script being edited instead of inferred only from generic console text.
- Console diagnostics remain as fallback for runtime exceptions, Unity API errors, and non-compiler failures.

Slice 6 validation on KOTOR Unity project:

- Unity refreshed and compiled the updated bridge in Unity `2022.3.62f1`.
- MCP-level `compile_diagnostics_get` returned `source: compilation-pipeline` and zero scoped diagnostics for `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs`.
- `npm run phase3:repair-smoke -- --unity-host 127.0.0.1 --unity-port 6400 --unity-project-path C:/Users/NewAdmin/Documents/KaiGenInteractive/Kotor-Unity --request-timeout-ms 60000 --allow-mutation` passed with compiler diagnostics active.
- The scratch rollback step reported `mode: rolled-back`, `scopedErrorCount: 2`, verified rollback content, cleaned up the scratch asset/folder, and waited for compile after cleanup.

Completed in Slice 7:

- First semantic project-understanding tools:
  - `asset_references_trace`
  - `prefab_references_trace`
- Unity bridge commands:
  - `semantic.asset_references_trace`
  - `prefab.references_trace`

Game-development fit:

- These tools trace reverse references by Unity GUID across serialized project assets, giving agents a safer answer to "what will break if I edit, move, or delete this asset?"
- `prefab_references_trace` focuses the scan on `.prefab` and `.unity` files for scene/prefab impact analysis before gameplay refactors.
- `asset_references_trace` scans broader Unity serialized assets such as prefabs, scenes, materials, animator controllers, ScriptableObjects, animation clips, asmdefs, and shader graphs.
- This is the first gdep-style semantic layer slice and directly supports KOTOR asset-porting work by exposing which imported prefabs point at generated materials, models, scripts, and other assets.

Slice 7 validation on KOTOR Unity project:

- Unity refreshed and compiled the updated bridge in Unity `2022.3.62f1`.
- `prefab_references_trace` against `Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs` scanned 36 prefab/scene files and returned zero back-references.
- `asset_references_trace` against the same script scanned 216 serialized asset files and returned zero back-references.
- `asset_references_trace` against imported KOTOR Malak menu materials found prefab back-references such as `Assets/KotorImported/MainMenu/Prefabs/MalakMenuModel_DirectMdlCandidate006N.prefab`.

Next Phase 3 targets:

- Add automated assertions for `phase3:repair-smoke` in CI once a Unity test environment is available.
- Add semantic project-analysis tools for UnityEvent bindings and Animator graphs.
