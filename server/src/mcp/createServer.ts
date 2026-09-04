import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { access } from "node:fs/promises";
import { z } from "zod";
import type { UnityClient } from "../unity/UnityClient.js";
import { asObject, failureResponse, type GhostToolMeta, successResponse, type ToolDiagnostic } from "./toolResponse.js";

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
const ColliderTypeSchema = z.enum(["BoxCollider", "SphereCollider", "CapsuleCollider"]);
const CapsuleDirectionSchema = z.enum(["x", "y", "z"]);
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
    if (state.status !== "running" && state.status !== "waiting") {
      return last;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = asObject(await context.unity.request("operation.get", { operationId }));
  }

  return last;
}

async function waitForUnityCompile(
  context: ToolContext,
  requestedCompileGeneration: number,
  timeoutMs: number,
  intervalMs = 250
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let lastState: Record<string, unknown> | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastState = asObject(
        await context.unity.request("compile.status_get", {
          requestedCompileGeneration
        })
      );
    } catch {
      await new Promise((resolve) => setTimeout(resolve, Math.max(intervalMs, 1000)));
      continue;
    }

    if (lastState.status === "success" || lastState.status === "failed") {
      return {
        ...lastState,
        ok: lastState.status === "success" && lastState.ok !== false,
        elapsedMs: Date.now() - startedAt,
        requestedCompileGeneration
      };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    ok: false,
    status: "timeout",
    error: {
      code: "COMPILE_GENERATION_TIMEOUT",
      message: `Timed out waiting for compile generation ${requestedCompileGeneration}.`
    },
    elapsedMs: Date.now() - startedAt,
    requestedCompileGeneration,
    state: lastState
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

async function waitForFile(path: string, timeoutMs: number, intervalMs = 250): Promise<{ exists: boolean; elapsedMs: number }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await access(path);
      return {
        exists: true,
        elapsedMs: Date.now() - startedAt
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return {
    exists: false,
    elapsedMs: Date.now() - startedAt
  };
}

function chooseRepairLoopTestScope(
  semanticTestScope: Record<string, unknown> | null,
  fallbackMode: "editmode" | "playmode",
  fallbackFilter: string
): { mode: "editmode" | "playmode"; filter: string; source: string } {
  if (fallbackFilter) {
    return {
      mode: fallbackMode,
      filter: fallbackFilter,
      source: "caller"
    };
  }

  const validationPlan = arrayValue(semanticTestScope?.validationPlan);
  for (const step of validationPlan) {
    const record = asObject(step);
    if (record.tool !== "tests_run") {
      continue;
    }

    const args = asObject(record.arguments);
    const mode = stringValue(args.mode);
    const filter = stringValue(args.filter);
    if ((mode === "editmode" || mode === "playmode") && filter) {
      return {
        mode,
        filter,
        source: "semantic-test-scope"
      };
    }
  }

  return {
    mode: fallbackMode,
    filter: fallbackFilter,
    source: "caller-default"
  };
}

function firstScreenshotBaseline(baselineList: Record<string, unknown> | null): Record<string, unknown> | null {
  const baselines = arrayValue(baselineList?.baselines).map(asObject);
  return baselines.length > 0 ? baselines[0] : null;
}

function screenshotListEntries(list: Record<string, unknown> | null): Record<string, unknown>[] {
  return arrayValue(list?.baselines).map(asObject);
}

function screenshotPath(entry: Record<string, unknown> | null | undefined): string {
  return stringValue(entry?.path);
}

function screenshotLooksLikeBaseline(entry: Record<string, unknown>): boolean {
  const haystack = [entry.label, entry.fileName, entry.path, entry.scenePath, entry.cameraName]
    .map((value) => stringValue(value).toLowerCase())
    .join(" ");
  return haystack.includes("baseline");
}

function firstDistinctScreenshot(entries: Record<string, unknown>[], currentPath: string): Record<string, unknown> | null {
  return entries.find((entry) => screenshotPath(entry) && screenshotPath(entry) !== currentPath) ?? null;
}

function cleanupPlannedCount(cleanupPlan: Record<string, unknown> | null): number {
  const direct = cleanupPlan?.plannedCount;
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }

  const candidates = arrayValue(cleanupPlan?.candidates);
  if (candidates.length > 0) {
    return candidates.length;
  }

  const deletions = arrayValue(cleanupPlan?.deletions);
  return deletions.length;
}

function visualValidationRecommendations(report: {
  currentCapture: Record<string, unknown> | null;
  selectedBaseline: Record<string, unknown> | null;
  diff: Record<string, unknown> | null;
  cleanupPlan: Record<string, unknown> | null;
}): string[] {
  const recommendations: string[] = [];

  if (!report.currentCapture) {
    recommendations.push("Capture a repair-loop screenshot before running visual validation.");
  }

  if (!report.selectedBaseline) {
    recommendations.push("Create or label a baseline screenshot for the active scene before treating visual diffs as authoritative.");
  }

  if (report.diff) {
    if (report.diff.withinThreshold === true) {
      recommendations.push("Visual diff is within threshold; continue with semantic/test validation before committing gameplay changes.");
    } else if (report.diff.withinThreshold === false) {
      recommendations.push("Visual diff exceeded threshold; inspect the diff image before accepting the repair-loop result.");
    }
  } else if (report.currentCapture && report.selectedBaseline) {
    recommendations.push("Diff could not be produced from the selected screenshots; verify both PNG files still exist.");
  }

  if (report.cleanupPlan && cleanupPlannedCount(report.cleanupPlan) > 0) {
    recommendations.push("Run screenshot_baselines_cleanup with dryRun=false after reviewing the cleanup plan.");
  }

  return recommendations;
}

type VisualValidationReportOptions = {
  currentFilter: string;
  baselineFilter: string;
  threshold: number;
  maxSamples: number;
  cleanupFilter: string;
  cleanupKeepNewest: number;
  includeCleanup: boolean;
};

