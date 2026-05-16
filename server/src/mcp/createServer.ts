import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { UnityClient } from "../unity/UnityClient.js";
import { asObject, failureResponse, type GhostToolMeta, successResponse } from "./toolResponse.js";

export interface ToolContext {
  unity: UnityClient;
}

type ToolSchema = Record<string, z.ZodType>;
type ToolHandler<TArgs> = (args: TArgs) => Promise<CallToolResult>;
type ToolCatalogEntry = GhostToolMeta & {
  name: string;
  description: string;
};

const EmptySchema = {};
const ParamsSchema = z.record(z.string(), z.unknown()).default({});
const DryRunSchema = z.boolean().default(false);
const RegisteredToolCatalog: ToolCatalogEntry[] = [];

const TransformSchema = {
  instanceId: z.number().int(),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  rotationX: z.number().optional(),
  rotationY: z.number().optional(),
  rotationZ: z.number().optional(),
  scaleX: z.number().optional(),
  scaleY: z.number().optional(),
  scaleZ: z.number().optional(),
  dryRun: DryRunSchema
};

const ComponentValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const ScriptEditSchema = z.object({
  startLine: z.number().int().nonnegative(),
  startColumn: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  endColumn: z.number().int().nonnegative(),
  text: z.string()
});

function annotationsFor(meta: GhostToolMeta): ToolAnnotations {
  return {
    readOnlyHint: !meta.mutates,
    destructiveHint: meta.risk === "destructive",
    idempotentHint: !meta.mutates,
    openWorldHint: false
  };
}

function registerTool<TSchema extends ToolSchema>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: TSchema,
  meta: GhostToolMeta,
  handler: ToolHandler<z.output<z.ZodObject<TSchema>>>
): void {
  const existingIndex = RegisteredToolCatalog.findIndex((tool) => tool.name === name);
  const catalogEntry = { name, description, ...meta };
  if (existingIndex >= 0) {
    RegisteredToolCatalog[existingIndex] = catalogEntry;
  } else {
    RegisteredToolCatalog.push(catalogEntry);
  }

  server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: annotationsFor(meta),
      _meta: {
        "unity-mcp-ghost/risk": meta.risk,
        "unity-mcp-ghost/mutates": meta.mutates,
        "unity-mcp-ghost/supportsDryRun": meta.supportsDryRun,
        "unity-mcp-ghost/phase": meta.phase,
        "unity-mcp-ghost/relatedResources": meta.relatedResources ?? [],
        "unity-mcp-ghost/examples": meta.examples ?? []
      }
    },
    handler as never
  );
}

function registerJsonResource(
  server: McpServer,
  name: string,
  uri: string,
  description: string,
  read: () => Promise<unknown> | unknown
): void {
  server.registerResource(
    name,
    uri,
    {
      title: name,
      description,
      mimeType: "application/json"
    },
    async () => {
      const data = await read();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2)
          }
        ]
      };
    }
  );
}

function registerJsonResourceTemplate(
  server: McpServer,
  name: string,
  uriTemplate: string,
  description: string,
  read: (variables: Record<string, string | string[]>) => Promise<unknown> | unknown
): void {
  server.registerResource(
    name,
    new ResourceTemplate(uriTemplate, { list: undefined }),
    {
      title: name,
      description,
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const data = await read(variables);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2)
          }
        ]
      };
    }
  );
}

async function readUnityResource(context: ToolContext, method: string, params: unknown = {}): Promise<unknown> {
  try {
    return await context.unity.request(method, params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          message
        }
      ]
    };
  }
}

