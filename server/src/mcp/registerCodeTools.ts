import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DryRunSchema, ParamsSchema, ScriptEditSchema, registerUnityRequestTool, type ToolContext } from "./createServer.js";

export function registerCodeTools(server: McpServer, context: ToolContext): void {
  registerUnityRequestTool(
    server,
    context,
    "asset_find",
    "Find Unity assets through AssetDatabase filters by query, type, or label.",
    {
      query: z.string().default(""),
      type: z.string().optional(),
      label: z.string().optional(),
      limit: z.number().int().positive().max(500).default(100)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 2, relatedResources: ["unity://assets/{filter}"] },
    "asset.find"
  );

  registerUnityRequestTool(
    server,
    context,
    "asset_references_trace",
    "Trace Unity asset, scene, prefab, material, animator, and ScriptableObject files that reference a target asset GUID.",
    {
      path: z.string().optional(),
      guid: z.string().optional(),
      extensions: z.string().default(""),
      includeSelf: z.boolean().default(false),
      limit: z.number().int().positive().max(5000).default(500)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3 },
    "semantic.asset_references_trace"
  );

  registerUnityRequestTool(
    server,
    context,
    "prefab_references_trace",
    "Trace prefab and scene back-references to a Unity asset or script before refactors, deletes, or prefab changes.",
    {
      path: z.string().optional(),
      guid: z.string().optional(),
      extensions: z.string().default(".prefab,.unity"),
      includeSelf: z.boolean().default(false),
      limit: z.number().int().positive().max(5000).default(500)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3 },
    "prefab.references_trace"
  );

  registerUnityRequestTool(
    server,
    context,
    "unity_event_bindings_find",
    "Find Inspector-wired UnityEvent persistent callbacks in serialized scenes, prefabs, and assets.",
    {
      methodName: z.string().default(""),
      targetType: z.string().default(""),
      assetPath: z.string().default(""),
      extensions: z.string().default(".prefab,.unity,.asset"),
      limit: z.number().int().positive().max(5000).default(500)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3 },
    "semantic.unity_event_bindings_find"
  );

  registerUnityRequestTool(
    server,
    context,
    "animator_analyze",
    "Analyze a Unity Animator Controller YAML graph: parameters, state machines, states, transitions, and transition conditions.",
    {
      path: z.string().min(1),
      limit: z.number().int().positive().max(5000).default(500)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3 },
    "semantic.animator_analyze"
  );

  registerUnityRequestTool(
    server,
    context,
    "meta_integrity_check",
    "Scan Unity Assets for missing .meta files, missing GUIDs, duplicate GUIDs, and orphan .meta files.",
    {
      includeMetaOnly: z.boolean().default(true),
      limit: z.number().int().positive().max(5000).default(500)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3 },
    "semantic.meta_integrity_check"
  );

  registerUnityRequestTool(
    server,
    context,
    "unused_assets_find",
    "Find conservative unused Unity asset candidates by scanning serialized GUID references across the project.",
    {
      extensions: z
        .string()
        .default(".prefab,.unity,.asset,.controller,.overrideController,.mat,.anim,.playable,.renderTexture,.lighting,.shadergraph,.asmdef,.uxml,.uss"),
      candidateExtensions: z
        .string()
        .default(
          ".prefab,.mat,.asset,.controller,.overrideController,.anim,.png,.jpg,.jpeg,.tga,.psd,.fbx,.obj,.wav,.mp3,.ogg,.shadergraph,.renderTexture,.uxml,.uss"
        ),
      includeScripts: z.boolean().default(false),
      limit: z.number().int().positive().max(5000).default(500)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3 },
    "semantic.unused_assets_find"
  );

  registerUnityRequestTool(
    server,
    context,
    "class_impact_analyze",
    "Analyze Unity C# class impact across scripts plus serialized asset/prefab references before refactors.",
    {
      path: z.string().default(""),
      className: z.string().default(""),
      methodName: z.string().default(""),
      limit: z.number().int().positive().max(2000).default(200)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3 },
    "semantic.class_impact_analyze"
  );

  registerUnityRequestTool(
    server,
    context,
    "call_path_find",
    "Find a lightweight C# method call path across Unity scripts using a deterministic source scan.",
    {
      fromMethod: z.string().min(1),
      toMethod: z.string().min(1),
      maxDepth: z.number().int().positive().max(12).default(6),
      limit: z.number().int().positive().max(100).default(20)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3 },
    "semantic.call_path_find"
  );

  registerUnityRequestTool(
    server,
    context,
    "lint_unity_run",
    "Run Unity-specific lint rules for gameplay performance, fragile APIs, asset metadata, and unused asset candidates.",
    {
      path: z.string().default(""),
      rules: z.string().default(""),
      includeAssetRules: z.boolean().default(true),
      limit: z.number().int().positive().max(5000).default(500)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3 },
    "semantic.lint_unity_run"
  );

  registerUnityRequestTool(
    server,
    context,
    "project_index_summary",
    "Summarize the Unity project as a semantic game-development index: asset domains, script patterns, serialized references, risks, and recommended next tools.",
    {
      includeDiagnostics: z.boolean().default(true),
      limit: z.number().int().positive().max(2000).default(200)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3, relatedResources: ["unity://semantic/index"] },
    "semantic.project_index_summary"
  );

  registerUnityRequestTool(
    server,
    context,
    "test_scope_suggest",
    "Suggest the smallest useful Unity validation scope for a script/class/method change using semantic impact and test asset scans.",
    {
      path: z.string().default(""),
      className: z.string().default(""),
      methodName: z.string().default(""),
      includePlayMode: z.boolean().default(true),
      limit: z.number().int().positive().max(200).default(20)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3, relatedResources: ["unity://semantic/index", "unity://tests/{mode}"] },
    "semantic.test_scope_suggest"
  );

  registerUnityRequestTool(
    server,
    context,
    "asset_create_folder",
    "Create a folder under Assets for organizing game content.",
    {
      parentPath: z.string().default("Assets"),
      folderName: z.string().min(1),
      dryRun: DryRunSchema
    },
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
    "asset.create_folder"
  );

  registerUnityRequestTool(
    server,
    context,
    "asset_refresh",
    "Refresh Unity's AssetDatabase after generated or imported game assets change.",
    {
      dryRun: DryRunSchema
    },
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
    "asset.refresh"
  );

  registerUnityRequestTool(
    server,
    context,
    "asset_move",
    "Move a Unity asset through AssetDatabase, constrained to Assets/ and dry-run previewable.",
    {
      fromPath: z.string().min(1),
      toPath: z.string().min(1),
      dryRun: DryRunSchema
    },
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
    "asset.move"
  );

  registerUnityRequestTool(
    server,
    context,
    "asset_copy",
    "Copy a Unity asset through AssetDatabase, constrained to Assets/ and dry-run previewable.",
    {
      fromPath: z.string().min(1),
      toPath: z.string().min(1),
      dryRun: DryRunSchema
    },
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
    "asset.copy"
  );

  registerUnityRequestTool(
    server,
    context,
    "asset_delete",
    "Delete or trash a Unity asset through AssetDatabase, constrained to Assets/ and dry-run previewable.",
    {
      path: z.string().min(1),
      moveToTrash: z.boolean().default(true),
      dryRun: DryRunSchema
    },
    { risk: "destructive", mutates: true, supportsDryRun: true, phase: 2 },
    "asset.delete"
  );

  registerUnityRequestTool(
    server,
    context,
    "manage_asset",
    "Compatibility tool for AssetDatabase actions.",
    {
      action: z.enum(["find", "create_folder", "move", "copy", "delete", "refresh"]),
      params: ParamsSchema
    },
    { risk: "destructive", mutates: true, supportsDryRun: true, phase: 2, destructive: true },
    (args) => `asset.${args.action}`,
    (args) => args.params
  );

  registerUnityRequestTool(
    server,
    context,
    "script_read",
    "Read a Unity C# script asset under Assets/.",
    {
      path: z.string().min(1)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 2 },
    "script.read"
  );

  registerUnityRequestTool(
    server,
    context,
    "script_create",
    "Create a Unity C# MonoBehaviour script asset with optional template content.",
    {
      path: z.string().min(1),
      className: z.string().optional(),
      namespace: z.string().optional(),
      content: z.string().optional(),
      overwrite: z.boolean().default(false),
      expectedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
      dryRun: DryRunSchema
    },
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
    "script.create"
  );

  registerUnityRequestTool(
    server,
    context,
    "script_write",
    "Replace the contents of a Unity C# script asset under Assets/.",
    {
      path: z.string().min(1),
      content: z.string(),
      overwrite: z.boolean().default(true),
      expectedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
      dryRun: DryRunSchema
    },
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
    "script.write"
  );

  registerUnityRequestTool(
    server,
    context,
    "script_apply_edits",
    "Apply atomic LSP-style ranged edits to a Unity C# script asset under Assets/.",
    {
      path: z.string().min(1),
      edits: z.array(ScriptEditSchema).min(1),
      expectedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
      dryRun: DryRunSchema
    },
    { risk: "code-write", mutates: true, supportsDryRun: true, phase: 2 },
    "script.apply_edits"
  );

  registerUnityRequestTool(
    server,
    context,
    "script_delete",
    "Move a Unity C# script asset to trash through AssetDatabase.",
    {
      path: z.string().min(1),
      expectedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
      dryRun: DryRunSchema
    },
    { risk: "destructive", mutates: true, supportsDryRun: true, phase: 2 },
    "script.delete"
  );

  registerUnityRequestTool(
    server,
    context,
    "script_restore",
    "Restore a byte-identical C# script from a Ghost transaction backup.",
    {
      path: z.string().min(1),
      backupPath: z.string().min(1),
      backupMetaPath: z.string().default(""),
      expectedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional()
    },
    { risk: "code-write", mutates: true, supportsDryRun: false, phase: 3 },
    "script.restore"
  );

  registerUnityRequestTool(
    server,
    context,
    "script_transaction_complete",
    "Discard bounded Ghost recovery backups only after compile and required tests pass.",
    {
      backupPath: z.string().default(""),
      backupMetaPath: z.string().default("")
    },
    { risk: "safe-write", mutates: true, supportsDryRun: false, phase: 3 },
    "script.transaction_complete"
  );
}