async function buildVisualValidationReport(context: ToolContext, options: VisualValidationReportOptions): Promise<Record<string, unknown>> {
  const currentList = asObject(
    await context.unity.request("screenshot.baselines_list", {
      filter: options.currentFilter,
      limit: 10,
      includeDimensions: true
    })
  );
  const currentEntries = screenshotListEntries(currentList);
  const currentCapture = currentEntries[0] ?? null;
  const currentPath = screenshotPath(currentCapture);

  let baselineList: Record<string, unknown> | null = null;
  let selectedBaseline: Record<string, unknown> | null = null;
  let baselineSource = "none";

  if (options.baselineFilter) {
    baselineList = asObject(
      await context.unity.request("screenshot.baselines_list", {
        filter: options.baselineFilter,
        limit: 10,
        includeDimensions: true
      })
    );
    selectedBaseline = firstDistinctScreenshot(screenshotListEntries(baselineList), currentPath);
    baselineSource = "baseline-filter";
  } else {
    baselineList = asObject(
      await context.unity.request("screenshot.baselines_list", {
        filter: "baseline",
        limit: 25,
        includeDimensions: true
      })
    );
    selectedBaseline = firstDistinctScreenshot(screenshotListEntries(baselineList).filter(screenshotLooksLikeBaseline), currentPath);
    baselineSource = "baseline-label";
  }

  if (!selectedBaseline && currentEntries.length > 1) {
    selectedBaseline = firstDistinctScreenshot(currentEntries, currentPath);
    baselineSource = "previous-current-capture";
  }

  const baselinePath = screenshotPath(selectedBaseline);
  let diff: Record<string, unknown> | null = null;
  if (currentPath && baselinePath) {
    diff = asObject(
      await context.unity.request("screenshot.diff", {
        baselinePath,
        currentPath,
        threshold: options.threshold,
        maxSamples: options.maxSamples
      })
    );
  }

  let cleanupPlan: Record<string, unknown> | null = null;
  if (options.includeCleanup) {
    cleanupPlan = asObject(
      await context.unity.request("screenshot.baselines_cleanup", {
        filter: options.cleanupFilter,
        keepNewest: options.cleanupKeepNewest,
        limit: 100,
        includeUnlabeled: true,
        allowDeleteBaselines: false,
        dryRun: true
      })
    );
  }

  const report = {
    ok: true,
    source: "visual_validation_report",
    currentFilter: options.currentFilter,
    baselineFilter: options.baselineFilter || null,
    baselineSource,
    threshold: options.threshold,
    currentList,
    baselineList,
    currentCapture,
    selectedBaseline,
    diff,
    cleanupPlan,
    recommendations: [] as string[]
  };
  report.recommendations = visualValidationRecommendations(report);

  return report;
}

type ComponentMutation = {
  propertyPath: string;
  value?: string | number | boolean;
  x?: number;
  y?: number;
  z?: number;
  label: string;
};

type ComponentSetupResult = {
  component: Record<string, unknown> | null;
  created: boolean;
  operations: Record<string, unknown>[];
};

function componentSummaries(payload: Record<string, unknown>): Record<string, unknown>[] {
  const component = asObject(payload.component);
  if (typeof component.componentInstanceId === "number") {
    return [component];
  }

  return arrayValue(payload.components).map(asObject);
}

function firstComponentOfType(payload: Record<string, unknown>, typeName: string): Record<string, unknown> | null {
  const lowered = typeName.toLowerCase();
  return (
    componentSummaries(payload).find((component) => {
      const name = stringValue(component.name).toLowerCase();
      const type = stringValue(component.type).toLowerCase();
      return name === lowered || type === lowered || type.endsWith(`.${lowered}`);
    }) ?? null
  );
}

function serializedPropertyPaths(payload: Record<string, unknown>): Set<string> {
  return new Set(arrayValue(payload.properties).map((property) => stringValue(asObject(property).path)).filter(Boolean));
}

async function ensureUnityComponent(
  context: ToolContext,
  instanceId: number,
  typeName: string,
  dryRun: boolean
): Promise<ComponentSetupResult> {
  const operations: Record<string, unknown>[] = [];
  const existing = asObject(
    await context.unity.request("component.get", {
      instanceId,
      type: typeName,
      maxProperties: 200
    })
  );
  let component = firstComponentOfType(existing, typeName);
  if (component) {
    operations.push({
      method: "component.get",
      ok: existing.ok,
      source: "existing-component",
      component
    });
    return {
      component,
      created: false,
      operations
    };
  }

  const addParams = {
    instanceId,
    type: typeName,
    dryRun
  };
  if (dryRun) {
    operations.push({
      method: "component.add",
      dryRun: true,
      params: addParams
    });
    return {
      component: null,
      created: true,
      operations
    };
  }

  const add = asObject(await context.unity.request("component.add", addParams));
  component = asObject(add.component);
  operations.push({
    method: "component.add",
    ok: add.ok,
    source: "created-component",
    component,
    undoGroupId: add.undoGroupId ?? null
  });
  return {
    component,
    created: true,
    operations
  };
}

async function applyUnityComponentMutations(
  context: ToolContext,
  component: Record<string, unknown>,
  mutations: ComponentMutation[],
  dryRun: boolean
): Promise<{ operations: Record<string, unknown>[]; skipped: ComponentMutation[]; diagnostics: ToolDiagnostic[] }> {
  const operations: Record<string, unknown>[] = [];
  const skipped: ComponentMutation[] = [];
  const diagnostics: ToolDiagnostic[] = [];
  const componentInstanceId = numberValue(component.componentInstanceId);

  if (dryRun) {
    return {
      operations: mutations.map((mutation) => ({
        method: "component.modify",
        dryRun: true,
        componentInstanceId: componentInstanceId || null,
        ...mutation
      })),
      skipped,
      diagnostics
    };
  }

  const details = asObject(
    await context.unity.request("component.get", {
      componentInstanceId,
      maxProperties: 200
    })
  );
  const availablePaths = serializedPropertyPaths(details);

  for (const mutation of mutations) {
    if (!availablePaths.has(mutation.propertyPath)) {
      skipped.push(mutation);
      diagnostics.push({
        severity: "warning",
        message: `Skipped ${mutation.propertyPath}; Unity did not expose it as a serialized property on this component.`,
        data: mutation
      });
      continue;
    }

    const result = asObject(
      await context.unity.request("component.modify", {
        componentInstanceId,
        propertyPath: mutation.propertyPath,
        ...(mutation.value !== undefined ? { value: mutation.value } : {}),
        ...(mutation.x !== undefined ? { x: mutation.x } : {}),
        ...(mutation.y !== undefined ? { y: mutation.y } : {}),
        ...(mutation.z !== undefined ? { z: mutation.z } : {}),
        dryRun: false
      })
    );
    operations.push({
      method: "component.modify",
      ok: result.ok,
      propertyPath: mutation.propertyPath,
      label: mutation.label,
      undoGroupId: result.undoGroupId ?? null
    });
  }

  return { operations, skipped, diagnostics };
}

