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
const DiagnosticInputSchema = z.object({}).passthrough();

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

async function pollOperation(context: ToolContext, operationId: string, timeoutMs: number, intervalMs = 250): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let last = asObject(await context.unity.request("operation.get", { operationId }));
  while (Date.now() - startedAt < timeoutMs) {
    const state = asObject(last.state);
    if (state.status !== "running") {
      return last;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = asObject(await context.unity.request("operation.get", { operationId }));
  }

  return last;
}

async function waitForUnityCompile(context: ToolContext, timeoutMs: number, intervalMs = 250): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let state = asObject(await context.unity.request("editor.get_state"));
  while (Date.now() - startedAt < timeoutMs) {
    if (state.isCompiling !== true && state.isUpdating !== true) {
      return {
        ok: true,
        status: "success",
        elapsedMs: Date.now() - startedAt,
        state
      };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    state = asObject(await context.unity.request("editor.get_state"));
  }

  return {
    ok: false,
    status: "timeout",
    elapsedMs: Date.now() - startedAt,
    state
  };
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function diagnosticsFromPayload(payload: Record<string, unknown>): Record<string, unknown>[] {
  const direct = arrayValue(payload.diagnostics);
  if (direct.length > 0) {
    return direct.map(asObject);
  }

  const result = asObject(payload.result);
  return arrayValue(result.diagnostics).map(asObject);
}

function diagnosticCount(payload: Record<string, unknown>): number {
  return diagnosticsFromPayload(payload).length;
}

async function compilerFirstDiagnostics(
  context: ToolContext,
  pathFilter: string,
  severity = "error",
  limit = 100
): Promise<{ diagnostics: Record<string, unknown>[]; source: string; compile: Record<string, unknown>; console: Record<string, unknown> | null }> {
  const compile = asObject(
    await context.unity.request("compile.diagnostics_get", {
      severity,
      pathFilter,
      limit
    })
  );
  const compileDiagnostics = diagnosticsFromPayload(compile);
  if (compileDiagnostics.length > 0) {
    return {
      diagnostics: compileDiagnostics,
      source: "compilation-pipeline",
      compile,
      console: null
    };
  }

  const consoleDiagnostics = asObject(
    await context.unity.request("console.diagnostics_get", {
      severity,
      pathFilter,
      limit
    })
  );
  return {
    diagnostics: diagnosticsFromPayload(consoleDiagnostics),
    source: "console-log-buffer",
    compile,
    console: consoleDiagnostics
  };
}

function diagnosticCode(message: string): string {
  return message.match(/\b(CS\d{4})\b/)?.[1] ?? "";
}

function lineColumnEdit(lines: string[], line: number, column: number, text: string): z.infer<typeof ScriptEditSchema> {
  const lineIndex = Math.max(0, line - 1);
  const currentLine = lines[lineIndex] ?? "";
  const columnIndex = Math.max(0, Math.min(currentLine.length, column > 0 ? column - 1 : currentLine.length));
  return {
    startLine: lineIndex,
    startColumn: columnIndex,
    endLine: lineIndex,
    endColumn: columnIndex,
    text
  };
}

function buildPatchProposals(diagnostics: Record<string, unknown>[], scriptPath: string, scriptContent: string): Record<string, unknown>[] {
  const lines = scriptContent.split(/\r\n|\n|\r/);

  return diagnostics.map((diagnostic, index) => {
    const message = stringValue(diagnostic.message);
    const code = diagnosticCode(message);
    const line = numberValue(diagnostic.line);
    const column = numberValue(diagnostic.column);
    const file = stringValue(diagnostic.file) || scriptPath;
    const proposal: Record<string, unknown> = {
      id: `patch-${index + 1}`,
      diagnostic: {
        code,
        message,
        file,
        line,
        column
      },
      confidence: 0.35,
      edits: [],
      rationale: "Diagnostic needs human or agent review before a safe ranged edit can be generated.",
      verification: ["Run script_validate after applying any edit.", "Run compile_wait before reading follow-up diagnostics."]
    };

    if (code === "CS1002" && scriptPath && line > 0) {
      const edit = lineColumnEdit(lines, line, column, ";");
      proposal.summary = "Insert the missing semicolon reported by the C# compiler.";
      proposal.confidence = 0.68;
      proposal.rationale = "CS1002 is usually local and the compiler location is precise enough for a dry-run ranged insert.";
      proposal.edits = [edit];
      proposal.dryRunToolCall = {
        name: "script_apply_edits",
        arguments: {
          path: scriptPath,
          edits: [edit],
          dryRun: true
        }
      };
      return proposal;
    }

    if (code === "CS1513" && scriptPath && lines.length > 0) {
      const lastColumn = (lines[lines.length - 1]?.length ?? 0) + 1;
      const edit = lineColumnEdit(lines, lines.length, lastColumn, "\n}");
      proposal.summary = "Consider adding a missing closing brace near the end of the script.";
      proposal.confidence = 0.45;
      proposal.rationale = "CS1513 can cascade from earlier syntax errors, so Ghost only proposes a dry-run edit with low confidence.";
      proposal.edits = [edit];
      proposal.dryRunToolCall = {
        name: "script_apply_edits",
        arguments: {
          path: scriptPath,
          edits: [edit],
          dryRun: true
        }
      };
      return proposal;
    }

    if (code === "CS0246") {
      proposal.summary = "Resolve the missing type or namespace before editing gameplay code.";
      proposal.rationale = "In Unity projects this often means a missing using directive, asmdef reference, package, or renamed MonoBehaviour type.";
      proposal.verification = [
        "Search project scripts and assemblies for the missing type.",
        "Inspect asmdef references if the type exists in another assembly.",
        "Use package_list before adding Unity packages such as Input System, Cinemachine, Addressables, or AR Foundation."
      ];
      return proposal;
    }

    if (code === "CS0103") {
      proposal.summary = "Resolve an unknown symbol in the local gameplay script context.";
      proposal.rationale = "This may be a missing field, typo, renamed component property, or variable that moved during refactor.";
      proposal.verification = [
        "Read the containing method and class members before proposing edits.",
        "Check Inspector-wired fields and prefab references before deleting or renaming symbols."
      ];
      return proposal;
    }

    if (code === "CS1061") {
      proposal.summary = "Resolve a missing member or extension method on a Unity/gameplay type.";
      proposal.rationale = "This often indicates an API version mismatch, missing using directive, or a component type mismatch.";
      proposal.verification = [
        "Confirm the receiver type from source before editing.",
        "Check package versions and Unity API availability for the active editor version."
      ];
      return proposal;
    }

    proposal.summary = code ? `Review compiler diagnostic ${code}.` : "Review diagnostic before proposing edits.";
    return proposal;
  });
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
    "console_diagnostics_get",
    "Read structured Unity console diagnostics grouped for repair-loop workflows.",
    {
      severity: z.enum(["error", "warning", "all"]).default("error"),
      pathFilter: z.string().default(""),
      limit: z.number().int().positive().max(500).default(100)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3, relatedResources: ["unity://console/errors"] },
    "console.diagnostics_get"
  );

  registerUnityRequestTool(
    server,
    context,
    "compile_diagnostics_get",
    "Read structured C# compiler diagnostics captured from Unity's compilation pipeline.",
    {
      severity: z.enum(["error", "warning", "all"]).default("error"),
      pathFilter: z.string().default(""),
      limit: z.number().int().positive().max(500).default(100)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3, relatedResources: ["unity://console/errors"] },
    "compile.diagnostics_get"
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
    "script_validate",
    "Import and validate a Unity C# script, returning bridge-session compiler diagnostics for repair loops.",
    {
      path: z.string().min(1),
      limit: z.number().int().positive().max(500).default(100),
      dryRun: DryRunSchema
    },
    { risk: "read", mutates: false, supportsDryRun: true, phase: 3, relatedResources: ["unity://console/errors"] },
    "script.validate"
  );

  registerUnityRequestTool(
    server,
    context,
    "manage_script",
    "Compatibility tool for C# script read/create/write/apply_edits/delete/validate actions.",
    {
      action: z.enum(["read", "create", "write", "apply_edits", "delete", "validate"]),
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

  registerTool(
    server,
    "compile_wait",
    "Wait until Unity is no longer compiling or updating by polling editor state from the MCP server.",
    {
      timeoutMs: z.number().int().positive().max(300000).default(30000)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3 },
    async (args) => {
      const startedAt = Date.now();
      try {
        const data = await waitForUnityCompile(context, args.timeoutMs);
        return successResponse("compile_wait completed.", data, startedAt, {
          confidence: data.status === "success" ? 1 : 0.5
        });
      } catch (error) {
        return failureResponse("compile_wait failed", error, startedAt);
      }
    }
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

  registerTool(
    server,
    "patch_propose",
    "Propose deterministic, dry-run-first ranged edit plans from Unity/C# diagnostics without mutating project files.",
    {
      objective: z.string().default("Repair Unity C# diagnostics safely."),
      scriptPath: z.string().optional(),
      diagnostics: z.array(DiagnosticInputSchema).optional(),
      severity: z.enum(["error", "warning", "all"]).default("error"),
      limit: z.number().int().positive().max(100).default(20),
      previewDryRuns: z.boolean().default(false)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3, relatedResources: ["unity://console/errors"] },
    async (args) => {
      const startedAt = Date.now();
      try {
        let diagnostics = args.diagnostics?.map(asObject) ?? [];
        let diagnosticSource: Record<string, unknown> | null = null;

        if (diagnostics.length === 0) {
          const collected = await compilerFirstDiagnostics(context, args.scriptPath ?? "", args.severity, args.limit);
          diagnostics = collected.diagnostics;
          diagnosticSource = {
            source: collected.source,
            compile: collected.compile,
            console: collected.console
          };
        }

        let scriptContent = "";
        if (args.scriptPath) {
          const script = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
          scriptContent = stringValue(script.content);
        }

        const proposals = buildPatchProposals(diagnostics, args.scriptPath ?? "", scriptContent);
        const dryRunPreviews: unknown[] = [];
        if (args.previewDryRuns && args.scriptPath) {
          for (const proposal of proposals) {
            const dryRunToolCall = asObject(proposal.dryRunToolCall);
            const dryRunArgs = asObject(dryRunToolCall.arguments);
            if (dryRunToolCall.name === "script_apply_edits" && arrayValue(dryRunArgs.edits).length > 0) {
              dryRunPreviews.push({
                proposalId: proposal.id,
                result: await context.unity.request("script.apply_edits", dryRunArgs)
              });
            }
          }
        }

        return successResponse(
          "patch_propose completed.",
          {
            ok: true,
            objective: args.objective,
            scriptPath: args.scriptPath ?? null,
            diagnosticCount: diagnostics.length,
            proposalCount: proposals.length,
            proposals,
            dryRunPreviews,
            source: diagnosticSource,
            nextActions: proposals.length > 0
              ? ["Review proposal confidence and rationale.", "Apply only high-confidence proposals through script_apply_edits with dryRun=true first.", "Run compile_wait and script_validate after any accepted edit."]
              : ["No diagnostics were available for patch proposal."]
          },
          startedAt,
          {
            confidence: proposals.length === 0 ? 0.8 : Math.max(...proposals.map((proposal) => numberValue(proposal.confidence)))
          }
        );
      } catch (error) {
        return failureResponse("patch_propose failed", error, startedAt);
      }
    }
  );

  registerTool(
    server,
    "repair_apply_edits",
    "Preview or apply explicit ranged C# repair edits, wait for Unity compile, revalidate diagnostics, and roll back on failure.",
    {
      objective: z.string().default("Apply an explicit Unity C# repair safely."),
      scriptPath: z.string().min(1),
      edits: z.array(ScriptEditSchema).min(1),
      dryRun: DryRunSchema,
      rollbackOnFailure: z.boolean().default(true),
      compileTimeoutMs: z.number().int().positive().max(300000).default(30000),
      runTests: z.boolean().default(false),
      testMode: z.enum(["editmode", "playmode"]).default("editmode"),
      testFilter: z.string().default("")
    },
    { risk: "code-write", mutates: true, supportsDryRun: true, phase: 3, relatedResources: ["unity://console/errors", "unity://tests/{mode}"] },
    async (args) => {
      const startedAt = Date.now();
      try {
        const steps: unknown[] = [];
        const script = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
        const originalContent = stringValue(script.content);
        steps.push({ name: "script_read_backup", ok: script.ok, data: { path: args.scriptPath, originalBytes: Buffer.byteLength(originalContent, "utf8") } });

        const dryRunPreview = asObject(
          await context.unity.request("script.apply_edits", {
            path: args.scriptPath,
            edits: args.edits,
            dryRun: true
          })
        );
        steps.push({ name: "script_apply_edits_dry_run", ok: dryRunPreview.ok, data: dryRunPreview });

        if (args.dryRun) {
          return successResponse(
            "repair_apply_edits completed dry-run preview.",
            {
              ok: true,
              mode: "dry-run",
              objective: args.objective,
              scriptPath: args.scriptPath,
              editCount: args.edits.length,
              steps,
              nextActions: ["Review the dry-run preview.", "Rerun with dryRun=false only after accepting the ranged edits."]
            },
            startedAt
          );
        }

        const applyResult = asObject(
          await context.unity.request("script.apply_edits", {
            path: args.scriptPath,
            edits: args.edits,
            dryRun: false
          })
        );
        steps.push({ name: "script_apply_edits", ok: applyResult.ok, data: applyResult });

        const compileStatus = await waitForUnityCompile(context, args.compileTimeoutMs);
        steps.push({ name: "compile_wait", ok: compileStatus.ok, data: compileStatus });

        const validation = asObject(await context.unity.request("script.validate", { path: args.scriptPath, limit: 100 }));
        steps.push({ name: "script_validate", ok: validation.ok, data: validation });

        const compileDiagnostics = asObject(
          await context.unity.request("compile.diagnostics_get", {
            severity: "error",
            pathFilter: args.scriptPath,
            limit: 100
          })
        );
        steps.push({ name: "compile_diagnostics_get", ok: compileDiagnostics.ok, data: compileDiagnostics });

        const diagnostics = asObject(
          await context.unity.request("console.diagnostics_get", {
            severity: "error",
            pathFilter: args.scriptPath,
            limit: 100
          })
        );
        steps.push({ name: "console_diagnostics_get", ok: diagnostics.ok, data: diagnostics });

        let tests: Record<string, unknown> | null = null;
        if (args.runTests) {
          const testStart = asObject(
            await context.unity.request("tests.run", {
              mode: args.testMode,
              filter: args.testFilter
            })
          );
          tests = typeof testStart.operationId === "string" ? await pollOperation(context, testStart.operationId, 120000, 500) : testStart;
          steps.push({ name: "tests_run", ok: tests.ok, data: tests });
        }

        const scopedErrorCount = Math.max(diagnosticCount(validation), diagnosticCount(diagnostics));
        const compilerErrorCount = diagnosticCount(compileDiagnostics);
        const effectiveErrorCount = Math.max(scopedErrorCount, compilerErrorCount);
        const testState = tests ? asObject(tests.state) : {};
        const testsFailed = tests ? testState.status === "failed" || tests.status === "failed" : false;
        const shouldRollback = args.rollbackOnFailure && (compileStatus.ok === false || effectiveErrorCount > 0 || testsFailed);
        let rollback: Record<string, unknown> | null = null;

        if (shouldRollback) {
          const writeBack = asObject(
            await context.unity.request("script.write", {
              path: args.scriptPath,
              content: originalContent,
              overwrite: true,
              dryRun: false
            })
          );
          const rollbackCompile = await waitForUnityCompile(context, args.compileTimeoutMs);
          const rollbackValidation = asObject(await context.unity.request("script.validate", { path: args.scriptPath, limit: 100 }));
          rollback = {
            writeBack,
            compile: rollbackCompile,
            validation: rollbackValidation
          };
          steps.push({ name: "rollback_script_write", ok: writeBack.ok, data: writeBack });
          steps.push({ name: "rollback_compile_wait", ok: rollbackCompile.ok, data: rollbackCompile });
          steps.push({ name: "rollback_script_validate", ok: rollbackValidation.ok, data: rollbackValidation });
        }

        return successResponse(
          shouldRollback ? "repair_apply_edits applied edits then rolled back after validation failure." : "repair_apply_edits applied edits and revalidated.",
          {
            ok: !shouldRollback && scopedErrorCount === 0 && compileStatus.ok !== false && !testsFailed,
            mode: shouldRollback ? "rolled-back" : "applied",
            objective: args.objective,
            scriptPath: args.scriptPath,
            editCount: args.edits.length,
            scopedErrorCount: effectiveErrorCount,
            compilerErrorCount,
            consoleErrorCount: diagnosticCount(diagnostics),
            testsFailed,
            rollback,
            steps,
            nextActions: shouldRollback
              ? ["Inspect validation diagnostics and request a new patch_propose pass before trying another edit."]
              : ["Run repair_loop_run or tests_run for broader project validation if this script participates in gameplay flows."]
          },
          startedAt,
          {
            confidence: shouldRollback ? 0.4 : 0.9
          }
        );
      } catch (error) {
        return failureResponse("repair_apply_edits failed", error, startedAt);
      }
    }
  );

  registerTool(
    server,
    "repair_loop_run",
    "Run the first Ghost repair-loop skeleton: validate, wait for compile, read diagnostics, and optionally run tests.",
    {
      objective: z.string().min(1),
      scriptPath: z.string().optional(),
      maxIterations: z.number().int().positive().max(5).default(1),
      compileTimeoutMs: z.number().int().positive().max(300000).default(30000),
      runTests: z.boolean().default(false),
      testMode: z.enum(["editmode", "playmode"]).default("editmode"),
      testFilter: z.string().default("")
    },
    { risk: "test-execution", mutates: false, supportsDryRun: false, phase: 3, relatedResources: ["unity://console/errors", "unity://tests/{mode}"] },
    async (args) => {
      const startedAt = Date.now();
      try {
        const steps: unknown[] = [];
        const editorState = asObject(await context.unity.request("editor.get_state"));
        steps.push({ name: "editor_state", ok: editorState.ok, data: editorState });

        let validation: Record<string, unknown> | undefined;
        if (args.scriptPath) {
          validation = asObject(await context.unity.request("script.validate", { path: args.scriptPath, limit: 100 }));
          steps.push({ name: "script_validate", ok: validation.ok, data: validation });
        }

        const compileStatus = await waitForUnityCompile(context, args.compileTimeoutMs);
        steps.push({ name: "compile_wait", ok: compileStatus.ok, data: compileStatus });

        const compileDiagnostics = asObject(
          await context.unity.request("compile.diagnostics_get", {
            severity: "error",
            pathFilter: args.scriptPath ?? "",
            limit: 100
          })
        );
        steps.push({ name: "compile_diagnostics_get", ok: compileDiagnostics.ok, data: compileDiagnostics });

        const diagnostics = asObject(
          await context.unity.request("console.diagnostics_get", {
            severity: "error",
            pathFilter: args.scriptPath ?? "",
            limit: 100
          })
        );
        steps.push({ name: "console_diagnostics_get", ok: diagnostics.ok, data: diagnostics });

        const compileDiagnosticList = diagnosticsFromPayload(compileDiagnostics);
        const consoleDiagnosticList = diagnosticsFromPayload(diagnostics);
        const diagnosticList = compileDiagnosticList.length > 0 ? compileDiagnosticList : consoleDiagnosticList;
        let patchProposals: Record<string, unknown>[] = [];
        if (args.scriptPath && diagnosticList.length > 0) {
          const script = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
          patchProposals = buildPatchProposals(diagnosticList, args.scriptPath, stringValue(script.content));
          steps.push({ name: "patch_propose", ok: true, data: { proposalCount: patchProposals.length, proposals: patchProposals } });
        }

        let tests: Record<string, unknown>;
        if (args.runTests) {
          const testStart = asObject(
            await context.unity.request("tests.run", {
              mode: args.testMode,
              filter: args.testFilter
            })
          );
          tests = typeof testStart.operationId === "string" ? await pollOperation(context, testStart.operationId, 120000, 500) : testStart;
        } else {
          tests = asObject(
            await context.unity.request("tests.run", {
              mode: args.testMode,
              filter: args.testFilter,
              dryRun: true
            })
          );
        }
        steps.push({ name: args.runTests ? "tests_run" : "tests_run_dry_run", ok: tests.ok, data: tests });

        return successResponse(
          "repair_loop_run completed diagnostic pass.",
          {
            ok: true,
            objective: args.objective,
            mode: "diagnostic-pass",
            maxIterations: args.maxIterations,
            scriptPath: args.scriptPath ?? null,
            diagnosticSource: compileDiagnosticList.length > 0 ? "compilation-pipeline" : "console-log-buffer",
            steps,
            patchProposals,
            nextActions: [
              "If diagnostics are present, propose minimal ranged edits with patch_propose.",
              "Apply accepted edits through repair_apply_edits with dryRun=true first.",
              "Run tests with runTests=true only after diagnostics are clear or intentionally scoped."
            ]
          },
          startedAt
        );
      } catch (error) {
        return failureResponse("repair_loop_run failed", error, startedAt);
      }
    }
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
