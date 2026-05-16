# Unity MCP Ghost Development Roadmap

This roadmap positions Unity MCP Ghost as an agentic Unity game-development orchestrator rather than another large CRUD tool catalog. The strongest open-source Unity MCP projects already cover basic scene, asset, script, and package operations. Ghost should win on the parts that are still underserved: deterministic repair loops, deep Unity project semantics, domain-reload resilience, and mobile shipping workflows.

## Strategic Position

Ghost should layer above Unity's first-party MCP and the broader open-source field:

- Use official or commodity MCP primitives for basic scene, asset, script, and package operations when available.
- Own higher-level workflows: inspect, mutate, validate, repair, test, document, and ship.
- Treat Unity domain reloads as a first-class failure mode and preserve in-flight commands through them.
- Make project structure visible to agents: prefab back-references, inspector-wired UnityEvents, Animator graphs, GUID usage, and affected tests.
- Align tool coverage with real Unity work from the Unity Development Cookbook and Unity 2020 Mobile Game Development: scripting, input, physics, rendering, animation, AI, UI, audio, files/networking, mobile builds, services, monetization, and AR.

## Design Rules

Every tool should follow these rules from the beginning:

- Atomicity: mutating Unity editor operations run inside named Undo groups where Unity supports it.
- Dry run: mutating tools accept `dryRun: true` and return the planned diff without changing the project.
- Structured responses: every command returns `{ ok, data, diagnostics, confidence, undoGroupId, durationMs }`.
- Determinism: outputs are stable enough for snapshot tests and follow-up tool calls.
- Resilience: long-running commands can resume after compile, assembly reload, editor restart, or client reconnect.
- Discoverability: every tool includes schema, examples, risk level, related tools, and resources it can read.
- Grounding: planning and diagnostics can cite Unity docs and the embedded recipe taxonomy without copying book text.

## Reference Pattern Map

| Ghost capability | Proven source to study | Why it matters |
| --- | --- | --- |
| Batch execution | CoplayDev/unity-mcp, CoderGamester/mcp-unity | Avoid slow one-tool-per-object loops. |
| MCP resources | CoderGamester/mcp-unity | Let agents browse Unity state with `unity://` URIs. |
| Roslyn validation | CoplayDev/unity-mcp | Catch compile and API errors before Unity iteration. |
| LSP-style text edits | akiojin/unity-cli | Make script edits precise, reviewable, and rollback-friendly. |
| Reflection escape hatch | IvanMurzak/Unity-MCP | Cover advanced editor APIs without exploding tool count. |
| Runtime mode | IvanMurzak/Unity-MCP | Extend Ghost into Player builds, telemetry, and NPC workflows. |
| Attribute-registered tools | UnityNaturalMCP, Unity official MCP | Let users expose project-specific C# tools cleanly. |
| Lazy tool loading | AnkleBreaker-Studio/unity-mcp-server | Keep large catalogs usable under client tool limits. |
| Durable file queue | AIBridge | Survive domain reloads and recompiles. |
| Semantic project graph | pirua-game/gdep | Reveal Unity dependencies grep cannot see. |
| Mobile shipping flow | Doran's mobile book | Own Android, iOS, IAP, Ads, notifications, and AR Foundation. |
| Canonical game-dev taxonomy | Unity Development Cookbook | Keep coverage tied to real Unity production domains. |

## Target Architecture

```text
MCP clients
  |
  | stdio / Streamable HTTP
  v
TypeScript MCP server
  - tool registry and schemas
  - resource registry for unity:// URIs
  - batch executor
  - knowledge index
  - repair-loop orchestrator
  - socket transport plus durable file queue transport
  |
  | localhost JSON-RPC / durable queue files
  v
Unity UPM bridge
  - editor window and status monitor
  - C# command registry
  - Undo and dry-run middleware
  - Roslyn/LSP validation hooks
  - semantic indexer
  - reflection bridge
  - optional runtime bridge
  |
  v
Unity Editor project / Player build
```