function capsuleDirectionIndex(direction: "x" | "y" | "z"): number {
  return direction === "x" ? 0 : direction === "z" ? 2 : 1;
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
        "unity://tests/{mode}",
        "unity://semantic/index",
        "unity://screenshots/baselines",
        "unity://screenshots/baselines/{filter}",
        "unity://visual/validation/latest",
        "unity://visual/validation/{filter}"
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

  registerJsonResource(
    server,
    "Unity Semantic Project Index",
    "unity://semantic/index",
    "Read a project-wide semantic summary for game-development planning and refactor risk triage.",
    () => readUnityResource(context, "semantic.project_index_summary", { includeDiagnostics: true, limit: 200 })
  );

  registerJsonResource(
    server,
    "Unity Screenshot Baselines",
    "unity://screenshots/baselines",
    "List recent Ghost screenshot baselines for visual regression comparisons.",
    () => readUnityResource(context, "screenshot.baselines_list", { limit: 50, includeDimensions: true })
  );

  registerJsonResourceTemplate(
    server,
    "Unity Screenshot Baselines Filtered",
    "unity://screenshots/baselines/{filter}",
    "List Ghost screenshot baselines filtered by label, scene, camera, or filename.",
    (variables) =>
      readUnityResource(context, "screenshot.baselines_list", {
        filter: decodeURIComponent(firstVariable(variables.filter)),
        limit: 50,
        includeDimensions: true
      })
  );

  registerJsonResource(
    server,
    "Unity Visual Validation Latest",
    "unity://visual/validation/latest",
    "Summarize the latest repair-loop screenshot, selected baseline, diff status, and screenshot cleanup advice.",
    () =>
      buildVisualValidationReport(context, {
        currentFilter: "repair-loop",
        baselineFilter: "",
        threshold: 0.02,
        maxSamples: 20000,
        cleanupFilter: "repair-loop",
        cleanupKeepNewest: 20,
        includeCleanup: true
      })
  );

  registerJsonResourceTemplate(
    server,
    "Unity Visual Validation By Filter",
    "unity://visual/validation/{filter}",
    "Summarize visual validation state for a screenshot label, scene, camera, or filename filter.",
    (variables) => {
      const filter = decodeURIComponent(firstVariable(variables.filter));
      return buildVisualValidationReport(context, {
        currentFilter: filter || "repair-loop",
        baselineFilter: "",
        threshold: 0.02,
        maxSamples: 20000,
        cleanupFilter: filter || "repair-loop",
        cleanupKeepNewest: 20,
        includeCleanup: true
      });
    }
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
      generation: z.number().int().positive().optional(),
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
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 1, relatedResources: ["unity://screenshots/baselines"] },
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
      label: z.string().default("ghost"),
      mode: z.enum(["auto", "mainCamera", "game", "sceneView", "scene"]).default("auto"),
      width: z.number().int().positive().max(4096).default(1280),
      height: z.number().int().positive().max(4096).default(720),
      superSize: z.number().int().positive().max(8).default(1),
      dryRun: DryRunSchema
    },
    { risk: "safe-write", mutates: true, supportsDryRun: true, phase: 1 },
    "screenshot.capture"
  );

  registerUnityRequestTool(
    server,
    context,
    "screenshot_diff",
    "Compare two Unity PNG screenshots with a sampled pixel diff for visual regression checks.",
    {
      baselinePath: z.string().min(1),
      currentPath: z.string().min(1),
      threshold: z.number().nonnegative().max(1).default(0.02),
      maxSamples: z.number().int().positive().max(200000).default(20000)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3, relatedResources: ["unity://screenshots/baselines", "unity://screenshots/baselines/{filter}"] },
    "screenshot.diff"
  );

  registerUnityRequestTool(
    server,
    context,
    "screenshot_baselines_list",
    "List recent Ghost screenshot captures that can be used as visual baselines for repair_loop_run or screenshot_diff.",
    {
      filter: z.string().default(""),
      limit: z.number().int().positive().max(500).default(50),
      includeDimensions: z.boolean().default(true)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3, relatedResources: ["unity://screenshots/baselines", "unity://screenshots/baselines/{filter}"] },
    "screenshot.baselines_list"
  );

  registerUnityRequestTool(
    server,
    context,
    "screenshot_baselines_cleanup",
    "Dry-run or prune stale, empty, or excess Ghost screenshot captures while protecting named baselines by default.",
    {
      filter: z.string().default(""),
      olderThanDays: z.number().int().nonnegative().max(3650).default(0),
      minBytes: z.number().int().nonnegative().max(10_000_000).default(1),
      keepNewest: z.number().int().nonnegative().max(1000).default(20),
      limit: z.number().int().positive().max(1000).default(100),
      includeUnlabeled: z.boolean().default(true),
      allowDeleteBaselines: z.boolean().default(false),
      protectedLabels: z.string().default(""),
      dryRun: z.boolean().default(true)
    },
    { risk: "destructive", mutates: true, supportsDryRun: true, phase: 3, relatedResources: ["unity://screenshots/baselines", "unity://screenshots/baselines/{filter}"] },
    "screenshot.baselines_cleanup"
  );

  registerTool(
    server,
    "visual_validation_report",
    "Summarize the latest Unity screenshot capture, selected visual baseline, sampled diff result, and dry-run screenshot cleanup recommendations.",
    {
      currentFilter: z.string().default("repair-loop"),
      baselineFilter: z.string().default(""),
      threshold: z.number().nonnegative().max(1).default(0.02),
      maxSamples: z.number().int().positive().max(200000).default(20000),
      cleanupFilter: z.string().default("repair-loop"),
      cleanupKeepNewest: z.number().int().nonnegative().max(1000).default(20),
      includeCleanup: z.boolean().default(true)
    },
    {
      risk: "read",
      mutates: false,
      supportsDryRun: false,
      phase: 3,
      relatedResources: [
        "unity://screenshots/baselines",
        "unity://screenshots/baselines/{filter}",
        "unity://visual/validation/latest",
        "unity://visual/validation/{filter}"
      ],
      examples: [
        {
          currentFilter: "repair-loop",
          baselineFilter: "kotor-main-menu-baseline",
          cleanupKeepNewest: 3
        }
      ]
    },
    async (args) => {
      const startedAt = Date.now();
      try {
        const data = await buildVisualValidationReport(context, args);
        return successResponse("visual_validation_report completed.", data, startedAt);
      } catch (error) {
        return failureResponse("visual_validation_report failed", error, startedAt);
      }
    }
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

  registerTool(
    server,
    "collider_setup",
    "Phase 4 physics tool: add or configure a Collider for walkable surfaces, blockers, triggers, doors, and imported level geometry.",
    {
      instanceId: z.number().int(),
      colliderType: ColliderTypeSchema.default("BoxCollider"),
      isTrigger: z.boolean().default(false),
      centerX: z.number().default(0),
      centerY: z.number().default(0),
      centerZ: z.number().default(0),
      sizeX: z.number().positive().default(1),
      sizeY: z.number().positive().default(1),
      sizeZ: z.number().positive().default(1),
      radius: z.number().positive().default(0.5),
      height: z.number().positive().default(2),
      direction: CapsuleDirectionSchema.default("y"),
      dryRun: DryRunSchema
    },
    {
      risk: "safe-write",
      mutates: true,
      supportsDryRun: true,
      phase: 4,
      relatedResources: ["unity://gameobject/{instanceId}", "unity://component/{instanceId}/{type}"],
      examples: [
        {
          instanceId: 12345,
          colliderType: "BoxCollider",
          sizeX: 2,
          sizeY: 0.25,
          sizeZ: 2,
          isTrigger: false,
          dryRun: true
        }
      ]
    },
    async (args) => {
      const startedAt = Date.now();
      try {
        const setup = await ensureUnityComponent(context, args.instanceId, args.colliderType, args.dryRun);
        const mutations: ComponentMutation[] = [
          { propertyPath: "m_IsTrigger", value: args.isTrigger, label: "trigger mode" },
          { propertyPath: "m_Center", x: args.centerX, y: args.centerY, z: args.centerZ, label: "collider center" }
        ];

        if (args.colliderType === "BoxCollider") {
          mutations.push({ propertyPath: "m_Size", x: args.sizeX, y: args.sizeY, z: args.sizeZ, label: "box size" });
        } else if (args.colliderType === "SphereCollider") {
          mutations.push({ propertyPath: "m_Radius", value: args.radius, label: "sphere radius" });
        } else if (args.colliderType === "CapsuleCollider") {
          mutations.push({ propertyPath: "m_Radius", value: args.radius, label: "capsule radius" });
          mutations.push({ propertyPath: "m_Height", value: args.height, label: "capsule height" });
          mutations.push({ propertyPath: "m_Direction", value: capsuleDirectionIndex(args.direction), label: "capsule direction" });
        }

        const mutationResult = setup.component
          ? await applyUnityComponentMutations(context, setup.component, mutations, args.dryRun)
          : { operations: mutations.map((mutation) => ({ method: "component.modify", dryRun: true, ...mutation })), skipped: [], diagnostics: [] };

        return successResponse(
          "collider_setup completed.",
          {
            ok: true,
            domain: "physics",
            tool: "collider_setup",
            dryRun: args.dryRun,
            instanceId: args.instanceId,
            colliderType: args.colliderType,
            component: setup.component,
            createdComponent: setup.created,
            operations: [...setup.operations, ...mutationResult.operations],
            skippedProperties: mutationResult.skipped,
            recommendedNextTools: ["rigidbody_setup", "visual_validation_report", "tests_run"]
          },
          startedAt,
          { diagnostics: mutationResult.diagnostics }
        );
      } catch (error) {
        return failureResponse("collider_setup failed", error, startedAt);
      }
    }
  );

  registerTool(
    server,
    "rigidbody_setup",
    "Phase 4 physics tool: add or configure a Rigidbody for movable props, physics-driven actors, and collision validation.",
    {
      instanceId: z.number().int(),
      mass: z.number().positive().default(1),
      drag: z.number().nonnegative().default(0),
      angularDrag: z.number().nonnegative().default(0.05),
      useGravity: z.boolean().default(true),
      isKinematic: z.boolean().default(false),
      dryRun: DryRunSchema
    },
    {
      risk: "safe-write",
      mutates: true,
      supportsDryRun: true,
      phase: 4,
      relatedResources: ["unity://gameobject/{instanceId}", "unity://component/{instanceId}/{type}"],
      examples: [
        {
          instanceId: 12345,
          mass: 10,
          useGravity: false,
          isKinematic: true,
          dryRun: true
        }
      ]
    },
    async (args) => {
      const startedAt = Date.now();
      try {
        const setup = await ensureUnityComponent(context, args.instanceId, "Rigidbody", args.dryRun);
        const mutations: ComponentMutation[] = [
          { propertyPath: "m_Mass", value: args.mass, label: "mass" },
          { propertyPath: "m_Drag", value: args.drag, label: "linear drag" },
          { propertyPath: "m_AngularDrag", value: args.angularDrag, label: "angular drag" },
          { propertyPath: "m_UseGravity", value: args.useGravity, label: "gravity" },
          { propertyPath: "m_IsKinematic", value: args.isKinematic, label: "kinematic mode" }
        ];
        const mutationResult = setup.component
          ? await applyUnityComponentMutations(context, setup.component, mutations, args.dryRun)
          : { operations: mutations.map((mutation) => ({ method: "component.modify", dryRun: true, ...mutation })), skipped: [], diagnostics: [] };

        return successResponse(
          "rigidbody_setup completed.",
          {
            ok: true,
            domain: "physics",
            tool: "rigidbody_setup",
            dryRun: args.dryRun,
            instanceId: args.instanceId,
            component: setup.component,
            createdComponent: setup.created,
            operations: [...setup.operations, ...mutationResult.operations],
            skippedProperties: mutationResult.skipped,
            recommendedNextTools: ["collider_setup", "visual_validation_report", "tests_run"]
          },
          startedAt,
          { diagnostics: mutationResult.diagnostics }
        );
      } catch (error) {
        return failureResponse("rigidbody_setup failed", error, startedAt);
      }
    }
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
      extensions: z.string().default(".prefab,.unity,.asset,.controller,.overrideController,.mat,.anim,.playable,.renderTexture,.lighting,.shadergraph,.asmdef,.uxml,.uss"),
      candidateExtensions: z.string().default(".prefab,.mat,.asset,.controller,.overrideController,.anim,.png,.jpg,.jpeg,.tga,.psd,.fbx,.obj,.wav,.mp3,.ogg,.shadergraph,.renderTexture,.uxml,.uss"),
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
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
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
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
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
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
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
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      dryRun: DryRunSchema
    },
    { risk: "asset-write", mutates: true, supportsDryRun: true, phase: 2 },
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
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional()
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

  registerTool(
    server,
    "script_validate",
    "Compile and validate a Unity C# script against an exact import generation.",
    {
      path: z.string().min(1),
      requestedCompileGeneration: z.number().int().positive().optional(),
      timeoutMs: z.number().int().positive().max(300000).default(30000),
      limit: z.number().int().positive().max(500).default(100),
      dryRun: DryRunSchema
    },
    { risk: "read", mutates: false, supportsDryRun: true, phase: 3, relatedResources: ["unity://console/errors"] },
    async (args) => {
      const startedAt = Date.now();
      try {
        const validationStart = asObject(
          await context.unity.request("script.validate", {
            path: args.path,
            requestedCompileGeneration: args.requestedCompileGeneration,
            limit: args.limit,
            dryRun: args.dryRun
          })
        );
        if (args.dryRun) {
          return successResponse("script_validate dry run completed.", validationStart, startedAt);
        }

        const generation = numberValue(validationStart.requestedCompileGeneration);
        if (generation <= 0) {
          return failureResponse("script_validate failed", new Error("Unity did not return a compile generation."), startedAt, [], {
            code: "MISSING_COMPILE_GENERATION",
            data: validationStart
          });
        }

        const compile = await waitForUnityCompile(context, generation, args.timeoutMs);
        const diagnosticResult = asObject(
          await context.unity.request("compile.diagnostics_get", {
            severity: "error",
            pathFilter: args.path,
            generation,
            limit: args.limit
          })
        );
        const diagnostics = diagnosticsFromPayload(diagnosticResult);
        const validationOk = compile.ok === true && diagnostics.length === 0;
        return successResponse(
          "script_validate completed.",
          {
            ok: validationOk,
            error: validationOk
              ? null
              : {
                  code: compile.status === "timeout" ? "COMPILE_GENERATION_TIMEOUT" : "SCRIPT_COMPILER_ERRORS",
                  message:
                    compile.status === "timeout"
                      ? `Timed out waiting for compile generation ${generation}.`
                      : `Compile generation ${generation} produced ${diagnostics.length} scoped error${diagnostics.length === 1 ? "" : "s"}.`
                },
            path: args.path,
            requestedCompileGeneration: generation,
            compile,
            diagnostics
          },
          startedAt,
          { confidence: validationOk ? 1 : 0 }
        );
      } catch (error) {
        return failureResponse("script_validate failed", error, startedAt);
      }
    }
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
    "Wait for one exact Unity compile/import generation to be observed and completed.",
    {
      requestedCompileGeneration: z.number().int().positive(),
      timeoutMs: z.number().int().positive().max(300000).default(30000)
    },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 3 },
    async (args) => {
      const startedAt = Date.now();
      try {
        const data = await waitForUnityCompile(context, args.requestedCompileGeneration, args.timeoutMs);
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
            expectedSha256: stringValue(script.sha256),
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
            expectedSha256: stringValue(script.sha256),
            dryRun: false
          })
        );
        steps.push({ name: "script_apply_edits", ok: applyResult.ok, data: applyResult });

        const requestedCompileGeneration = numberValue(applyResult.requestedCompileGeneration);
        if (requestedCompileGeneration <= 0) {
          throw new Error("script.apply_edits did not return requestedCompileGeneration.");
        }
        const compileStatus = await waitForUnityCompile(context, requestedCompileGeneration, args.compileTimeoutMs);
        steps.push({ name: "compile_wait", ok: compileStatus.ok, data: compileStatus });

        const validation = asObject(
          await context.unity.request("script.validate", {
            path: args.scriptPath,
            requestedCompileGeneration,
            limit: 100
          })
        );
        steps.push({ name: "script_validate", ok: validation.ok, data: validation });

        const compileDiagnostics = asObject(
          await context.unity.request("compile.diagnostics_get", {
            severity: "error",
            pathFilter: args.scriptPath,
            generation: requestedCompileGeneration,
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
        const testsFailed = tests ? testState.status !== "success" || numberValue(testState.failed) > 0 || tests.status === "failed" : false;
        const shouldRollback = args.rollbackOnFailure && (compileStatus.ok === false || effectiveErrorCount > 0 || testsFailed);
        let rollback: Record<string, unknown> | null = null;

        if (shouldRollback) {
          const backupPath = stringValue(applyResult.backupPath);
          const writeBack = backupPath
            ? asObject(
                await context.unity.request("script.restore", {
                  path: args.scriptPath,
                  backupPath,
                  backupMetaPath: stringValue(applyResult.backupMetaPath),
                  expectedSha256: stringValue(applyResult.afterSha256)
                })
              )
            : asObject(
                await context.unity.request("script.write", {
                  path: args.scriptPath,
                  content: originalContent,
                  overwrite: true,
                  expectedSha256: stringValue(applyResult.afterSha256),
                  dryRun: false
                })
              );
          const rollbackGeneration = numberValue(writeBack.requestedCompileGeneration);
          if (rollbackGeneration <= 0) {
            throw new Error("rollback script.write did not return requestedCompileGeneration.");
          }
          const rollbackCompile = await waitForUnityCompile(context, rollbackGeneration, args.compileTimeoutMs);
          const rollbackValidation = asObject(
            await context.unity.request("script.validate", {
              path: args.scriptPath,
              requestedCompileGeneration: rollbackGeneration,
              limit: 100
            })
          );
          const rollbackRead = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
          const byteIdentical = stringValue(rollbackRead.sha256) === stringValue(script.sha256);
          const cleanup = asObject(
            await context.unity.request("script.transaction_complete", {
              backupPath,
              backupMetaPath: stringValue(applyResult.backupMetaPath)
            })
          );
          const restoreCleanup = asObject(
            await context.unity.request("script.transaction_complete", {
              backupPath: stringValue(writeBack.backupPath),
              backupMetaPath: stringValue(writeBack.backupMetaPath)
            })
          );
          rollback = {
            writeBack,
            compile: rollbackCompile,
            validation: rollbackValidation,
            readBack: rollbackRead,
            expectedSha256: stringValue(script.sha256),
            restoredSha256: stringValue(rollbackRead.sha256),
            byteIdentical,
            cleanup,
            restoreCleanup
          };
          steps.push({ name: "rollback_script_write", ok: writeBack.ok, data: writeBack });
          steps.push({ name: "rollback_compile_wait", ok: rollbackCompile.ok, data: rollbackCompile });
          steps.push({ name: "rollback_script_validate", ok: rollbackValidation.ok, data: rollbackValidation });
          steps.push({ name: "rollback_hash_verify", ok: byteIdentical, data: rollback });
        } else if (effectiveErrorCount === 0 && compileStatus.ok !== false && !testsFailed) {
          const cleanup = asObject(
            await context.unity.request("script.transaction_complete", {
              backupPath: stringValue(applyResult.backupPath),
              backupMetaPath: stringValue(applyResult.backupMetaPath)
            })
          );
          steps.push({ name: "script_transaction_complete", ok: cleanup.ok, data: cleanup });
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
    "repair_inspect",
    "Inspect one script/compiler/test/visual state and propose repairs without applying them.",
    {
      objective: z.string().min(1),
      scriptPath: z.string().optional(),
      maxIterations: z.number().int().positive().max(5).default(1),
      compileTimeoutMs: z.number().int().positive().max(300000).default(30000),
      useSemanticTestScope: z.boolean().default(true),
      runTests: z.boolean().default(false),
      testMode: z.enum(["editmode", "playmode"]).default("editmode"),
      testFilter: z.string().default(""),
      captureScreenshot: z.boolean().default(false),
      screenshotBaselinePath: z.string().default(""),
      screenshotBaselineFilter: z.string().default(""),
      screenshotMode: z.enum(["auto", "mainCamera", "game", "sceneView", "scene"]).default("auto"),
      screenshotWidth: z.number().int().positive().max(4096).default(1280),
      screenshotHeight: z.number().int().positive().max(4096).default(720),
      screenshotThreshold: z.number().nonnegative().max(1).default(0.02),
      screenshotWaitMs: z.number().int().positive().max(30000).default(5000)
    },
    { risk: "test-execution", mutates: false, supportsDryRun: false, phase: 3, relatedResources: ["unity://console/errors", "unity://tests/{mode}", "unity://semantic/index", "unity://screenshots/baselines"] },
    async (args) => {
      const startedAt = Date.now();
      try {
        const steps: unknown[] = [];
        const editorState = asObject(await context.unity.request("editor.get_state"));
        steps.push({ name: "editor_state", ok: editorState.ok, data: editorState });

        let validation: Record<string, unknown> | undefined;
        let requestedCompileGeneration = 0;
        if (args.scriptPath) {
          validation = asObject(await context.unity.request("script.validate", { path: args.scriptPath, limit: 100 }));
          requestedCompileGeneration = numberValue(validation.requestedCompileGeneration);
          if (requestedCompileGeneration <= 0) {
            throw new Error("script.validate did not return requestedCompileGeneration.");
          }
          steps.push({ name: "script_validate", ok: validation.ok, data: validation });
        }

        const compileStatus =
          requestedCompileGeneration > 0
            ? await waitForUnityCompile(context, requestedCompileGeneration, args.compileTimeoutMs)
            : { ok: true, status: "not-requested", requestedCompileGeneration: null };
        steps.push({ name: "compile_wait", ok: compileStatus.ok, data: compileStatus });

        let semanticTestScope: Record<string, unknown> | null = null;
        if (args.scriptPath && args.useSemanticTestScope) {
          semanticTestScope = asObject(
            await context.unity.request("semantic.test_scope_suggest", {
              path: args.scriptPath,
              includePlayMode: true,
              limit: 10
            })
          );
          steps.push({ name: "test_scope_suggest", ok: semanticTestScope.ok, data: semanticTestScope });
        }

        const compileDiagnostics = asObject(
          await context.unity.request("compile.diagnostics_get", {
            severity: "error",
            pathFilter: args.scriptPath ?? "",
            ...(requestedCompileGeneration > 0 ? { generation: requestedCompileGeneration } : {}),
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

        const plannedTestScope = chooseRepairLoopTestScope(semanticTestScope, args.testMode, args.testFilter);
        let tests: Record<string, unknown>;
        if (args.runTests) {
          const testStart = asObject(
            await context.unity.request("tests.run", {
              mode: plannedTestScope.mode,
              filter: plannedTestScope.filter
            })
          );
          tests = typeof testStart.operationId === "string" ? await pollOperation(context, testStart.operationId, 120000, 500) : testStart;
        } else {
          tests = asObject(
            await context.unity.request("tests.run", {
              mode: plannedTestScope.mode,
              filter: plannedTestScope.filter,
              dryRun: true
            })
          );
        }
        steps.push({ name: args.runTests ? "tests_run" : "tests_run_dry_run", ok: tests.ok, data: tests });

        let screenshotValidation: Record<string, unknown> | null = null;
        if (args.captureScreenshot || args.screenshotBaselinePath || args.screenshotBaselineFilter) {
          let selectedBaseline: Record<string, unknown> | null = null;
          let baselineList: Record<string, unknown> | null = null;
          if (args.screenshotBaselinePath) {
            selectedBaseline = {
              path: args.screenshotBaselinePath,
              source: "caller-path"
            };
          } else if (args.screenshotBaselineFilter) {
            baselineList = asObject(
              await context.unity.request("screenshot.baselines_list", {
                filter: args.screenshotBaselineFilter,
                limit: 1,
                includeDimensions: true
              })
            );
            selectedBaseline = firstScreenshotBaseline(baselineList);
            steps.push({ name: "screenshot_baselines_list", ok: baselineList.ok, data: baselineList });
          }

          const capture = asObject(
            await context.unity.request("screenshot.capture", {
              label: "repair-loop",
              mode: args.screenshotMode,
              width: args.screenshotWidth,
              height: args.screenshotHeight,
              superSize: 1,
              dryRun: false
            })
          );
          const screenshotPath = stringValue(capture.path);
          const wait = screenshotPath ? await waitForFile(screenshotPath, args.screenshotWaitMs) : { exists: false, elapsedMs: 0 };
          screenshotValidation = {
            baselineFilter: args.screenshotBaselineFilter || null,
            selectedBaseline,
            baselineList,
            capture,
            wait,
            diff: null
          };
          steps.push({ name: "screenshot_capture", ok: capture.ok, data: screenshotValidation });

          const baselinePath = stringValue(selectedBaseline?.path);
          if (baselinePath && screenshotPath && wait.exists) {
            const diff = asObject(
              await context.unity.request("screenshot.diff", {
                baselinePath,
                currentPath: screenshotPath,
                threshold: args.screenshotThreshold
              })
            );
            screenshotValidation.diff = diff;
            steps.push({ name: "screenshot_diff", ok: diff.ok, data: diff });
          }
        }

        return successResponse(
          "repair_inspect completed diagnostic pass.",
          {
            ok: true,
            objective: args.objective,
            mode: "diagnostic-pass",
            maxIterations: args.maxIterations,
            scriptPath: args.scriptPath ?? null,
            diagnosticSource: compileDiagnosticList.length > 0 ? "compilation-pipeline" : "console-log-buffer",
            semanticTestScope,
            plannedTestScope,
            screenshotValidation,
            steps,
            patchProposals,
            nextActions: [
              "If diagnostics are present, propose minimal ranged edits with patch_propose.",
              "Apply accepted edits through repair_apply_edits with dryRun=true first.",
              "Use plannedTestScope for the smallest useful tests_run pass once diagnostics are clear."
            ]
          },
          startedAt
        );
      } catch (error) {
        return failureResponse("repair_loop_run failed", error, startedAt);
      }
    }
  );

  registerTool(
    server,
    "repair_loop_run",
    "Run a bounded deterministic repair loop and restore the original script if no iteration passes.",
    {
      objective: z.string().min(1),
      scriptPath: z.string().min(1),
      maxIterations: z.number().int().positive().max(5).default(3),
      minimumConfidence: z.number().min(0).max(1).default(0.6),
      compileTimeoutMs: z.number().int().positive().max(300000).default(30000),
      runTests: z.boolean().default(false),
      testMode: z.enum(["editmode", "playmode"]).default("editmode"),
      testFilter: z.string().default("")
    },
    { risk: "code-write", mutates: true, supportsDryRun: false, phase: 3, relatedResources: ["unity://console/errors", "unity://tests/{mode}"] },
    async (args) => {
      const startedAt = Date.now();
      const iterations: Record<string, unknown>[] = [];
      let originalContent = "";
      let originalSha256 = "";
      let sourceChanged = false;
      let restored: Record<string, unknown> | null = null;
      const transactionBackups: Array<{ backupPath: string; backupMetaPath: string }> = [];

      const compileAndDiagnose = async (requestedCompileGeneration?: number): Promise<Record<string, unknown>> => {
        const validationStart = asObject(
          await context.unity.request("script.validate", {
            path: args.scriptPath,
            ...(requestedCompileGeneration ? { requestedCompileGeneration } : {}),
            limit: 100
          })
        );
        const generation = numberValue(validationStart.requestedCompileGeneration);
        if (generation <= 0) {
          throw new Error("Unity did not return requestedCompileGeneration during repair validation.");
        }
        const compile = await waitForUnityCompile(context, generation, args.compileTimeoutMs);
        const diagnosticResult = asObject(
          await context.unity.request("compile.diagnostics_get", {
            severity: "error",
            pathFilter: args.scriptPath,
            generation,
            limit: 100
          })
        );
        return {
          ok: compile.ok === true && diagnosticsFromPayload(diagnosticResult).length === 0,
          generation,
          compile,
          diagnostics: diagnosticsFromPayload(diagnosticResult)
        };
      };

      const runRequiredTests = async (): Promise<Record<string, unknown> | null> => {
        if (!args.runTests) {
          return null;
        }
        const started = asObject(
          await context.unity.request("tests.run", {
            mode: args.testMode,
            filter: args.testFilter
          })
        );
        return typeof started.operationId === "string" ? pollOperation(context, started.operationId, 120000, 500) : started;
      };

      const restoreOriginal = async (): Promise<Record<string, unknown>> => {
        const current = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
        const originalBackup = transactionBackups[0];
        const write = originalBackup?.backupPath
          ? asObject(
              await context.unity.request("script.restore", {
                path: args.scriptPath,
                backupPath: originalBackup.backupPath,
                backupMetaPath: originalBackup.backupMetaPath,
                expectedSha256: stringValue(current.sha256)
              })
            )
          : asObject(
              await context.unity.request("script.write", {
                path: args.scriptPath,
                content: originalContent,
                overwrite: true,
                expectedSha256: stringValue(current.sha256),
                dryRun: false
              })
            );
        const generation = numberValue(write.requestedCompileGeneration);
        if (generation <= 0) {
          return { ok: false, error: { code: "ROLLBACK_GENERATION_MISSING", message: "Rollback write returned no compile generation." }, write };
        }
        const compile = await waitForUnityCompile(context, generation, args.compileTimeoutMs);
        const readBack = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
        const restoredHash = stringValue(readBack.sha256);
        if (stringValue(write.backupPath)) {
          transactionBackups.push({
            backupPath: stringValue(write.backupPath),
            backupMetaPath: stringValue(write.backupMetaPath)
          });
        }
        return {
          ok: compile.ok === true && restoredHash === originalSha256,
          write,
          compile,
          expectedSha256: originalSha256,
          restoredSha256: restoredHash
        };
      };

      const completeTransactions = async (): Promise<Record<string, unknown>[]> => {
        const completed: Record<string, unknown>[] = [];
        for (const backup of transactionBackups) {
          completed.push(
            asObject(
              await context.unity.request("script.transaction_complete", {
                backupPath: backup.backupPath,
                backupMetaPath: backup.backupMetaPath
              })
            )
          );
        }
        return completed;
      };

      try {
        const original = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
        originalContent = stringValue(original.content);
        originalSha256 = stringValue(original.sha256);

        let current = await compileAndDiagnose();
        for (let iteration = 1; iteration <= args.maxIterations; iteration += 1) {
          const currentDiagnostics = arrayValue(current.diagnostics).map(asObject);
          const iterationReceipt: Record<string, unknown> = {
            iteration,
            before: current
          };

          if (current.ok === true) {
            const tests = await runRequiredTests();
            const testState = asObject(tests?.state);
            const testsOk = tests === null || (tests.ok !== false && testState.status === "success" && numberValue(testState.failed) === 0);
            iterationReceipt.tests = tests;
            iterationReceipt.ok = testsOk;
            iterations.push(iterationReceipt);
            if (testsOk) {
              const transactionCleanup = await completeTransactions();
              return successResponse(
                "repair_loop_run completed with a verified green result.",
                {
                  ok: true,
                  objective: args.objective,
                  scriptPath: args.scriptPath,
                  iterations,
                  iterationCount: iterations.length,
                  originalSha256,
                  finalSha256: stringValue(asObject(await context.unity.request("script.read", { path: args.scriptPath })).sha256),
                  restored: null,
                  transactionCleanup
                },
                startedAt
              );
            }

            iterationReceipt.terminalReason = "required-tests-failed";
            break;
          }

          const currentScript = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
          const proposals = buildPatchProposals(currentDiagnostics, args.scriptPath, stringValue(currentScript.content));
          const candidate = proposals
            .filter((proposal) => arrayValue(proposal.edits).length > 0 && numberValue(proposal.confidence) >= args.minimumConfidence)
            .sort((left, right) => numberValue(right.confidence) - numberValue(left.confidence))[0];
          iterationReceipt.proposals = proposals;

          if (!candidate) {
            iterationReceipt.ok = false;
            iterationReceipt.terminalReason = "no-safe-proposal";
            iterations.push(iterationReceipt);
            break;
          }

          const edits = arrayValue(candidate.edits);
          const preview = asObject(
            await context.unity.request("script.apply_edits", {
              path: args.scriptPath,
              edits,
              expectedSha256: stringValue(currentScript.sha256),
              dryRun: true
            })
          );
          iterationReceipt.selectedProposal = candidate;
          iterationReceipt.preview = preview;
          if (preview.ok === false) {
            iterationReceipt.ok = false;
            iterationReceipt.terminalReason = "dry-run-failed";
            iterations.push(iterationReceipt);
            break;
          }

          const applied = asObject(
            await context.unity.request("script.apply_edits", {
              path: args.scriptPath,
              edits,
              expectedSha256: stringValue(currentScript.sha256),
              dryRun: false
            })
          );
          sourceChanged = true;
          if (stringValue(applied.backupPath)) {
            transactionBackups.push({
              backupPath: stringValue(applied.backupPath),
              backupMetaPath: stringValue(applied.backupMetaPath)
            });
          }
          const appliedGeneration = numberValue(applied.requestedCompileGeneration);
          current = await compileAndDiagnose(appliedGeneration);
          const tests = current.ok === true ? await runRequiredTests() : null;
          const testState = asObject(tests?.state);
          const testsOk = tests === null || (tests.ok !== false && testState.status === "success" && numberValue(testState.failed) === 0);
          const iterationOk = current.ok === true && testsOk;
          iterationReceipt.applied = applied;
          iterationReceipt.after = current;
          iterationReceipt.tests = tests;
          iterationReceipt.ok = iterationOk;
          iterations.push(iterationReceipt);

          if (iterationOk) {
            const finalRead = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
            const transactionCleanup = await completeTransactions();
            return successResponse(
              "repair_loop_run applied and verified a repair.",
              {
                ok: true,
                objective: args.objective,
                scriptPath: args.scriptPath,
                iterations,
                iterationCount: iterations.length,
                originalSha256,
                finalSha256: stringValue(finalRead.sha256),
                restored: null,
                transactionCleanup
              },
              startedAt
            );
          }
        }

        if (sourceChanged) {
          restored = await restoreOriginal();
        }
        const transactionCleanup = await completeTransactions();
        return successResponse(
          "repair_loop_run exhausted without a green result.",
          {
            ok: false,
            error: {
              code: restored && restored.ok === false ? "REPAIR_ROLLBACK_FAILED" : "REPAIR_EXHAUSTED",
              message: restored && restored.ok === false ? "Repair failed and original-source restoration was incomplete." : "No repair iteration passed all required checks."
            },
            objective: args.objective,
            scriptPath: args.scriptPath,
            iterations,
            iterationCount: iterations.length,
            originalSha256,
            restored,
            transactionCleanup
          },
          startedAt,
          { confidence: 0 }
        );
      } catch (error) {
        if (sourceChanged && originalContent) {
          try {
            restored = await restoreOriginal();
          } catch (rollbackError) {
            restored = { ok: false, error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) };
          }
        }
        let transactionCleanup: Record<string, unknown>[] = [];
        if (!sourceChanged || restored?.ok === true) {
          try {
            transactionCleanup = await completeTransactions();
          } catch {
            // Preserve backups when cleanup fails so a caller can still recover manually.
          }
        }
        return failureResponse("repair_loop_run failed", error, startedAt, [], {
          code: restored && restored.ok === false ? "REPAIR_ROLLBACK_FAILED" : "REPAIR_LOOP_FAILED",
          data: { objective: args.objective, scriptPath: args.scriptPath, iterations, originalSha256, restored, transactionCleanup }
        });
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