async function readUnityOperationResource(context: ToolContext, startMethod: string, params: unknown = {}, timeoutMs = 3000): Promise<unknown> {
  const started = asObject(await readUnityResource(context, startMethod, params));
  const operationId = started.operationId;
  if (typeof operationId !== "string") {
    return started;
  }

  const startedAt = Date.now();
  let lastStatus: unknown = started;
  while (Date.now() - startedAt < timeoutMs) {
    lastStatus = await readUnityResource(context, "operation.get", { operationId });
    const state = asObject(asObject(lastStatus).state);
    if (state.status !== "running") {
      return lastStatus;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return lastStatus;
}

function firstVariable(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return value ?? "";
}

function registerCoreResources(server: McpServer, context: ToolContext): void {
  registerJsonResource(
    server,
    "Unity MCP Ghost Capabilities",
    "unity://capabilities",
    "Discover Ghost tools, risk levels, dry-run support, and resource affordances.",
    () => ({
      ok: true,
      server: "unity-mcp-ghost",
      principles: [
        "Prefer resources for read-heavy state.",
        "Prefer dryRun before mutating Unity state.",
        "Use batch_execute to fuse repetitive operations.",
        "Use confidence and diagnostics before continuing an agentic workflow."
      ],
      resources: [
        "unity://capabilities",
        "unity://editor/state",
        "unity://scenes/active",
        "unity://console/errors",
        "unity://packages",
        "unity://operations",
        "unity://gameobject/{instanceId}",
        "unity://component/{instanceId}/{type}",
        "unity://assets/{filter}",
        "unity://operation/{operationId}",
        "unity://tests/{mode}"
      ],
      tools: RegisteredToolCatalog.map((tool) => ({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        mutates: tool.mutates,
        supportsDryRun: tool.supportsDryRun,
        phase: tool.phase,
        relatedResources: tool.relatedResources ?? []
      }))
    })
  );

  registerJsonResource(
    server,
    "Unity Editor State",
    "unity://editor/state",
    "Read current Unity Editor state without invoking a mutating tool.",
    () => readUnityResource(context, "editor.get_state")
  );

  registerJsonResource(
    server,
    "Unity Active Scene Hierarchy",
    "unity://scenes/active",
    "Read the active scene hierarchy as deterministic JSON.",
    () => readUnityResource(context, "scene.get_hierarchy", { includeInactive: true, maxDepth: 32 })
  );

  registerJsonResource(
    server,
    "Unity Console Errors",
    "unity://console/errors",
    "Read recent Unity console errors for validation and repair workflows.",
    () => readUnityResource(context, "console.get_logs", { severity: "error", limit: 200 })
  );

  registerJsonResource(
    server,
    "Unity Packages",
    "unity://packages",
    "Read Unity Package Manager packages through a short-polled operation.",
    () => readUnityOperationResource(context, "package.list", { includeIndirect: true, includeOffline: true })
  );

  registerJsonResource(
    server,
    "Unity Ghost Operations",
    "unity://operations",
    "List long-running Ghost operations tracked in the Unity editor session.",
    () => readUnityResource(context, "operation.list")
  );

  registerJsonResourceTemplate(
    server,
    "Unity GameObject",
    "unity://gameobject/{instanceId}",
    "Read a GameObject by Unity instance id.",
    (variables) => readUnityResource(context, "gameobject.get", { instanceId: Number.parseInt(firstVariable(variables.instanceId), 10) })
  );

  registerJsonResourceTemplate(
    server,
    "Unity Component",
    "unity://component/{instanceId}/{type}",
    "Read a component by owning GameObject instance id and component type.",
    (variables) =>
      readUnityResource(context, "component.get", {
        instanceId: Number.parseInt(firstVariable(variables.instanceId), 10),
        type: decodeURIComponent(firstVariable(variables.type))
      })
  );

  registerJsonResourceTemplate(
    server,
    "Unity Assets",
    "unity://assets/{filter}",
    "Find Unity assets through AssetDatabase using a URI path filter.",
    (variables) => readUnityResource(context, "asset.find", { query: decodeURIComponent(firstVariable(variables.filter)), limit: 100 })
  );

  registerJsonResourceTemplate(
    server,
    "Unity Ghost Operation",
    "unity://operation/{operationId}",
    "Read a tracked Ghost operation status.",
    (variables) => readUnityResource(context, "operation.get", { operationId: firstVariable(variables.operationId) })
  );

  registerJsonResourceTemplate(
    server,
    "Unity Test Runner Plan",
    "unity://tests/{mode}",
    "Read a dry-run test execution plan for EditMode or PlayMode.",
    (variables) => readUnityResource(context, "tests.run", { mode: firstVariable(variables.mode), dryRun: true })
  );
}

function registerCorePrompts(server: McpServer): void {
  server.registerPrompt(
    "ghost_inspect_project",
    {
      title: "Inspect Unity Project",
      description: "Plan a read-only Unity project inspection using resources before tools.",
      argsSchema: {
        focus: z.string().default("general project health")
      }
    },
    ({ focus }) => ({
      description: "Read-only inspection workflow for Unity MCP Ghost.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Inspect this Unity project with focus: ${focus}.\n\n` +
              "Start with unity://capabilities, unity://editor/state, unity://scenes/active, and unity://console/errors. " +
              "Prefer resources for context loading, then call read-only tools only when a resource is insufficient. " +
              "Return findings grouped by risk, and recommend dry-run tool calls for any proposed mutation."
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "ghost_repair_loop_plan",
    {
      title: "Plan Validate Repair Test Loop",
      description: "Plan a safe Ghost repair workflow using diagnostics, dry-run, batch execution, and rollback-aware steps.",
      argsSchema: {
        objective: z.string(),
        maxIterations: z.number().int().positive().max(10).default(3)
      }
    },
    ({ objective, maxIterations }) => ({
      description: "Dry-run-first repair-loop planning workflow for Unity MCP Ghost.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Plan a Ghost repair loop for this objective: ${objective}\n\n` +
              `Use at most ${maxIterations} iterations. Start with console diagnostics and project state resources. ` +
              "For every mutation, call the tool with dryRun=true first, inspect diagnostics and confidence, then execute the smallest safe change. " +
              "Use batch_execute for repetitive Unity operations, and stop if confidence drops or new console errors appear."
          }
        }
      ]
    })
  );
}

function registerUnityRequestTool<TSchema extends ToolSchema>(
  server: McpServer,
  context: ToolContext,
  name: string,
  description: string,
  inputSchema: TSchema,
  meta: GhostToolMeta,
  method: string | ((args: z.output<z.ZodObject<TSchema>>) => string),
  params: (args: z.output<z.ZodObject<TSchema>>) => unknown = (args) => args
): void {
  registerTool(server, name, description, inputSchema, meta, async (args) => {
    const startedAt = Date.now();
    const unityMethod = typeof method === "function" ? method(args) : method;

    try {
      const data = await context.unity.request(unityMethod, params(args));
      return successResponse(`${name} completed.`, asObject(data), startedAt);
    } catch (error) {
      return failureResponse(`${name} failed`, error, startedAt);
    }
  });
}

export function createMcpServer(context: ToolContext): McpServer {
  const server = new McpServer({
    name: "unity-mcp-ghost",
    version: "0.1.0"
  });

  registerTool(
    server,
    "ping",
    "Verify that the MCP server is alive and report Unity bridge reachability.",
    EmptySchema,
    { risk: "read", mutates: false, supportsDryRun: false, phase: 1 },
    async () => {
      const startedAt = Date.now();
      const unityConnected = await context.unity.isConnected();

      return successResponse(
        `Unity MCP Ghost is running. Unity connected: ${unityConnected}.`,
        {
          server: "unity-mcp-ghost",
          unityConnected,
          unityEndpoint: context.unity.endpoint,
          queueEndpoint: context.unity.queueEndpoint ?? null
        },
        startedAt,
        { confidence: unityConnected ? 1 : 0.6 }
      );
    }
  );

  registerTool(
    server,
    "health",
    "Read Unity bridge health, endpoint, package version, and editor status.",
    EmptySchema,
    { risk: "read", mutates: false, supportsDryRun: false, phase: 1 },
    async () => {
      const startedAt = Date.now();
      const unityConnected = await context.unity.isConnected();

      if (!unityConnected) {
        return successResponse(
          "Unity bridge is not connected.",
          {
            unityConnected,
            unityEndpoint: context.unity.endpoint,
            queueEndpoint: context.unity.queueEndpoint ?? null
          },
          startedAt,
          {
            confidence: 0.6,
            diagnostics: [
              {
                severity: "warning",
                message: "Start the bridge from Window > Unity MCP Ghost in the Unity Editor."
              }
            ]
          }
        );
      }

      try {
        const data = await context.unity.request("health");
        return successResponse("Unity bridge health retrieved.", asObject(data), startedAt);
      } catch (error) {
        return failureResponse("health failed", error, startedAt);
      }
    }
  );

  registerUnityRequestTool(
    server,
    context,
    "editor_state_get",
    "Read Unity editor state, including play mode and compilation status.",
    EmptySchema,
    { risk: "read", mutates: false, supportsDryRun: false, phase: 1, relatedResources: ["unity://editor/state"] },
    "editor.get_state"
  );

  registerUnityRequestTool(
    server,
    context,
    "unity_get_editor_state",
    "Compatibility alias for editor_state_get.",
    EmptySchema,
    { risk: "read", mutates: false, supportsDryRun: false, phase: 1, relatedResources: ["unity://editor/state"] },
    "editor.get_state"
  );

  registerUnityRequestTool(
    server,
    context,
    "console_read",
    "Read Unity console logs, optionally filtered by severity.",
    {
      severity: z.enum(["log", "warning", "error", "all"]).default("all"),
      limit: z.number().int().positive().max(1000).default(200)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 1, relatedResources: ["unity://console/{level}"] },
    "console.get_logs"
  );

  registerUnityRequestTool(
    server,
    context,
    "unity_get_console_logs",
    "Compatibility alias for console_read.",
    {
      severity: z.enum(["log", "warning", "error", "all"]).default("all"),
      limit: z.number().int().positive().max(1000).default(200)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 1, relatedResources: ["unity://console/{level}"] },
    "console.get_logs"
  );

  registerUnityRequestTool(
    server,
    context,
    "scene_hierarchy_get",
    "Read the hierarchy for the active Unity scene.",
    {
      includeInactive: z.boolean().default(true),
      maxDepth: z.number().int().positive().max(64).default(32)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 1, relatedResources: ["unity://scenes/active"] },
    "scene.get_hierarchy"
  );

  registerUnityRequestTool(
    server,
    context,
    "unity_get_scene_hierarchy",
    "Compatibility alias for scene_hierarchy_get.",
    {
      includeInactive: z.boolean().default(true),
      maxDepth: z.number().int().positive().max(64).default(32)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 1, relatedResources: ["unity://scenes/active"] },
    "scene.get_hierarchy"
  );

  registerUnityRequestTool(
    server,
    context,
    "gameobject_create",
    "Create a GameObject or primitive with optional transform fields.",
    {
      name: z.string().min(1).default("GameObject"),
      primitive: z.enum(["Cube", "Sphere", "Capsule", "Cylinder", "Plane", "Quad"]).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      rotationX: z.number().optional(),
      rotationY: z.number().optional(),
      rotationZ: z.number().optional(),
      scaleX: z.number().optional(),
      scaleY: z.number().optional(),
      scaleZ: z.number().optional(),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 1 },
    (args) => (args.primitive ? "gameobject.create_primitive" : "gameobject.create")
  );

  registerUnityRequestTool(
    server,
    context,
    "transform_set",
    "Set a GameObject transform by instance ID.",
    TransformSchema,
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 1 },
    "gameobject.set_transform"
  );

  registerUnityRequestTool(
    server,
    context,
    "scene_save",
    "Save the active Unity scene.",
    {
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 1 },
    "scene.save"
  );

  registerUnityRequestTool(
    server,
    context,
    "screenshot_capture",
    "Capture a Unity screenshot to Library/UnityMcpGhost/screenshots.",
    {
      superSize: z.number().int().positive().max(8).default(1),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 1 },
    "screenshot.capture"
  );

  registerUnityRequestTool(
    server,
    context,
    "scene_create",
    "Create a new Unity scene for level, menu, or gameplay prototyping work.",
    {
      setup: z.enum(["empty", "default"]).default("default"),
      mode: z.enum(["single", "additive"]).default("single"),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "scene.create"
  );

  registerUnityRequestTool(
    server,
    context,
    "scene_open",
    "Open a Unity scene asset by path.",
    {
      path: z.string().min(1),
      mode: z.enum(["single", "additive"]).default("single"),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "scene.open"
  );

  registerUnityRequestTool(
    server,
    context,
    "scene_set_active",
    "Set the active Unity scene by path or name.",
    {
      path: z.string().optional(),
      name: z.string().optional(),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "scene.set_active"
  );

  registerUnityRequestTool(
    server,
    context,
    "scene_unload",
    "Unload an open additive Unity scene by path or name.",
    {
      path: z.string().optional(),
      name: z.string().optional(),
      removeScene: z.boolean().default(true),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "scene.unload"
  );

  registerUnityRequestTool(
    server,
    context,
    "manage_scene",
    "Compatibility tool for scene actions.",
    {
      action: z.enum(["create", "open", "save", "save_all", "list_open", "get_setup", "set_active", "unload"]),
      params: ParamsSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    (args) => `scene.${args.action}`,
    (args) => args.params
  );

  registerUnityRequestTool(
    server,
    context,
    "component_add",
    "Add a Unity component to a GameObject by type name, such as BoxCollider, Rigidbody, AudioSource, or a project MonoBehaviour.",
    {
      instanceId: z.number().int(),
      type: z.string().min(1),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "component.add"
  );

  registerUnityRequestTool(
    server,
    context,
    "component_get",
    "Read components on a GameObject, or read one component by component instance ID.",
    {
      instanceId: z.number().int().optional(),
      componentInstanceId: z.number().int().optional(),
      type: z.string().optional(),
      maxProperties: z.number().int().positive().max(200).default(80)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 2 },
    "component.get"
  );

  registerUnityRequestTool(
    server,
    context,
    "component_modify",
    "Modify a serialized component property through Unity SerializedObject, with dry-run support.",
    {
      componentInstanceId: z.number().int().optional(),
      instanceId: z.number().int().optional(),
      type: z.string().optional(),
      propertyPath: z.string().min(1),
      value: ComponentValueSchema,
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "component.modify"
  );

  registerUnityRequestTool(
    server,
    context,
    "component_remove",
    "Remove a Unity component by component instance ID.",
    {
      componentInstanceId: z.number().int(),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "component.remove"
  );

  registerUnityRequestTool(
    server,
    context,
    "manage_component",
    "Compatibility tool for component add/get/modify/remove actions.",
    {
      action: z.enum(["add", "get", "modify", "remove"]),
      params: ParamsSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    (args) => `component.${args.action}`,
    (args) => args.params
  );

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
    { risk: "read", mutates: false, supportsDryRun: false, phase: 2, relatedResources: ["unity://assets?filter=..."] },
    "asset.find"
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
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
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
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
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
      dryRun: DryRunSchema
    },
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
    "script.delete"
  );

  registerUnityRequestTool(
    server,
    context,
    "manage_script",
    "Compatibility tool for C# script read/create/write/delete actions.",
    {
      action: z.enum(["read", "create", "write", "apply_edits", "delete"]),
      params: ParamsSchema
    },
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
    (args) => `script.${args.action}`,
    (args) => args.params
  );

  registerUnityRequestTool(
    server,
    context,
    "package_list",
    "Start a Unity Package Manager list operation and poll it with operation_get.",
    {
      includeIndirect: z.boolean().default(true),
      includeOffline: z.boolean().default(true)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 2, relatedResources: ["unity://packages"] },
    "package.list"
  );

  registerUnityRequestTool(
    server,
    context,
    "package_search",
    "Start a Unity Package Manager package search operation and poll it with operation_get.",
    {
      query: z.string().default("")
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 2, relatedResources: ["unity://packages"] },
    "package.search"
  );

  registerUnityRequestTool(
    server,
    context,
    "package_add",
    "Add a Unity package by id, git URL, tarball, or scoped registry package name.",
    {
      packageId: z.string().min(1),
      dryRun: DryRunSchema
    },
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
    "package.add"
  );

  registerUnityRequestTool(
    server,
    context,
    "package_remove",
    "Remove a Unity package by package name.",
    {
      packageName: z.string().min(1),
      dryRun: DryRunSchema
    },
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
    "package.remove"
  );

  registerUnityRequestTool(
    server,
    context,
    "manage_package",
    "Compatibility tool for Unity Package Manager list/search/add/remove actions.",
    {
      action: z.enum(["list", "search", "add", "remove"]),
      params: ParamsSchema
    },
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
    (args) => `package.${args.action}`,
    (args) => args.params
  );

  registerUnityRequestTool(
    server,
    context,
    "operation_get",
    "Read the latest status for a long-running Ghost operation such as package manager work or tests.",
    {
      operationId: z.string().min(1)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 2 },
    "operation.get"
  );

  registerUnityRequestTool(
    server,
    context,
    "operation_list",
    "List Ghost operations currently tracked in the Unity editor session.",
    EmptySchema,
    { risk: "read", mutates: false, supportsDryRun: false, phase: 2 },
    "operation.list"
  );

  registerUnityRequestTool(
    server,
    context,
    "tests_run",
    "Run Unity EditMode or PlayMode tests through the Unity Test Runner and poll with operation_get.",
    {
      mode: z.enum(["editmode", "playmode"]).default("editmode"),
      filter: z.string().default(""),
      dryRun: DryRunSchema
    },
    { risk: "test-execution", mutates: false, supportsDryRun: true, phase: 2, relatedResources: ["unity://tests/{mode}"] },
    "tests.run"
  );

  registerUnityRequestTool(
    server,
    context,
    "prefab_create",
    "Create or update a prefab asset from a scene GameObject.",
    {
      instanceId: z.number().int(),
      path: z.string().min(1),
      connect: z.boolean().default(true),
      dryRun: DryRunSchema
    },
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
    "prefab.create"
  );

  registerUnityRequestTool(
    server,
    context,
    "prefab_instantiate",
    "Instantiate a prefab asset into the active scene with optional placement.",
    {
      path: z.string().min(1),
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      rotationX: z.number().optional(),
      rotationY: z.number().optional(),
      rotationZ: z.number().optional(),
      scaleX: z.number().optional(),
      scaleY: z.number().optional(),
      scaleZ: z.number().optional(),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "prefab.instantiate"
  );

  registerUnityRequestTool(
    server,
    context,
    "manage_prefab",
    "Compatibility tool for prefab create/instantiate actions.",
    {
      action: z.enum(["create", "instantiate"]),
      params: ParamsSchema
    },
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
    (args) => `prefab.${args.action}`,
    (args) => args.params
  );

  registerUnityRequestTool(
    server,
    context,
    "gameobject_duplicate",
    "Duplicate a GameObject prototype in the active scene with Undo support.",
    {
      instanceId: z.number().int(),
      name: z.string().optional(),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "gameobject.duplicate"
  );

  registerUnityRequestTool(
    server,
    context,
    "gameobject_set_parent",
    "Parent a GameObject under another GameObject, or move it to the scene root.",
    {
      instanceId: z.number().int(),
      parentInstanceId: z.number().int().optional(),
      worldPositionStays: z.boolean().default(true),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "gameobject.set_parent"
  );

  registerUnityRequestTool(
    server,
    context,
    "manage_gameobject",
    "Compatibility tool for GameObject actions.",
    {
      action: z.enum(["create", "create_primitive", "set_transform", "find", "get", "delete", "duplicate", "set_parent"]),
      params: ParamsSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    (args) => `gameobject.${args.action}`,
    (args) => args.params
  );

  registerUnityRequestTool(
    server,
    context,
    "batch_execute",
    "Execute multiple Unity bridge commands in a single request.",
    {
      operations: z
        .array(
          z.object({
            method: z.string().min(1),
            params: z.record(z.string(), z.unknown()).default({})
          })
        )
        .min(1)
        .max(100),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 2 },
    "batch.execute"
  );

  registerCoreResources(server, context);
  registerCorePrompts(server);

  return server;
}