## Phase 1: Foundation

Goal: ship a reliable vertical slice with the safety model baked in.

Timeline: weeks 1-4.

Tools:

- `ping`
- `health`
- `editor_state_get`
- `console_read`
- `scene_hierarchy_get`
- `gameobject_create`
- `transform_set`
- `scene_save`
- `screenshot_capture`

Infrastructure:

- Shared response envelope and Zod schemas in the TypeScript server.
- C# result envelope in the Unity bridge.
- Undo middleware for mutating editor operations.
- `dryRun` planning path for all mutating Phase 1 tools.
- Durable queue at `Library/UnityMcpGhost/queue` for pending commands and results.
- Editor window with bridge status, connected clients, command log, and pause toggle.
- CI for TypeScript typecheck and Unity EditMode tests when a Unity runner is available.

Acceptance criteria:

- `ping` round trip is under 50 ms on an idle editor.
- `scene_hierarchy_get` returns deterministic JSON for a 1,000-object scene.
- `gameobject_create` can be undone as a single Unity Undo action.
- A forced script recompile during a queued command does not lose the result.
- README quickstart works from Cursor with stdio.

## Phase 2: Parity Floor

Goal: make Ghost useful for normal Unity editor automation without chasing a 200-tool catalog.

Timeline: weeks 5-10.

Tool groups:

- Scenes: `scene_create`, `scene_open`, `scene_save`, `scene_unload`, `scene_set_active`.
- GameObjects: `gameobject_find`, `gameobject_destroy`, `gameobject_duplicate`, `gameobject_set_parent`.
- Components: `component_add`, `component_remove`, `component_get`, `component_modify`, `component_list`.
- Prefabs: `prefab_create`, `prefab_instantiate`, `prefab_open`, `prefab_save`, `prefab_revert`.
- Assets: `asset_find`, `asset_create_folder`, `asset_move`, `asset_copy`, `asset_delete`, `asset_refresh`.
- Scripts: `script_create`, `script_read`, `script_delete`, `script_apply_edits`, `execute_csharp`.
- Execution: `menu_item_execute`, `tests_run`, `package_manage`, `batch_execute`.

Resources:

- `unity://editor/state`
- `unity://scenes/active`
- `unity://scenes/all`
- `unity://hierarchy/{sceneId}`
- `unity://gameobject/{instanceId}`
- `unity://component/{instanceId}/{type}`
- `unity://assets?filter=...`
- `unity://packages`
- `unity://console/{level}`
- `unity://tests/{mode}`

Acceptance criteria:

- Total tool count is at least 40 with lazy category registration.
- `batch_execute` is at least 10x faster than sequential MCP calls for 100 simple object mutations.
- Resources can be read independently of tools by an MCP client.
- A dogfood prompt can create, save, and validate a small playable scene.

## Phase 3: Ghost Moat

Goal: deliver the differentiators that justify Ghost even after official Unity MCP primitives mature.

Timeline: weeks 11-18.

Agentic repair loop:

- `script_validate`
- `console_diagnostics_get`
- `patch_propose`
- `text_edits_apply`
- `screenshot_diff`
- `repair_loop_run`
- `undo_group_begin`
- `undo_group_end`
- `dry_run_preview`

Semantic project layer:

- `semantic_index_build`
- `prefab_references_trace`
- `unityevent_bindings_find`
- `animator_analyze`
- `assets_unused_find`
- `call_path_find`
- `impact_and_risk_analyze`
- `lint_unity_run`
- `test_scope_suggest`
- `class_semantics_explore`

Reflection and extension:

- `reflection_method_find`
- `reflection_method_call`
- `reflection_property_get_set`
- Attribute-based custom tool registration in user C#.

Knowledge:

- `unity_docs_search`
- `unity://kb/recipe/{slug}`

Acceptance criteria:

- `repair_loop_run` fixes at least 80 percent of seeded compile and missing-reference failures in under five iterations on a benchmark project.
- Semantic index builds in under two seconds on a 1,000-class project after a warm cache.
- `unityevent_bindings_find` locates inspector-wired persistent calls that text search misses.
- Lint rules catch Unity-specific issues such as `GetComponent` in `Update`, broken `.meta` GUIDs, missing null guards after scene lookups, and unsafe coroutine lifecycle patterns.

## Phase 4: Core Game Systems

Goal: cover the production systems a typical Unity game needs, mapped to Cookbook domains.

Timeline: weeks 19-30.

Tool groups:

- 2D: `sprite_create`, `sprite_atlas_manage`, `tilemap_paint`, `sorting_layer_manage`, `rigidbody2d_setup`.
- Rendering: `material_create`, `material_modify`, `shader_list`, `shader_graph_create`, `shader_graph_modify`, `post_process_volume_setup`, `urp_settings_manage`, `texture_import_settings`.
- Lighting: `light_create`, `lightmap_bake`, `light_probe_place`, `reflection_probe_setup`, `environment_lighting_set`.
- Physics: `physics_raycast`, `physics_overlap`, `collider_setup`, `rigidbody_setup`, `joint_setup`, `physics_settings_manage`.
- Animation: `animation_clip_create`, `animator_state_add`, `animator_transition_add`, `blend_tree_create`, `ik_constraint_setup`.
- Camera: `camera_setup`, `cinemachine_vcam_create`, `cinemachine_dolly_setup`.
- AI navigation: `navmesh_bake`, `navmesh_agent_setup`, `state_machine_scaffold`.
- VFX: `particle_system_create`, `vfx_graph_manage`.
- Audio: `audio_source_setup`, `audio_mixer_create`, `audio_reverb_zone_setup`.

Acceptance criteria:

- Each domain has a runnable dogfood scene and automated validation path.
- Ghost can build a third-person chase scene using Animator, NavMesh, Cinemachine, physics, UI, and audio from a single high-level prompt.
- Optional package integrations degrade gracefully when packages such as Cinemachine, Shader Graph, or VFX Graph are not installed.

## Phase 5: Shipping, Mobile, Services, and AR

Goal: own the under-served path from Unity project to real mobile build.

Timeline: weeks 31-42.

Tool groups:

- UI: `ui_canvas_create`, `ui_element_create`, `ui_anchors_set`, `ui_safe_area_apply`, `ui_toolkit_uxml_create`, `custom_inspector_scaffold`.
- Input: `input_actions_create`, `input_binding_add`, `input_simulate`, `accelerometer_sample`.
- Build pipeline: `build_target_switch`, `build_settings_configure`, `keystore_configure`, `xcode_provisioning_setup`, `build_run`, `build_post_process_script_add`, `il2cpp_settings_manage`, `build_report_analyze`.
- Unity services: `services_link_project`, `ads_configure`, `iap_configure`, `notifications_schedule`, `analytics_event_register`, `remote_config_setup`, `cloud_save_configure`.
- AR Foundation: `ar_foundation_install`, `ar_plane_detection_setup`, `ar_anchor_place`.
- Optimization: `addressables_init`, `addressable_group_manage`, `addressable_build`, `profiler_sample_capture`, `memory_profiler_snapshot`.

Acceptance criteria:

- Ghost can produce a signed Android build of a sample project with no manual editor steps.
- The build report identifies size and performance regressions with actionable diagnostics.
- Ads, IAP, analytics, notifications, and safe-area UI are configured in a verifiable sample project.
- AR Foundation demo creates plane detection and object placement from a prompt.

## Phase 6: Runtime Mode

Goal: let Ghost operate in Player builds for debugging, telemetry, live operations, and AI-driven gameplay experiments.

Timeline: weeks 43-52.

Tools:

- `runtime_bridge_init`
- `runtime_npc_brain_attach`
- `runtime_dialog_generate`
- `runtime_telemetry_stream`
- `runtime_remote_command_exec`
- `runtime_save_inspect`
- `runtime_save_patch`
- `runtime_screenshot`
- `runtime_input_replay`
- `runtime_feature_flag_toggle`
- `runtime_a_b_test_assign`
- `runtime_crash_report_attach`
- `runtime_console_tail`
- `runtime_asset_hotswap`
- `runtime_session_record`

Security requirements:

- Runtime mode is compile-time opt-in through a define such as `UNITY_MCP_GHOST_RUNTIME`.
- Commands are authenticated and signed.
- Runtime C# execution is disabled by default and restricted by an allowlist when enabled.
- Every runtime command is audited locally.

Acceptance criteria:

- A sample Player build streams telemetry and screenshots back through Ghost.
- Deterministic input replay can reproduce a scripted gameplay bug.
- Runtime tools add less than one millisecond of frame cost when idle.

## Cross-Phase Workstreams

| Workstream | Start | Output |
| --- | --- | --- |
| Knowledge base | Phase 1 | Searchable Unity manual and recipe taxonomy. |
| Compatibility with official Unity MCP | Phase 2 | Detection, delegation, and fallback strategy. |
| Benchmark suite | Phase 2 | Versioned tasks for scene creation, bug repair, semantic analysis, and mobile build. |
| Distribution | Phase 2 | OpenUPM, Smithery, mcpmarket, Unity Asset Store, and clear install docs. |
| Skill packs | Phase 3 | Client-side workflow prompts for common Unity tasks. |
| Documentation | Continuous | Runnable recipes, architecture notes, safety model, and comparison guides. |

## Success Metrics

| Phase | Metric | Target |
| --- | --- | --- |
| 1 | Roundtrip latency | under 50 ms p50, under 200 ms p99 |
| 1 | Domain-reload command survival | 100 percent for queued commands |
| 2 | Batch speedup | at least 10x over sequential calls |
| 2 | Parity coverage | at least 40 practical tools plus resources |
| 3 | Repair success | at least 80 percent seeded fixes in under five iterations |
| 3 | Semantic index | under two seconds warm on 1,000 classes |
| 4 | Cookbook systems coverage | core domains represented with demos |
| 5 | Mobile shipping | signed sample Android build generated end to end |
| 6 | Runtime overhead | under one millisecond per frame when idle |

## Risk Register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Official Unity MCP commoditizes CRUD tools | Medium | Delegate primitives and differentiate at workflow level. |
| Tool catalog overwhelms MCP clients | Medium | Lazy category registration and resources for read-heavy state. |
| Roslyn and Unity version drift | High | Version matrix, capability detection, and graceful fallback. |
| Domain reload loses in-flight work | High | Durable queue required for long-running operations. |
| Repair loop applies bad fixes | High | Dry-run, confidence thresholds, tests, screenshot diff, and undo rollback. |
| Script eval becomes an RCE hazard | Critical | Localhost default, explicit opt-in, sandboxing, and allowlists. |
| Semantic indexing is slow on large projects | Medium | Incremental cache keyed by GUID, file hash, and asset import timestamp. |
| Optional Unity packages change APIs | Medium | Integration adapters with package version detection. |

## Immediate Seven-Day Plan

1. Define shared `ToolResponse<T>` and Unity bridge result envelopes.
2. Add tool metadata: risk level, mutating flag, dry-run support, examples, related resources.
3. Implement Undo and dry-run middleware before adding more mutating tools.
4. Implement durable queue files and a queue watcher in the Unity bridge.
5. Finish Phase 1 read tools: `ping`, `health`, `editor_state_get`, `console_read`, `scene_hierarchy_get`.
6. Finish Phase 1 mutation and capture tools: `gameobject_create`, `transform_set`, `scene_save`, `screenshot_capture`.
7. Add smoke tests, README quickstart validation, and a v0.1.0 release checklist.
