import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { z } from "zod";
import { ScenarioJobManager, type ScenarioMatrixDefinition } from "../scenario/ScenarioJobManager.js";
import { UnityCommandError, UnityRequestTimeoutError, type UnityClient, type UnityRequestOptions } from "../unity/UnityClient.js";
import { PackageVersion } from "../version.js";
import { listOperationCatalog, operationEnabled, recordOperation, searchOperationCatalog, type OperationProfile, type ToolSchema } from "./operationCatalog.js";
import { asObject, failureResponse, GhostToolResponseSchema, type GhostToolMeta, successResponse, type ToolDiagnostic } from "./toolResponse.js";
import { registerAuthoringTools } from "./registerAuthoringTools.js";
import { registerCodeTools } from "./registerCodeTools.js";

export interface ToolContext {
  unity: UnityClient;
  projectPath?: string;
  projectId?: string;
  editorInstanceId?: string;
  toolProfiles?: OperationProfile[];
  /** Process-scoped orchestration state shared by stateless HTTP request servers. */
  scenarios?: ScenarioJobManager;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolHandler<TArgs> = (args: TArgs, extra: ToolExtra) => Promise<CallToolResult>;

const EmptySchema = {};
export const ParamsSchema = z.record(z.string(), z.unknown()).default({});
export const DryRunSchema = z.boolean().default(false);
const MutationRequestSchema = {
  requestId: z.string().min(1).max(128).optional(),
  idempotencyKey: z.string().min(1).max(128).optional()
};

export const TransformSchema = {
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

export const ComponentValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const ColliderTypeSchema = z.enum(["BoxCollider", "SphereCollider", "CapsuleCollider"]);
const CapsuleDirectionSchema = z.enum(["x", "y", "z"]);
export const ScriptEditSchema = z.object({
  startLine: z.number().int().nonnegative(),
  startColumn: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  endColumn: z.number().int().nonnegative(),
  text: z.string()
});
const DiagnosticInputSchema = z.object({}).passthrough();
const ConsoleFilterSchema = {
  boundary: z.string().min(1).optional(),
  generation: z.number().int().positive().optional(),
  severity: z.enum(["log", "warning", "error", "all"]).default("all"),
  exact: z.string().optional(),
  contains: z.string().optional(),
  regex: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  count: z.number().int().nonnegative().optional(),
  minimumCount: z.number().int().nonnegative().default(1),
  maximumCount: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(1000).default(200),
  failOnUnexpectedErrors: z.boolean().default(true)
};
const ScenarioSourceMutationSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(1024 * 1024),
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/i)
});
const ScenarioInputSchema = z.object({
  backend: z.enum(["auto", "unity-input-system", "project-test-driver"]).default("auto"),
  device: z.enum(["keyboard", "pointer"]),
  action: z.enum(["tap", "press", "release", "click"]),
  key: z.string().min(1).optional(),
  button: z.enum(["left"]).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  timeoutMs: z.number().int().positive().max(30000).optional()
});
const ScenarioConsoleAssertionSchema = z.object({
  boundary: z.string().min(1).optional(),
  generation: z.number().int().positive().optional(),
  severity: z.enum(["log", "warning", "error", "all"]).optional(),
  exact: z.string().optional(),
  contains: z.string().optional(),
  regex: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  count: z.number().int().nonnegative().optional(),
  minimumCount: z.number().int().nonnegative().optional(),
  maximumCount: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  failOnUnexpectedErrors: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(300000).optional()
});
const ScenarioObjectAssertionSchema = z.object({
  hierarchyPath: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  exists: z.boolean().optional(),
  activeSelf: z.boolean().optional(),
  component: z.string().min(1).optional(),
  propertyPath: z.string().min(1).optional(),
  equals: z.unknown().optional(),
  contains: z.string().optional()
});
const ScenarioScreenshotAssertionSchema = z.object({
  label: z.string().min(1).max(100),
  mode: z.enum(["auto", "mainCamera", "game", "sceneView", "scene"]).optional(),
  width: z.number().int().positive().max(4096).optional(),
  height: z.number().int().positive().max(4096).optional(),
  superSize: z.number().int().positive().max(8).optional(),
  baselinePath: z.string().min(1).optional(),
  dimensionMode: z.enum(["reject", "resample-current"]).optional(),
  threshold: z.number().nonnegative().max(1).optional(),
  maxSamples: z.number().int().positive().max(16_777_216).optional(),
  allowApproximate: z.boolean().optional()
});
const ScenarioCaseSchema = z.object({
  id: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  expectedResult: z.enum(["pass", "compile-failure", "assertion-failure", "timeout", "cancelled"]).default("pass"),
  expectedFailureCode: z.string().min(1).optional(),
  expectedCompilerDiagnostics: z
    .array(
      z.object({
        file: z.string().min(1).max(1024),
        severity: z.enum(["error", "warning"]),
        code: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
        minimumCount: z.number().int().min(1).max(1000).optional()
      })
    )
    .min(1)
    .max(100)
    .optional(),
  timeoutMs: z.number().int().positive().max(900000).optional(),
  sourceMutations: z.array(ScenarioSourceMutationSchema).max(20).optional(),
  inputs: z.array(ScenarioInputSchema).max(100).optional(),
  consoleAssertions: z.array(ScenarioConsoleAssertionSchema).max(100).optional(),
  objectAssertions: z.array(ScenarioObjectAssertionSchema).max(100).optional(),
  screenshotAssertions: z.array(ScenarioScreenshotAssertionSchema).max(20).optional()
});

function annotationsFor(meta: GhostToolMeta): ToolAnnotations {
  return {
    readOnlyHint: !meta.mutates,
    destructiveHint: meta.destructive ?? meta.risk === "destructive",
    idempotentHint: meta.idempotent ?? !meta.mutates,
    openWorldHint: meta.openWorld ?? meta.risk === "external"
  };
}

function registerTool<TSchema extends ToolSchema>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: TSchema,
  meta: GhostToolMeta,
  handler: ToolHandler<z.output<z.ZodObject<TSchema>>>,
  outputSchema: ToolSchema = GhostToolResponseSchema
): void {
  const effectiveInputSchema = (meta.mutates ? { ...MutationRequestSchema, ...inputSchema } : inputSchema) as TSchema;
  const catalogEntry = recordOperation(server, name, description, effectiveInputSchema, outputSchema, meta);
  if (!operationEnabled(catalogEntry, contextProfiles(server))) return;

  server.registerTool(
    name,
    {
      description,
      inputSchema: effectiveInputSchema,
      outputSchema,
      annotations: annotationsFor(meta),
      _meta: {
        "unity-mcp-ghost/operationId": catalogEntry.operationId,
        "unity-mcp-ghost/catalogVersion": catalogEntry.version,
        "unity-mcp-ghost/profile": catalogEntry.profile,
        "unity-mcp-ghost/risk": catalogEntry.risk,
        "unity-mcp-ghost/mutates": catalogEntry.mutates,
        "unity-mcp-ghost/supportsDryRun": catalogEntry.supportsDryRun,
        "unity-mcp-ghost/phase": catalogEntry.phase,
        "unity-mcp-ghost/relatedResources": catalogEntry.relatedResources ?? [],
        "unity-mcp-ghost/examples": catalogEntry.examples,
        "unity-mcp-ghost/permissionClass": catalogEntry.permissionClass,
        "unity-mcp-ghost/mainThread": catalogEntry.mainThread,
        "unity-mcp-ghost/undoable": catalogEntry.undoable,
        "unity-mcp-ghost/expectedDurationMs": catalogEntry.expectedDurationMs,
        "unity-mcp-ghost/bridgeOperations": catalogEntry.bridgeOperations ?? []
      }
    },
    (async (args: z.output<z.ZodObject<TSchema>>, extra: ToolExtra) => {
      const result = await handler(args, extra);
      const requestId = stringValue(asObject(args).requestId);
      if (meta.mutates && requestId && result.structuredContent && typeof result.structuredContent === "object") {
        (result.structuredContent as Record<string, unknown>).requestId = requestId;
      }
      return result;
    }) as never
  );
}

const serverProfiles = new WeakMap<McpServer, OperationProfile[]>();

function contextProfiles(server: McpServer): OperationProfile[] {
  return serverProfiles.get(server) ?? ["all"];
}

function registerJsonResource(server: McpServer, name: string, uri: string, description: string, read: () => Promise<unknown> | unknown): void {
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

function compileFailure(code: string, message: string, data?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, data, requestId: data?.requestId, projectId: data?.projectId });
}

// One monotonic budget covers the public validation start, all observations and
// the final diagnostics read. The local race bounds even a non-cooperative
// producer; it does not claim to stop Unity work already dispatched by transport.
class CompileWaitBudget {
  private readonly startedAt = performance.now();
  private readonly deadline: number;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly cancel = () => this.controller.abort();
  private timedOut = false;

  public constructor(
    timeoutMs: number,
    private readonly callerSignal?: AbortSignal
  ) {
    this.deadline = this.startedAt + timeoutMs;
    callerSignal?.addEventListener("abort", this.cancel, { once: true });
    if (callerSignal?.aborted) this.cancel();
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, timeoutMs);
  }

  public get elapsedMs(): number {
    return performance.now() - this.startedAt;
  }

  public check(): number {
    if (this.callerSignal?.aborted) throw compileFailure("OPERATION_CANCELLED", "Compile observation was cancelled.");
    const remaining = this.deadline - performance.now();
    if (this.timedOut || remaining <= 0) {
      this.timedOut = true;
      this.controller.abort();
      throw compileFailure("COMPILE_GENERATION_TIMEOUT", "The total compile observation deadline elapsed.");
    }
    return remaining;
  }

  public async request(
    context: ToolContext,
    method: string,
    params: Record<string, unknown>,
    options: UnityRequestOptions = {}
  ): Promise<Record<string, unknown>> {
    const timeoutMs = this.check();
    const signal = this.controller.signal;
    let abort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => {
        try {
          this.check();
        } catch (error) {
          reject(error);
        }
      };
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const result = await Promise.race([context.unity.request(method, params, { ...options, timeoutMs, signal }), stopped]);
      this.check();
      return asObject(result);
    } catch (error) {
      this.check();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  public async sleep(intervalMs: number): Promise<void> {
    const duration = Math.min(intervalMs, this.check());
    const signal = this.controller.signal;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, duration);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
    this.check();
  }

  public dispose(): void {
    clearTimeout(this.timer);
    this.callerSignal?.removeEventListener("abort", this.cancel);
  }
}

function retryableCompileRead(error: unknown): boolean {
  if (error instanceof UnityRequestTimeoutError) return error.code === "UNITY_REQUEST_TIMEOUT" && error.outcomeUnknown === false;
  if (!(error instanceof UnityCommandError)) return false;
  if (["EXECUTING", "OUTCOME_UNKNOWN", "REQUEST_EXECUTION_IN_PROGRESS"].includes(error.code)) return true;
  const data = asObject(error.data);
  return error.code === "EXPIRED" && data.status === "expired" && data.outcomeUnknown === false;
}

function diagnosticShape(value: unknown, generation: number): boolean {
  const item = asObject(value);
  return (
    item.generation === generation &&
    Number.isSafeInteger(item.sequence) &&
    Number(item.sequence) > 0 &&
    typeof item.timestampUtc === "string" &&
    Number.isFinite(Date.parse(item.timestampUtc)) &&
    typeof item.assembly === "string" &&
    ["error", "warning"].includes(stringValue(item.severity)) &&
    typeof item.code === "string" &&
    typeof item.message === "string" &&
    typeof item.file === "string" &&
    Number.isSafeInteger(item.line) &&
    Number(item.line) >= 0 &&
    Number.isSafeInteger(item.column) &&
    Number(item.column) >= 0
  );
}

function validatePublicCompileEvidence(value: Record<string, unknown>, generation: number): void {
  const diagnostics = arrayValue(value.diagnostics);
  const errors = diagnostics.filter((item) => asObject(item).severity === "error");
  const requestedAt = typeof value.requestedAtUtc === "string" ? Date.parse(value.requestedAtUtc) : NaN;
  const observedAt = typeof value.observedAtUtc === "string" ? Date.parse(value.observedAtUtc) : NaN;
  const completedAt = typeof value.completedAtUtc === "string" ? Date.parse(value.completedAtUtc) : NaN;
  const succeeded = value.status === "success";
  if (
    value.observed !== true ||
    value.outcomeUnknown === true ||
    !Number.isFinite(requestedAt) ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(completedAt) ||
    observedAt < requestedAt ||
    completedAt < observedAt ||
    !Array.isArray(value.diagnostics) ||
    value.diagnosticsTruncated !== false ||
    diagnostics.length > 1000 ||
    diagnostics.some((item) => !diagnosticShape(item, generation)) ||
    new Set(diagnostics.map((item) => asObject(item).sequence)).size !== diagnostics.length ||
    !Number.isSafeInteger(value.errorCount) ||
    value.errorCount !== errors.length ||
    value.ok !== succeeded ||
    (succeeded ? errors.length !== 0 || value.error != null : errors.length === 0 || asObject(value.error).code !== "COMPILE_GENERATION_FAILED")
  ) {
    throw compileFailure("COMPILE_EVIDENCE_INVALID", "Unity did not return coherent, observed, completed exact-generation compiler evidence.", {
      requestedCompileGeneration: generation,
      observed: value,
      requestId: value.requestId,
      projectId: value.projectId
    });
  }
}

async function waitForUnityCompile(
  context: ToolContext,
  requestedCompileGeneration: number,
  timeoutMs: number,
  intervalMs = 250,
  existingBudget?: CompileWaitBudget
): Promise<Record<string, unknown>> {
  const budget = existingBudget ?? new CompileWaitBudget(timeoutMs);
  let lastState: Record<string, unknown> | null = null;
  try {
    while (true) {
      budget.check();
      try {
        lastState = await budget.request(context, "compile.status_get", { requestedCompileGeneration });
      } catch (error) {
        if (!retryableCompileRead(error)) throw error;
        await budget.sleep(Math.max(intervalMs, 1000));
        continue;
      }
      // Unknown generations and typed bridge failures are not failed compilations.
      if (lastState.ok === false && asObject(lastState.error).code !== "COMPILE_GENERATION_FAILED") return lastState;
      if (
        lastState.generation !== requestedCompileGeneration ||
        (lastState.requestedCompileGeneration !== undefined && lastState.requestedCompileGeneration !== requestedCompileGeneration)
      ) {
        throw compileFailure("COMPILE_GENERATION_MISMATCH", "Unity did not confirm the requested compile generation.", {
          requestedCompileGeneration,
          observed: lastState,
          requestId: lastState.requestId,
          projectId: lastState.projectId
        });
      }
      if (lastState.status === "success" || lastState.status === "failed") {
        validatePublicCompileEvidence(lastState, requestedCompileGeneration);
        budget.check();
        return { ...lastState, elapsedMs: budget.elapsedMs, requestedCompileGeneration };
      }
      if (lastState.ok !== true || !["waiting", "running"].includes(stringValue(lastState.status))) {
        throw compileFailure("COMPILE_EVIDENCE_INVALID", "Unity returned no valid compile observation.", lastState);
      }
      await budget.sleep(intervalMs);
    }
  } catch (error) {
    if (asObject(error).code !== "COMPILE_GENERATION_TIMEOUT") throw error;
    return {
      ok: false,
      status: "timeout",
      error: { code: "COMPILE_GENERATION_TIMEOUT", message: `Timed out waiting for compile generation ${requestedCompileGeneration}.` },
      elapsedMs: budget.elapsedMs,
      requestedCompileGeneration,
      state: lastState
    };
  } finally {
    if (!existingBudget) budget.dispose();
  }
}

function validatePublicDiagnostics(result: Record<string, unknown>, compile: Record<string, unknown>, path: string, limit: number): Record<string, unknown>[] {
  const generation = Number(compile.generation);
  const normalizedPath = path.trim().replaceAll("\\", "/").toLowerCase();
  const matches = (item: Record<string, unknown>) =>
    item.severity === "error" && stringValue(item.file).trim().replaceAll("\\", "/").toLowerCase().includes(normalizedPath);
  const expected = arrayValue(compile.diagnostics).map(asObject).filter(matches);
  const expectedBySequence = new Map(expected.map((item) => [item.sequence, item]));
  const diagnostics = arrayValue(result.diagnostics).map(asObject);
  const fields = ["sequence", "generation", "timestampUtc", "assembly", "severity", "code", "message", "file", "line", "column"];
  if (
    result.ok !== true ||
    result.generation !== generation ||
    !Array.isArray(result.diagnostics) ||
    result.truncated !== false ||
    diagnostics.length > limit ||
    diagnostics.length !== expected.length ||
    new Set(diagnostics.map((item) => item.sequence)).size !== diagnostics.length ||
    diagnostics.some((item) => {
      const other = expectedBySequence.get(item.sequence);
      return !diagnosticShape(item, generation) || !matches(item) || !other || !fields.every((field) => item[field] === other[field]);
    })
  ) {
    throw compileFailure(
      "COMPILE_DIAGNOSTICS_INVALID",
      "Unity did not return complete, matching diagnostics for the requested file and compile generation.",
      result
    );
  }
  return diagnostics;
}

async function waitForPlayState(
  context: ToolContext,
  requestedState: "playing" | "paused" | "stopped",
  transitionGeneration: number,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let last: Record<string, unknown> = {};
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = asObject(await context.unity.request("play_mode.get", {}, { timeoutMs: Math.min(5000, timeoutMs) }));
      if (last.state === requestedState && Number(last.transitionGeneration) >= transitionGeneration) {
        return { ...last, settled: true, elapsedMs: Date.now() - startedAt };
      }
    } catch {
      // Domain reload or transport reconnect: keep polling the pinned editor until deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    ok: false,
    status: "timeout",
    state: last,
    error: { code: "PLAY_MODE_TRANSITION_TIMEOUT", message: `Timed out waiting for Play mode state '${requestedState}'.` },
    elapsedMs: Date.now() - startedAt
  };
}

async function waitForInputReceipt(context: ToolContext, operationId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let last: Record<string, unknown> = {};
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = asObject(await context.unity.request("input.status", { operationId }));
      if (last.status !== "running") {
        return { ...last, elapsedMs: Date.now() - startedAt };
      }
    } catch {
      // A reload-aware input backend may briefly disconnect the bridge.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    ok: false,
    operationId,
    status: "timeout",
    state: last,
    error: { code: "INPUT_SIMULATION_TIMEOUT", message: "Timed out waiting for verified input delivery." },
    elapsedMs: Date.now() - startedAt
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
  const haystack = [entry.label, entry.fileName, entry.path, entry.scenePath, entry.cameraName].map((value) => stringValue(value).toLowerCase()).join(" ");
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
  return new Set(
    arrayValue(payload.properties)
      .map((property) => stringValue(asObject(property).path))
      .filter(Boolean)
  );
}

async function ensureUnityComponent(context: ToolContext, instanceId: number, typeName: string, dryRun: boolean): Promise<ComponentSetupResult> {
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
      profiles: contextProfiles(server),
      catalogVersion: 1,
      tools: listOperationCatalog(server)
        .filter((tool) => operationEnabled(tool, contextProfiles(server)))
        .map((tool) => ({
          operationId: tool.operationId,
          name: tool.name,
          description: tool.description,
          profile: tool.profile,
          risk: tool.risk,
          mutates: tool.mutates,
          supportsDryRun: tool.supportsDryRun,
          phase: tool.phase,
          relatedResources: tool.relatedResources ?? [],
          examples: tool.examples
        }))
    })
  );

  registerJsonResource(server, "Unity Editor State", "unity://editor/state", "Read current Unity Editor state without invoking a mutating tool.", () =>
    readUnityResource(context, "editor.get_state")
  );

  registerJsonResource(server, "Unity Active Scene Hierarchy", "unity://scenes/active", "Read the active scene hierarchy as deterministic JSON.", () =>
    readUnityResource(context, "scene.get_hierarchy", { includeInactive: true, maxDepth: 32 })
  );

  registerJsonResource(server, "Unity Console Errors", "unity://console/errors", "Read recent Unity console errors for validation and repair workflows.", () =>
    readUnityResource(context, "console.get_logs", { severity: "error", limit: 200 })
  );

  registerJsonResource(server, "Unity Packages", "unity://packages", "Read Unity Package Manager packages through a short-polled operation.", () =>
    readUnityOperationResource(context, "package.list", { includeIndirect: true, includeOffline: true })
  );

  registerJsonResource(server, "Unity Ghost Operations", "unity://operations", "List long-running Ghost operations tracked in the Unity editor session.", () =>
    readUnityResource(context, "operation.list")
  );

  registerJsonResourceTemplate(server, "Unity GameObject", "unity://gameobject/{instanceId}", "Read a GameObject by Unity instance id.", (variables) =>
    readUnityResource(context, "gameobject.get", { instanceId: Number.parseInt(firstVariable(variables.instanceId), 10) })
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

  registerJsonResourceTemplate(server, "Unity Ghost Operation", "unity://operation/{operationId}", "Read a tracked Ghost operation status.", (variables) =>
    readUnityResource(context, "operation.get", { operationId: firstVariable(variables.operationId) })
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

export function registerUnityRequestTool<TSchema extends ToolSchema>(
  server: McpServer,
  context: ToolContext,
  name: string,
  description: string,
  inputSchema: TSchema,
  meta: GhostToolMeta,
  method: string | ((args: z.output<z.ZodObject<TSchema>>) => string),
  params: (args: z.output<z.ZodObject<TSchema>>) => unknown = (args) => args
): void {
  registerTool(
    server,
    name,
    description,
    inputSchema,
    { ...meta, bridgeOperations: typeof method === "string" ? [method] : meta.bridgeOperations },
    async (args) => {
      const startedAt = Date.now();
      const unityMethod = typeof method === "function" ? method(args) : method;

      try {
        const request = asObject(args);
        const data = await context.unity.request(unityMethod, params(args), {
          requestId: stringValue(request.requestId) || undefined,
          idempotencyKey: stringValue(request.idempotencyKey) || undefined
        });
        return successResponse(`${name} completed.`, asObject(data), startedAt);
      } catch (error) {
        return failureResponse(`${name} failed`, error, startedAt);
      }
    }
  );
}

export function createMcpServer(context: ToolContext): McpServer {
  const server = new McpServer({
    name: "unity-mcp-ghost",
    version: PackageVersion
  });
  serverProfiles.set(server, context.toolProfiles ?? ["all"]);
  const scenarios =
    context.scenarios ??
    new ScenarioJobManager({
      unity: context.unity,
      projectPath: context.projectPath,
      projectId: context.projectId,
      editorInstanceId: context.editorInstanceId
    });

  registerTool(
    server,
    "ping",
    "Verify that the MCP server is alive and report Unity bridge reachability.",
    EmptySchema,
    { risk: "read", mutates: false, supportsDryRun: false, phase: 1 },
    async () => {
      const startedAt = Date.now();
      let unityConnected: boolean;
      try {
        unityConnected = await context.unity.isConnected();
      } catch (error) {
        return failureResponse("ping connection check failed", error, startedAt, [], { code: "UNITY_CONNECTION_CHECK_FAILED" });
      }

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
      let unityConnected: boolean;
      try {
        unityConnected = await context.unity.isConnected();
      } catch (error) {
        return failureResponse("health connection check failed", error, startedAt, [], { code: "UNITY_CONNECTION_CHECK_FAILED" });
      }

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
    { risk: "read", mutates: false, supportsDryRun: false, phase: 1, relatedResources: ["unity://console/errors"] },
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
    "console_clear",
    "Clear Ghost's persistent Console buffer, attempt to clear Unity's visible Console, and return a fresh boundary.",
    EmptySchema,
    { risk: "safe-write", mutates: true, supportsDryRun: false, phase: 4, idempotent: false, examples: [{}] },
    "console.clear"
  );

  registerUnityRequestTool(
    server,
    context,
    "console_mark",
    "Create a persisted Console boundary token for later wait/assert operations.",
    { label: z.string().max(200).default("") },
    { risk: "safe-write", mutates: true, supportsDryRun: false, phase: 4, idempotent: false, examples: [{ label: "before-course-case" }] },
    "console.mark"
  );

  registerTool(
    server,
    "console_wait",
    "Wait for post-boundary Unity Console entries that satisfy message, location, severity, and count filters.",
    {
      ...ConsoleFilterSchema,
      timeoutMs: z.number().int().positive().max(300000).default(30000),
      pollIntervalMs: z.number().int().min(25).max(5000).default(100)
    },
    {
      risk: "read",
      mutates: false,
      supportsDryRun: false,
      phase: 4,
      examples: [{ boundary: "boundary-token", severity: "log", contains: "Hello", minimumCount: 1, timeoutMs: 5000 }]
    },
    async (args) => {
      const startedAt = Date.now();
      const { timeoutMs, pollIntervalMs, ...filter } = args;
      let last: Record<string, unknown> = {};
      try {
        while (Date.now() - startedAt < timeoutMs) {
          last = asObject(await context.unity.request("console.query", filter));
          if (last.ok === false || last.matched === true) {
            return successResponse("Console wait completed.", last, startedAt);
          }
          if (Array.isArray(last.unexpectedErrors) && last.unexpectedErrors.length > 0) {
            return successResponse(
              "Console wait stopped because an unexpected error was observed.",
              {
                ...last,
                ok: false,
                error: { code: "UNEXPECTED_CONSOLE_ERROR", message: "An unexpected Unity Console error appeared after the boundary." }
              },
              startedAt
            );
          }
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        return successResponse(
          "Console wait timed out.",
          {
            ...last,
            ok: false,
            status: "timeout",
            error: { code: "CONSOLE_WAIT_TIMEOUT", message: "Timed out waiting for the requested Console entries." }
          },
          startedAt
        );
      } catch (error) {
        return failureResponse("console_wait failed", error, startedAt);
      }
    }
  );

  registerUnityRequestTool(
    server,
    context,
    "console_assert",
    "Assert post-boundary Console entries and fail on mismatched counts or unexpected errors.",
    ConsoleFilterSchema,
    {
      risk: "read",
      mutates: false,
      supportsDryRun: false,
      phase: 4,
      examples: [{ boundary: "boundary-token", severity: "error", count: 0, failOnUnexpectedErrors: true }]
    },
    "console.assert"
  );

  registerUnityRequestTool(
    server,
    context,
    "play_mode_get",
    "Read the exact normal Play mode transition state, scene, identity, generation, frame, and time.",
    EmptySchema,
    { risk: "read", mutates: false, supportsDryRun: false, phase: 4, examples: [{}] },
    "play_mode.get"
  );

  registerTool(
    server,
    "play_mode_set",
    "Enter, pause, resume, or stop normal Unity Play mode and optionally wait until the requested state is observed.",
    {
      state: z.enum(["playing", "paused", "stopped"]),
      waitForSettled: z.boolean().default(true),
      timeoutMs: z.number().int().positive().max(300000).default(30000),
      saveModifiedScenes: z.boolean().default(false)
    },
    {
      risk: "safe-write",
      mutates: true,
      supportsDryRun: false,
      phase: 4,
      idempotent: true,
      examples: [{ state: "playing", waitForSettled: true, timeoutMs: 30000, saveModifiedScenes: false }]
    },
    async (args) => {
      const startedAt = Date.now();
      try {
        const initiated = asObject(
          await context.unity.request("play_mode.set", {
            state: args.state,
            saveModifiedScenes: args.saveModifiedScenes
          })
        );
        if (initiated.ok === false || !args.waitForSettled) {
          return successResponse("Play mode transition request completed.", initiated, startedAt);
        }
        const settled = await waitForPlayState(context, args.state, numberValue(initiated.transitionGeneration), args.timeoutMs);
        return successResponse(
          "Play mode transition settled.",
          { ...initiated, ok: settled.ok !== false, settledState: settled, error: settled.error ?? null },
          startedAt
        );
      } catch (error) {
        return failureResponse("play_mode_set failed", error, startedAt);
      }
    }
  );

  registerTool(
    server,
    "play_mode_step",
    "Advance exactly one frame while normal Play mode is paused and verify the frame/time change.",
    { timeoutMs: z.number().int().positive().max(30000).default(5000) },
    {
      risk: "safe-write",
      mutates: true,
      supportsDryRun: false,
      phase: 4,
      idempotent: false,
      examples: [{ timeoutMs: 5000 }]
    },
    async (args) => {
      const startedAt = Date.now();
      try {
        const initiated = asObject(await context.unity.request("play_mode.step"));
        if (initiated.ok === false) {
          return successResponse("Play mode step was rejected.", initiated, startedAt);
        }
        const expectedFrame = numberValue(initiated.expectedFrame);
        let observed: Record<string, unknown> = {};
        while (Date.now() - startedAt < args.timeoutMs) {
          observed = asObject(await context.unity.request("play_mode.get"));
          const frame = numberValue(observed.frameCount);
          if (frame >= expectedFrame) {
            const exact = frame === expectedFrame && observed.state === "paused" && numberValue(observed.timeSinceStartup) > numberValue(initiated.beforeTime);
            return successResponse(
              "Play mode frame step observed.",
              {
                ...initiated,
                ok: exact,
                observed,
                error: exact ? null : { code: "PLAY_MODE_STEP_NOT_EXACT", message: "Unity advanced by more than one frame or did not remain paused." }
              },
              startedAt
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return successResponse(
          "Play mode frame step timed out.",
          {
            ...initiated,
            ok: false,
            observed,
            error: { code: "PLAY_MODE_STEP_TIMEOUT", message: "Unity did not expose the expected frame/time change before timeout." }
          },
          startedAt
        );
      } catch (error) {
        return failureResponse("play_mode_step failed", error, startedAt);
      }
    }
  );

  registerTool(
    server,
    "input_simulate",
    "Inject verified keyboard or UI pointer input through the active Input System or a project-scoped deterministic test driver.",
    {
      backend: z.enum(["auto", "unity-input-system", "project-test-driver"]).default("auto"),
      device: z.enum(["keyboard", "pointer"]).default("keyboard"),
      action: z.enum(["tap", "press", "release", "click"]).default("tap"),
      key: z.string().min(1).optional(),
      button: z.enum(["left"]).default("left"),
      x: z.number().optional(),
      y: z.number().optional(),
      timeoutMs: z.number().int().positive().max(30000).default(5000)
    },
    {
      risk: "safe-write",
      mutates: true,
      supportsDryRun: false,
      phase: 4,
      idempotent: false,
      examples: [
        { backend: "auto", device: "keyboard", action: "tap", key: "PageUp" },
        { backend: "project-test-driver", device: "keyboard", action: "tap", key: "PageDown" },
        { device: "pointer", action: "click", button: "left", x: 320, y: 180 }
      ]
    },
    async (args) => {
      const startedAt = Date.now();
      try {
        const { timeoutMs, ...request } = args;
        const initiated = asObject(await context.unity.request("input.simulate", request));
        if (initiated.ok === false || initiated.status !== "running") {
          return successResponse("Input simulation completed.", initiated, startedAt);
        }
        const operationId = stringValue(initiated.operationId);
        const completed = operationId ? await waitForInputReceipt(context, operationId, timeoutMs) : initiated;
        return successResponse("Input simulation delivery was observed.", completed, startedAt);
      } catch (error) {
        return failureResponse("input_simulate failed", error, startedAt);
      }
    }
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
    { risk: "read", mutates: false, supportsDryRun: false, phase: 1, relatedResources: ["unity://console/errors"] },
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
      path: z.string().min(1).optional(),
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
    "Compare two Unity PNG screenshots with explicit exact or bounded full-domain pixel coverage.",
    {
      baselinePath: z.string().min(1),
      currentPath: z.string().min(1),
      dimensionMode: z.enum(["reject", "resample-current"]).default("reject"),
      threshold: z.number().nonnegative().max(1).default(0.02),
      maxSamples: z.number().int().positive().max(16_777_216).default(20000)
    },
    {
      risk: "read",
      mutates: false,
      supportsDryRun: false,
      phase: 3,
      relatedResources: ["unity://screenshots/baselines", "unity://screenshots/baselines/{filter}"]
    },
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
    {
      risk: "read",
      mutates: false,
      supportsDryRun: false,
      phase: 3,
      relatedResources: ["unity://screenshots/baselines", "unity://screenshots/baselines/{filter}"]
    },
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
    {
      risk: "destructive",
      mutates: true,
      supportsDryRun: true,
      phase: 3,
      relatedResources: ["unity://screenshots/baselines", "unity://screenshots/baselines/{filter}"]
    },
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

  registerAuthoringTools(server, context);

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

  registerCodeTools(server, context);

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
    async (args, extra) => {
      const startedAt = Date.now();
      const budget = new CompileWaitBudget(args.timeoutMs, extra.signal);
      const requestId = randomUUID();
      let validationStart: Record<string, unknown> | undefined;
      let compile: Record<string, unknown> | undefined;
      let startDispatched = false;
      try {
        budget.check();
        startDispatched = true;
        validationStart = await budget.request(
          context,
          "script.validate",
          {
            path: args.path,
            requestedCompileGeneration: args.requestedCompileGeneration,
            limit: args.limit,
            dryRun: args.dryRun
          },
          { requestId }
        );
        if (validationStart.ok !== true) {
          if (validationStart.ok === false) return successResponse("script_validate start failed.", validationStart, startedAt);
          throw compileFailure("SCRIPT_VALIDATE_FAILED", "Unity did not confirm the validation start.", validationStart);
        }
        if (validationStart.error != null || validationStart.outcomeUnknown === true) {
          const error = asObject(validationStart.error);
          throw compileFailure(
            stringValue(error.code) || (validationStart.outcomeUnknown === true ? "OUTCOME_UNKNOWN" : "SCRIPT_VALIDATE_FAILED"),
            stringValue(error.message) || "Unity did not confirm a successful validation start.",
            validationStart
          );
        }
        if (args.dryRun) {
          return successResponse("script_validate dry run completed.", validationStart, startedAt);
        }

        const generation = numberValue(validationStart.requestedCompileGeneration);
        if (!Number.isSafeInteger(generation) || generation <= 0) {
          throw compileFailure("MISSING_COMPILE_GENERATION", "Unity did not return an exact compile generation.", validationStart);
        }
        if (args.requestedCompileGeneration !== undefined && generation !== args.requestedCompileGeneration) {
          throw compileFailure("COMPILE_GENERATION_MISMATCH", "Validation did not confirm the requested compile generation.", validationStart);
        }
        compile = await waitForUnityCompile(context, generation, args.timeoutMs, 250, budget);
        if (
          !(compile.status === "success" && compile.ok === true) &&
          !(compile.status === "failed" && asObject(compile.error).code === "COMPILE_GENERATION_FAILED")
        ) {
          return successResponse("script_validate could not observe compilation.", { ...compile, path: args.path, validationStart, compile }, startedAt);
        }
        const diagnosticResult = await budget.request(context, "compile.diagnostics_get", {
          severity: "error",
          pathFilter: args.path,
          generation,
          limit: args.limit
        });
        if (diagnosticResult.ok === false) {
          return successResponse("script_validate diagnostics failed.", { ...diagnosticResult, path: args.path, validationStart, compile }, startedAt);
        }
        if (diagnosticResult.error != null || diagnosticResult.outcomeUnknown === true) {
          const error = asObject(diagnosticResult.error);
          throw compileFailure(
            stringValue(error.code) || "COMPILE_DIAGNOSTICS_INVALID",
            stringValue(error.message) || "Unity did not confirm a successful diagnostics read.",
            diagnosticResult
          );
        }
        const diagnostics = validatePublicDiagnostics(diagnosticResult, compile, args.path, args.limit);
        budget.check();
        const compilerErrorCount = Number(compile.errorCount);
        const validationOk = compile.ok === true && compilerErrorCount === 0 && diagnostics.length === 0;
        return successResponse(
          "script_validate completed.",
          {
            ok: validationOk,
            error: validationOk
              ? null
              : {
                  code: "SCRIPT_COMPILER_ERRORS",
                  message: `Compile generation ${generation} produced ${compilerErrorCount} total compiler error${compilerErrorCount === 1 ? "" : "s"}; ${diagnostics.length} match '${args.path}'.`
                },
            path: args.path,
            requestedCompileGeneration: generation,
            requestId: validationStart.requestId ?? requestId,
            projectId: validationStart.projectId ?? context.projectId,
            compile,
            compilerErrorCount,
            scopedErrorCount: diagnostics.length,
            diagnostics
          },
          startedAt,
          { confidence: validationOk ? 1 : 0 }
        );
      } catch (error) {
        const failure = asObject(error);
        const mayHaveStarted = startDispatched && !validationStart && !args.dryRun && args.requestedCompileGeneration === undefined;
        const knownUnexecuted =
          (error instanceof UnityRequestTimeoutError && error.outcomeUnknown === false) ||
          (error instanceof UnityCommandError && asObject(error.data).outcomeUnknown === false);
        const outcomeUnknown = mayHaveStarted && !knownUnexecuted;
        return failureResponse("script_validate failed", error, startedAt, [], {
          requestId: stringValue(failure.requestId) || stringValue(validationStart?.requestId) || requestId,
          projectId: stringValue(failure.projectId) || stringValue(validationStart?.projectId) || context.projectId,
          data: { ...asObject(failure.data), validationStart, compile, ...(mayHaveStarted ? { outcomeUnknown } : {}) },
          ...(outcomeUnknown
            ? {
                warnings: [
                  "The validation start may have reached Unity; its outcome is unknown. Reconcile the dispatched request before starting another validation."
                ]
              }
            : {})
        });
      } finally {
        budget.dispose();
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
    { risk: "destructive", mutates: true, supportsDryRun: true, phase: 2, destructive: true },
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
    { risk: "external", mutates: false, supportsDryRun: false, phase: 2, openWorld: true, relatedResources: ["unity://packages"] },
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
    { risk: "external", mutates: true, supportsDryRun: true, phase: 2, openWorld: true },
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
    { risk: "destructive", mutates: true, supportsDryRun: true, phase: 2, destructive: true },
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
    { risk: "external", mutates: true, supportsDryRun: true, phase: 2, destructive: true, openWorld: true },
    (args) => `package.${args.action}`,
    (args) => args.params
  );

  registerTool(
    server,
    "operation_get",
    "Read the latest status for a durable Ghost operation, including scenario matrices.",
    { operationId: z.string().min(1) },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 2 },
    async (args) => {
      const startedAt = Date.now();
      try {
        const data = isScenarioOperationId(args.operationId)
          ? await scenarios.get(args.operationId)
          : asObject(await context.unity.request("operation.get", args));
        return successResponse("operation_get completed.", data, startedAt);
      } catch (error) {
        return failureResponse("operation_get failed", error, startedAt);
      }
    }
  );

  registerTool(
    server,
    "operation_list",
    "List durable Unity and scenario operations retained by the pinned project.",
    { limit: z.number().int().positive().max(200).default(50) },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 2 },
    async (args) => {
      const startedAt = Date.now();
      try {
        const unity = asObject(await context.unity.request("operation.list"));
        const scenario = scenarios.available ? await scenarios.list(args.limit) : { operations: [] };
        const operations = [...arrayValue(unity.operations), ...arrayValue(scenario.operations)]
          .sort((left, right) => stringValue(asObject(right).updatedUtc).localeCompare(stringValue(asObject(left).updatedUtc)))
          .slice(0, args.limit);
        return successResponse("operation_list completed.", { ok: true, operations, count: operations.length }, startedAt);
      } catch (error) {
        return failureResponse("operation_list failed", error, startedAt);
      }
    }
  );

  registerTool(
    server,
    "operation_cancel",
    "Request cancellation of a durable Ghost operation and preserve restoration evidence.",
    { operationId: z.string().min(1) },
    { risk: "safe-write", mutates: true, supportsDryRun: false, phase: 3, idempotent: true },
    async (args) => {
      const startedAt = Date.now();
      try {
        const data = isScenarioOperationId(args.operationId)
          ? await scenarios.cancel(args.operationId)
          : asObject(await context.unity.request("operation.cancel", args));
        return successResponse("operation_cancel completed.", data, startedAt);
      } catch (error) {
        return failureResponse("operation_cancel failed", error, startedAt);
      }
    }
  );

  registerTool(
    server,
    "operation_result",
    "Return the compact terminal result and durable evidence handles for an operation.",
    { operationId: z.string().min(1) },
    { risk: "read", mutates: false, supportsDryRun: false, phase: 5 },
    async (args) => {
      const startedAt = Date.now();
      try {
        if (isScenarioOperationId(args.operationId)) {
          return successResponse("operation_result completed.", await scenarios.result(args.operationId), startedAt);
        }
        const operation = asObject(await context.unity.request("operation.get", args));
        return successResponse(
          "operation_result completed.",
          {
            ok: operation.status === "success",
            operationId: args.operationId,
            status: operation.status,
            ready: ["success", "failed", "timeout", "cancelled", "outcomeUnknown"].includes(stringValue(operation.status)),
            result: operation.state ?? null,
            error: asObject(operation.state).error ?? null
          },
          startedAt
        );
      } catch (error) {
        return failureResponse("operation_result failed", error, startedAt);
      }
    }
  );

  registerTool(
    server,
    "scenario_matrix_run",
    "Start a durable, cancellable matrix that mutates C#, waits for exact compile generations, runs normal Play mode inputs/assertions, restores state, and emits evidence.",
    {
      name: z.string().min(1).max(200),
      projectId: z.string().min(1).optional(),
      editorInstanceId: z.string().min(1).optional(),
      scenePath: z.string().min(1),
      compileTimeoutMs: z.number().int().positive().max(300000).default(60000),
      zeroCompilerErrors: z.boolean().default(true),
      failFast: z.boolean().default(true),
      cleanupRequired: z.boolean().default(true),
      cases: z.array(ScenarioCaseSchema).min(1).max(200)
    },
    {
      risk: "code-write",
      mutates: true,
      supportsDryRun: false,
      phase: 5,
      idempotent: false,
      relatedResources: ["unity://evidence/{operationId}/{file}"],
      examples: [
        {
          name: "page navigation",
          scenePath: "Assets/GAM215Fixture/RuntimeControlFixture.unity",
          cases: [
            {
              id: "page-up",
              inputs: [{ device: "keyboard", action: "tap", key: "PageUp" }],
              consoleAssertions: [{ severity: "log", exact: "GAM215_PAGE:1", count: 1 }]
            }
          ]
        }
      ]
    },
    async (args) => {
      const startedAt = Date.now();
      try {
        return successResponse("Scenario matrix started.", await scenarios.start(args as ScenarioMatrixDefinition), startedAt);
      } catch (error) {
        return failureResponse("scenario_matrix_run failed", error, startedAt);
      }
    }
  );

  registerTool(
    server,
    "evidence_bundle_create",
    "Finalize the deterministic on-disk evidence directory for a terminal scenario operation without uploading it.",
    { operationId: z.string().uuid() },
    { risk: "safe-write", mutates: true, supportsDryRun: false, phase: 5, idempotent: true, relatedResources: ["unity://evidence/{operationId}/{file}"] },
    async (args) => {
      const startedAt = Date.now();
      try {
        return successResponse("Evidence bundle materialized.", await scenarios.createEvidence(args.operationId), startedAt);
      } catch (error) {
        return failureResponse("evidence_bundle_create failed", error, startedAt);
      }
    }
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
    async (args, extra) => {
      const startedAt = Date.now();
      const budget = new CompileWaitBudget(args.timeoutMs, extra.signal);
      try {
        const data = await waitForUnityCompile(context, args.requestedCompileGeneration, args.timeoutMs, 250, budget);
        return successResponse("compile_wait completed.", data, startedAt, {
          confidence: data.status === "success" ? 1 : 0.5
        });
      } catch (error) {
        return failureResponse("compile_wait failed", error, startedAt);
      } finally {
        budget.dispose();
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
            nextActions:
              proposals.length > 0
                ? [
                    "Review proposal confidence and rationale.",
                    "Apply only high-confidence proposals through script_apply_edits with dryRun=true first.",
                    "Run compile_wait and script_validate after any accepted edit."
                  ]
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
    "Preview or apply explicit ranged C# repair edits and verify compilation. Applying requires rollbackOnFailure=true. Returns result contract 2 with explicit compiler and recovery evidence.",
    {
      objective: z.string().default("Apply an explicit Unity C# repair safely."),
      scriptPath: z.string().min(1),
      edits: z.array(ScriptEditSchema).min(1),
      dryRun: DryRunSchema,
      rollbackOnFailure: z.boolean().default(true).describe("False is only valid for dry-run previews; applying repairs requires true."),
      compileTimeoutMs: z.number().int().positive().max(300000).default(30000),
      runTests: z.boolean().default(false),
      testMode: z.enum(["editmode", "playmode"]).default("editmode"),
      testFilter: z.string().default("")
    },
    { risk: "code-write", mutates: true, supportsDryRun: true, phase: 3, relatedResources: ["unity://console/errors", "unity://tests/{mode}"] },
    async (args) => {
      const startedAt = Date.now();
      const steps: Record<string, unknown>[] = [];
      const retainedBackups: Array<{ backupPath: string; backupMetaPath: string }> = [];
      const transactionCleanup: Record<string, unknown>[] = [];
      let originalSha256 = "";
      let currentSha256: string | null = null;
      let appliedSha256: string | null = null;
      let applyRequestId: string | undefined;
      let applyResult: Record<string, unknown> | null = null;
      let sourceChanged = false;
      let partialApply = false;
      let unconfirmedApply: { requestId: string; outcomeUnknown: true } | null = null;
      let unconfirmedTests: { requestId: string; operationId: string | null; outcomeUnknown: true } | null = null;
      let unconfirmedRestore: { requestId: string; outcomeUnknown: true } | null = null;
      let rollback: Record<string, unknown> | null = null;
      let repairVerified = false;
      let cleanupAttempted = false;
      let compilerErrorCount = 0;
      let scopedErrorCount = 0;
      let testsFailed = false;

      const hashFrom = (value: unknown): string | null => (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null);
      const producerError = (error: unknown, code: string, message: string): Error => {
        const detail = asObject(error);
        return Object.assign(new Error(stringValue(detail.message) || message), { code: stringValue(detail.code) || code, data: detail });
      };
      const requireOk = (receipt: Record<string, unknown>, code: string, message: string): void => {
        if (receipt.ok !== true) throw producerError(receipt.error, code, message);
      };
      const recordStep = (name: string, receipt: Record<string, unknown>): void => {
        steps.push({ name, ok: receipt.ok === true, data: receipt });
      };
      const retainBackup = (receipt: Record<string, unknown>): void => {
        const backup = { backupPath: stringValue(receipt.backupPath), backupMetaPath: stringValue(receipt.backupMetaPath) };
        if (
          (backup.backupPath || backup.backupMetaPath) &&
          !retainedBackups.some((entry) => entry.backupPath === backup.backupPath && entry.backupMetaPath === backup.backupMetaPath)
        ) {
          retainedBackups.push(backup);
        }
      };
      const readHash = async (step: string): Promise<string> => {
        currentSha256 = null;
        const read = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
        // Keep byte evidence in backups instead of duplicating full source text
        // in every read-back receipt.
        recordStep(step, { ...read, content: undefined });
        requireOk(read, "SCRIPT_READ_FAILED", "Source read-back was not confirmed.");
        currentSha256 = hashFrom(read.sha256);
        if (!currentSha256) throw producerError(null, "SCRIPT_HASH_MISSING", "Source read-back returned no valid SHA-256.");
        return currentSha256;
      };
      const compileAndValidate = async (generation: number, prefix = ""): Promise<void> => {
        if (!Number.isInteger(generation) || generation <= 0) {
          throw producerError(null, "COMPILE_GENERATION_MISSING", "The mutation returned no requested compile generation.");
        }
        const compile = await waitForUnityCompile(context, generation, args.compileTimeoutMs);
        recordStep(`${prefix}compile_wait`, compile);
        requireOk(compile, "REPAIR_COMPILE_FAILED", "The requested compile generation did not succeed.");
        if (compile.status !== "success" || numberValue(compile.generation) !== generation) {
          throw producerError(null, "COMPILE_GENERATION_MISMATCH", "Compilation did not confirm the requested generation.");
        }
        const validation = asObject(
          await context.unity.request("script.validate", { path: args.scriptPath, requestedCompileGeneration: generation, limit: 100 })
        );
        recordStep(`${prefix}script_validate`, validation);
        requireOk(validation, "SCRIPT_VALIDATE_FAILED", "Source validation failed.");
        if (numberValue(validation.requestedCompileGeneration) !== generation) {
          throw producerError(null, "COMPILE_GENERATION_MISMATCH", "Validation did not confirm the requested generation.");
        }
        const diagnostics = asObject(
          await context.unity.request("compile.diagnostics_get", { severity: "error", pathFilter: args.scriptPath, generation, limit: 100 })
        );
        recordStep(`${prefix}compile_diagnostics_get`, diagnostics);
        requireOk(diagnostics, "COMPILE_DIAGNOSTICS_FAILED", "Compiler diagnostics could not be verified.");
        if (numberValue(diagnostics.generation) !== generation) {
          throw producerError(null, "COMPILE_GENERATION_MISMATCH", "Compiler diagnostics did not confirm the requested generation.");
        }
        const errors = Math.max(diagnosticCount(validation), diagnosticCount(diagnostics));
        if (!prefix) {
          compilerErrorCount = diagnosticCount(diagnostics);
          scopedErrorCount = errors;
        }
        if (errors > 0) throw producerError(null, "REPAIR_DIAGNOSTICS_FAILED", "The requested generation still has scoped compiler errors.");
      };
      const restoreOriginal = async (): Promise<Record<string, unknown>> => {
        // Establish the attempt before any request; neither restoration nor its
        // cleanup may be replayed by an exception handler.
        rollback = { ok: false, expectedSha256: originalSha256, byteIdentical: false };
        try {
          const backup = retainedBackups[0];
          if (!backup?.backupPath || !appliedSha256) {
            throw producerError(null, "REPAIR_RECOVERY_MISSING", "Byte-preserving restoration requires the original backup and confirmed applied hash.");
          }
          const before = await readHash("rollback_source_read");
          if (before !== appliedSha256) {
            throw producerError(null, "REPAIR_SOURCE_CHANGED", "Source changed after the confirmed edit; preserve it and reconcile recovery before restoring.");
          }
          rollback.beforeSha256 = before;
          const requestId = randomUUID();
          unconfirmedRestore = { requestId, outcomeUnknown: true };
          currentSha256 = null;
          const writeBack = asObject(
            await context.unity.request("script.restore", { path: args.scriptPath, ...backup, expectedSha256: before }, { requestId })
          );
          unconfirmedRestore = null;
          rollback.writeBack = writeBack;
          retainBackup(writeBack);
          currentSha256 = hashFrom(writeBack.afterSha256);
          recordStep("rollback_script_write", writeBack);
          requireOk(writeBack, "SCRIPT_RESTORE_FAILED", "Source restoration was not confirmed.");
          await compileAndValidate(numberValue(writeBack.requestedCompileGeneration), "rollback_");
          const restoredSha256 = await readHash("rollback_hash_verify");
          rollback.restoredSha256 = restoredSha256;
          rollback.byteIdentical = restoredSha256 === originalSha256;
          if (!rollback.byteIdentical) throw producerError(null, "ROLLBACK_HASH_MISMATCH", "Restored source bytes do not match the original hash.");
          rollback.ok = true;
        } catch (error) {
          rollback.error = {
            code: stringValue(asObject(error).code) || "REPAIR_RESTORE_FAILED",
            message: error instanceof Error ? error.message : String(error)
          };
          if (unconfirmedRestore) rollback.unconfirmedRestore = unconfirmedRestore;
        }
        return rollback;
      };
      const completeTransactions = async (): Promise<void> => {
        if (cleanupAttempted) return;
        cleanupAttempted = true;
        while (retainedBackups.length > 0) {
          const backup = retainedBackups[0]!;
          let receipt: Record<string, unknown>;
          try {
            receipt = asObject(await context.unity.request("script.transaction_complete", backup));
          } catch (error) {
            receipt = {
              ok: false,
              outcomeUnknown: true,
              error: { code: stringValue(asObject(error).code) || "REPAIR_CLEANUP_FAILED", message: error instanceof Error ? error.message : String(error) }
            };
          }
          transactionCleanup.push({ ...receipt, ...backup, ok: receipt.ok === true });
          recordStep("script_transaction_complete", receipt);
          if (receipt.ok !== true) return;
          retainedBackups.shift();
        }
      };
      const evidenceMode = (): string => {
        if (unconfirmedApply) return "unknown";
        if (partialApply) return "recovery-required";
        if (rollback) return rollback.ok === true ? "rolled-back" : "restoration-unverified";
        if (sourceChanged) return "applied";
        return args.dryRun ? "dry-run" : "not-applied";
      };
      const evidence = (): Record<string, unknown> => {
        const recoveryPathsUnverified = transactionCleanup.some((receipt) => receipt.ok !== true);
        const hints: string[] = [];
        if (retainedBackups.length > 0)
          hints.push(
            recoveryPathsUnverified
              ? "Preserve the listed recovery backups; after failed cleanup their existence is unverified."
              : "The listed recovery backups are retained; cleanup was not attempted."
          );
        if (unconfirmedApply)
          hints.push(
            `Apply outcome is unknown for request ${unconfirmedApply.requestId}. Reconcile it with Unity before any apply, restore, or cleanup; a read cannot rule out a late write. The missing receipt may contain additional recovery paths.`
          );
        if (partialApply)
          hints.push(
            `The apply transaction requires recovery. Reconcile request ${applyRequestId} and its retained producer receipt before any apply, restore, or cleanup.`
          );
        if (unconfirmedTests)
          hints.push(
            `Required test execution is unsettled for request ${unconfirmedTests.requestId}${unconfirmedTests.operationId ? `, operation ${unconfirmedTests.operationId}` : ""}. Reconcile the Test Runner before source restoration or cleanup.`
          );
        if (unconfirmedRestore)
          hints.push(`Restoration outcome is unknown for request ${unconfirmedRestore.requestId}. Reconcile it before any further mutation or cleanup.`);
        if (rollback?.ok === false && !unconfirmedRestore)
          hints.push("Restoration was not verified. Inspect the original and current hashes and all backup bytes before manual recovery.");
        return {
          resultContractVersion: 2,
          consoleDiagnosticsChecked: false,
          objective: args.objective,
          scriptPath: args.scriptPath,
          editCount: args.edits.length,
          mode: evidenceMode(),
          originalSha256,
          currentSha256,
          finalSha256: repairVerified ? currentSha256 : null,
          applyRequestId,
          applyResult,
          unconfirmedApply,
          unconfirmedTests,
          unconfirmedRestore,
          repairVerified,
          scopedErrorCount,
          compilerErrorCount,
          consoleErrorCount: null,
          testsFailed,
          rollback,
          steps,
          transactionCleanup,
          retainedBackups: [...retainedBackups],
          recoveryPathsUnverified,
          recoveryHint: hints.length ? hints.join(" ") : null
        };
      };
      try {
        if (!args.dryRun && !args.rollbackOnFailure) {
          throw producerError(null, "REPAIR_ROLLBACK_REQUIRED", "repair_apply_edits requires rollbackOnFailure=true when applying a repair.");
        }
        const script = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
        recordStep("script_read_backup", { ...script, content: undefined });
        requireOk(script, "SCRIPT_READ_FAILED", "Cannot read the original source.");
        originalSha256 = hashFrom(script.sha256) ?? "";
        if (typeof script.content !== "string" || !originalSha256) {
          throw producerError(null, "REPAIR_ORIGINAL_UNVERIFIED", "Cannot begin repair without original source content and a valid byte hash.");
        }
        currentSha256 = originalSha256;

        const dryRunPreview = asObject(
          await context.unity.request("script.apply_edits", {
            path: args.scriptPath,
            edits: args.edits,
            expectedSha256: originalSha256,
            dryRun: true
          })
        );
        recordStep("script_apply_edits_dry_run", dryRunPreview);
        requireOk(dryRunPreview, "REPAIR_PREVIEW_FAILED", "The explicit edit preview failed.");

        if (args.dryRun) {
          return successResponse(
            "repair_apply_edits completed dry-run preview.",
            {
              ok: true,
              ...evidence(),
              nextActions: ["Review the dry-run preview.", "Rerun with dryRun=false only after accepting the ranged edits."]
            },
            startedAt
          );
        }

        applyRequestId = randomUUID();
        unconfirmedApply = { requestId: applyRequestId, outcomeUnknown: true };
        currentSha256 = null;
        applyResult = asObject(
          await context.unity.request(
            "script.apply_edits",
            {
              path: args.scriptPath,
              edits: args.edits,
              expectedSha256: originalSha256,
              dryRun: false
            },
            { requestId: applyRequestId }
          )
        );
        unconfirmedApply = null;
        retainBackup(applyResult);
        recordStep("script_apply_edits", applyResult);
        const applyError = asObject(applyResult.error);
        partialApply =
          applyResult.ok !== true &&
          (retainedBackups.length > 0 ||
            ["incomplete", "unknown"].includes(stringValue(applyError.restorationStatus)) ||
            arrayValue(applyError.recoveryFiles).length > 0 ||
            stringValue(applyError.recoveryDirectory).length > 0);
        currentSha256 = hashFrom(applyResult.afterSha256);
        requireOk(applyResult, "REPAIR_APPLY_FAILED", "The explicit edit was not confirmed.");
        // Existing-script writes retain the original source even for unchanged
        // bytes. Metadata paths may be empty when the producer did not change it.
        if (hashFrom(applyResult.beforeSha256) !== originalSha256 || !currentSha256 || !stringValue(applyResult.backupPath).trim()) {
          partialApply = true;
          throw producerError(
            null,
            "REPAIR_APPLY_RECEIPT_INVALID",
            "The apply receipt must confirm the original and resulting byte hashes and the original-source backup. Preserve its recovery material and reconcile the transaction."
          );
        }
        sourceChanged = true;
        appliedSha256 = currentSha256;
        await compileAndValidate(numberValue(applyResult.requestedCompileGeneration));

        if (args.runTests) {
          const requestId = randomUUID();
          unconfirmedTests = { requestId, operationId: null, outcomeUnknown: true };
          let testStart: Record<string, unknown>;
          try {
            testStart = asObject(await context.unity.request("tests.run", { mode: args.testMode, filter: args.testFilter }, { requestId }));
          } catch (error) {
            // Only the bridge client's typed proof of non-execution makes this
            // start failure safe to roll back. Generic errors remain unsettled.
            if (error instanceof UnityRequestTimeoutError && error.outcomeUnknown === false) {
              unconfirmedTests = null;
              testsFailed = true;
              recordStep("tests_start", { ok: false, requestId, outcomeUnknown: false, error: { code: error.code, message: error.message } });
            }
            throw error;
          }
          recordStep("tests_start", testStart);
          unconfirmedTests.operationId = stringValue(testStart.operationId) || null;
          const tests = unconfirmedTests.operationId ? await pollOperation(context, unconfirmedTests.operationId, 120000, 500) : testStart;
          recordStep("tests_run", tests);
          const state = asObject(tests.state);
          if (!["success", "failed", "cancelled", "timeout", "aborted"].includes(stringValue(state.status))) {
            // pollOperation can return a still-running operation at its deadline.
            // That does not settle Unity's runner or authorize rollback.
            throw producerError(tests.error, "REPAIR_TESTS_UNSETTLED", "Required tests have no terminal receipt; execution remains unsettled.");
          }
          unconfirmedTests = null;
          testsFailed = tests.ok !== true || state.status !== "success" || numberValue(state.failed) > 0 || tests.status === "failed";
          if (testsFailed) throw producerError(tests.error, "REPAIR_TESTS_FAILED", "Required tests did not complete successfully.");
        }

        const finalSha256 = await readHash("repair_hash_verify");
        if (!appliedSha256 || finalSha256 !== appliedSha256) {
          throw producerError(null, "REPAIR_HASH_MISMATCH", "Final source bytes do not match the confirmed edit receipt.");
        }
        repairVerified = true;
        await completeTransactions();
        const failedCleanup = transactionCleanup.find((receipt) => receipt.ok !== true);
        if (failedCleanup) throw producerError(failedCleanup.error, "REPAIR_CLEANUP_FAILED", "Repair was verified, but backup cleanup was not confirmed.");
        return successResponse(
          "repair_apply_edits applied edits and verified the current source and compiler generation.",
          { ok: true, ...evidence() },
          startedAt
        );
      } catch (error) {
        if (sourceChanged && !partialApply && !unconfirmedApply && !unconfirmedTests && !repairVerified && !rollback) rollback = await restoreOriginal();
        if (rollback?.ok === true && !cleanupAttempted) await completeTransactions();
        return failureResponse("repair_apply_edits failed", error, startedAt, [], {
          code: rollback?.ok === false ? "REPAIR_ROLLBACK_FAILED" : undefined,
          requestId:
            unconfirmedApply?.requestId ??
            unconfirmedTests?.requestId ??
            (stringValue(asObject(rollback?.unconfirmedRestore).requestId) || stringValue(asObject(error).requestId) || applyRequestId),
          warnings:
            unconfirmedApply || unconfirmedTests || unconfirmedRestore || partialApply
              ? ["Unity execution or transaction recovery is unsettled. Reconcile the retained evidence before further mutation or cleanup."]
              : undefined,
          data: evidence()
        });
      }
    },
    {
      ...GhostToolResponseSchema,
      data: z
        .object({
          resultContractVersion: z.literal(2).describe("Explicit repair result contract version; independent of the operation catalog version."),
          consoleDiagnosticsChecked: z.literal(false).describe("Historical Console diagnostics are not checked by this compiler-generation repair."),
          consoleErrorCount: z.null().describe("Unchecked, not a count of zero."),
          mode: z.enum(["unknown", "recovery-required", "rolled-back", "restoration-unverified", "applied", "dry-run", "not-applied"]),
          editCount: z.number().int().positive(),
          repairVerified: z.boolean()
        })
        .passthrough()
        .nullable()
    }
  );

  registerTool(
    server,
    "repair_inspect",
    "Inspect one script/compiler/test/visual state and propose source repairs; optional screenshots create bounded evidence artifacts.",
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
    {
      risk: "test-execution",
      mutates: true,
      supportsDryRun: false,
      phase: 3,
      relatedResources: ["unity://console/errors", "unity://tests/{mode}", "unity://semantic/index", "unity://screenshots/baselines"]
    },
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
      let originalCaptured = false;
      let currentSha256: string | null = null;
      let sourceChanged = false;
      let unconfirmedApply: { requestId: string; iteration: number; outcomeUnknown: true } | null = null;
      let repairVerified = false;
      let restorationAttempted = false;
      let restored: Record<string, unknown> | null = null;
      const transactionBackups: Array<{ backupPath: string; backupMetaPath: string }> = [];
      const transactionCleanup: Record<string, unknown>[] = [];
      let cleanupAttempted = false;

      const retainBackup = (receipt: Record<string, unknown>): void => {
        if (stringValue(receipt.backupPath)) {
          transactionBackups.push({ backupPath: stringValue(receipt.backupPath), backupMetaPath: stringValue(receipt.backupMetaPath) });
        }
      };

      const recoveryEvidence = (): Record<string, unknown> => {
        const recoveryPathsUnverified = transactionCleanup.some((cleanup) => cleanup.ok !== true);
        const hints: string[] = [];
        if (transactionBackups.length > 0) {
          hints.push(
            recoveryPathsUnverified
              ? "Preserve the listed recovery backups. After failed cleanup their existence is unverified."
              : "The listed recovery backups are retained; cleanup was not attempted."
          );
        }
        if (unconfirmedApply) {
          hints.push(
            `Apply outcome is unknown for request ${unconfirmedApply.requestId}. Reconcile this request with Unity before any apply, restore, or cleanup; a source read alone cannot rule out a late write. The missing apply receipt may contain additional backup paths.`
          );
        } else if (transactionBackups.length > 0) {
          hints.push(
            "Inspect the current source hash and backup bytes before manual recovery or cleanup; do not blindly replay a mutation whose outcome is unverified."
          );
        }
        return {
          currentSha256,
          unconfirmedApply,
          retainedBackups: [...transactionBackups],
          recoveryPathsUnverified,
          recoveryHint: hints.length > 0 ? hints.join(" ") : null
        };
      };

      const verifyFinalSource = async (): Promise<void> => {
        currentSha256 = null;
        const finalRead = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
        if (finalRead.ok !== true || !stringValue(finalRead.sha256)) {
          throw new Error("Cannot release repair backups without a verified final source hash.");
        }
        currentSha256 = stringValue(finalRead.sha256);
      };

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
        restorationAttempted = true;
        const receipt: Record<string, unknown> = { ok: false, expectedSha256: originalSha256 };
        let write: Record<string, unknown> = {};
        let compile: Record<string, unknown> = {};
        try {
          const current = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
          if (current.ok !== true || !stringValue(current.sha256)) {
            throw new Error("Cannot restore without a verified current source hash.");
          }
          receipt.beforeSha256 = stringValue(current.sha256);
          const originalBackup = transactionBackups[0];
          write = originalBackup?.backupPath
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
          receipt.write = write;
          // The rollback mutation may itself create recovery material, even if
          // its compile generation or subsequent verification is unavailable.
          retainBackup(write);
          const generation = numberValue(write.requestedCompileGeneration);
          if (write.ok !== true) {
            receipt.error = write.error ?? { code: "ROLLBACK_WRITE_FAILED", message: "Rollback write was not confirmed successful." };
          } else if (generation <= 0) {
            receipt.error = { code: "ROLLBACK_GENERATION_MISSING", message: "Rollback write returned no compile generation." };
          } else {
            compile = await waitForUnityCompile(context, generation, args.compileTimeoutMs);
            receipt.compile = compile;
            if (compile.ok !== true) {
              receipt.error = compile.error ?? { code: "ROLLBACK_COMPILE_FAILED", message: "Rollback compilation was not verified." };
            }
          }
        } catch (error) {
          receipt.error = {
            code: stringValue(asObject(error).code) || "ROLLBACK_REQUEST_FAILED",
            message: error instanceof Error ? error.message : String(error)
          };
        }

        // This is evidence collection only: a timed-out restoration must not be
        // retried by the outer catch, and an unreadable hash must stay unknown.
        currentSha256 = null;
        try {
          const readBack = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
          if (readBack.ok !== true || !stringValue(readBack.sha256)) {
            throw new Error("Rollback source hash could not be read back.");
          }
          currentSha256 = stringValue(readBack.sha256);
          receipt.restoredSha256 = currentSha256;
          if (currentSha256 !== originalSha256 && !receipt.error) {
            receipt.error = { code: "ROLLBACK_HASH_MISMATCH", message: "Restored source hash does not match the original." };
          }
        } catch (error) {
          receipt.readBackError = error instanceof Error ? error.message : String(error);
        }
        return {
          ...receipt,
          currentSha256,
          ok: write.ok === true && compile.ok === true && currentSha256 === originalSha256
        };
      };

      const completeTransactions = async (): Promise<Record<string, unknown>[]> => {
        if (cleanupAttempted) {
          return transactionCleanup;
        }
        cleanupAttempted = true;
        while (transactionBackups.length > 0) {
          const backup = transactionBackups[0]!;
          let cleanup: Record<string, unknown>;
          try {
            cleanup = asObject(await context.unity.request("script.transaction_complete", backup));
          } catch (error) {
            cleanup = {
              ok: false,
              outcomeUnknown: true,
              error: {
                code: stringValue(asObject(error).code) || "TRANSACTION_CLEANUP_FAILED",
                message: error instanceof Error ? error.message : String(error)
              }
            };
          }
          transactionCleanup.push({ ...cleanup, ...backup, ok: cleanup.ok === true });
          if (cleanup.ok !== true) {
            // Keep unconfirmed and unattempted paths; a partial deletion or lost
            // response is not authorization to retry cleanup or restore source.
            break;
          }
          transactionBackups.shift();
        }
        return transactionCleanup;
      };

      const finalizeVerifiedRepair = async (successMessage: string) => {
        await verifyFinalSource();
        repairVerified = true;
        const cleanupResults = await completeTransactions();
        const cleanupOk = cleanupResults.every((cleanup) => cleanup.ok === true);
        return successResponse(
          cleanupOk ? successMessage : "repair_loop_run verified the repair, but backup cleanup was incomplete.",
          {
            ok: cleanupOk,
            ...(cleanupOk ? {} : { error: { code: "REPAIR_CLEANUP_FAILED", message: "Repair passed required checks, but backup cleanup was not confirmed." } }),
            repairVerified,
            objective: args.objective,
            scriptPath: args.scriptPath,
            iterations,
            iterationCount: iterations.length,
            originalSha256,
            finalSha256: currentSha256,
            restored: null,
            transactionCleanup: cleanupResults,
            ...recoveryEvidence()
          },
          startedAt
        );
      };

      try {
        const original = asObject(await context.unity.request("script.read", { path: args.scriptPath }));
        originalContent = stringValue(original.content);
        originalSha256 = stringValue(original.sha256);
        originalCaptured = original.ok === true && originalSha256.length > 0 && typeof original.content === "string";
        currentSha256 = originalCaptured ? originalSha256 : null;
        if (!originalCaptured) {
          throw new Error("Cannot begin repair without verified original source content and hash.");
        }

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
              return await finalizeVerifiedRepair("repair_loop_run completed with a verified green result.");
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

          const applyRequestId = randomUUID();
          iterationReceipt.applyRequestId = applyRequestId;
          iterations.push(iterationReceipt);
          // Dispatch invalidates earlier source evidence. Until a receipt arrives,
          // neither an earlier confirmed edit nor a read-back permits rollback.
          currentSha256 = null;
          unconfirmedApply = { requestId: applyRequestId, iteration, outcomeUnknown: true };
          const applied = asObject(
            await context.unity.request(
              "script.apply_edits",
              {
                path: args.scriptPath,
                edits,
                expectedSha256: stringValue(currentScript.sha256),
                dryRun: false
              },
              { requestId: applyRequestId }
            )
          );
          unconfirmedApply = null;
          sourceChanged = true;
          retainBackup(applied);
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

          if (iterationOk) {
            return await finalizeVerifiedRepair("repair_loop_run applied and verified a repair.");
          }
        }

        if (sourceChanged) {
          restored = await restoreOriginal();
        }
        if (!sourceChanged || restored?.ok === true) {
          await completeTransactions();
        }
        return successResponse(
          "repair_loop_run exhausted without a green result.",
          {
            ok: false,
            error: {
              code: restored && restored.ok === false ? "REPAIR_ROLLBACK_FAILED" : "REPAIR_EXHAUSTED",
              message:
                restored && restored.ok === false
                  ? "Repair failed and original-source restoration was incomplete."
                  : "No repair iteration passed all required checks."
            },
            objective: args.objective,
            scriptPath: args.scriptPath,
            iterations,
            iterationCount: iterations.length,
            originalSha256,
            restored,
            transactionCleanup,
            ...recoveryEvidence()
          },
          startedAt,
          { confidence: 0 }
        );
      } catch (error) {
        if (!unconfirmedApply && sourceChanged && originalCaptured && !repairVerified && !restorationAttempted) {
          restored = await restoreOriginal();
        }
        if (!unconfirmedApply && (!sourceChanged || restored?.ok === true || repairVerified)) {
          await completeTransactions();
        }
        return failureResponse("repair_loop_run failed", error, startedAt, [], {
          code: restored && restored.ok === false ? "REPAIR_ROLLBACK_FAILED" : "REPAIR_LOOP_FAILED",
          requestId: unconfirmedApply?.requestId,
          warnings: unconfirmedApply
            ? ["The apply outcome is unknown. Reconcile the recorded request with Unity before any apply, restore, or cleanup."]
            : undefined,
          data: { objective: args.objective, scriptPath: args.scriptPath, iterations, originalSha256, restored, transactionCleanup, ...recoveryEvidence() }
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
    { risk: "destructive", mutates: true, supportsDryRun: true, phase: 2, destructive: true },
    (args) => `gameobject.${args.action}`,
    (args) => args.params
  );

  registerUnityRequestTool(
    server,
    context,
    "batch_execute",
    "Preflight and execute multiple Unity bridge commands as one fail-fast transaction, with explicit maximum-risk acceptance and reverse rollback receipts.",
    {
      operations: z
        .array(
          z.object({
            method: z.string().min(1),
            params: z.record(z.string(), z.unknown()).default({}),
            required: z.boolean().default(true)
          })
        )
        .min(1)
        .max(100),
      failFast: z.boolean().default(true),
      acceptedRisk: z.enum(["read-only", "safe-write", "asset-write", "code-write", "destructive", "external", "arbitrary-code"]).optional(),
      acceptNonRollbackable: z.boolean().default(false),
      dryRun: DryRunSchema
    },
    { risk: "external", mutates: true, supportsDryRun: true, phase: 3, destructive: true, openWorld: true },
    "batch.execute"
  );

  registerTool(
    server,
    "capabilities_search",
    "Search the versioned Ghost operation catalog with bounded pagination and field projection. This discovers disabled profiles but never bypasses their registration or risk gates.",
    {
      query: z.string().max(200).default(""),
      profiles: z
        .array(z.enum(["core", "authoring", "code", "runtime", "validation", "all"]))
        .max(6)
        .default(["all"]),
      risk: z
        .enum(["read", "safe-write", "asset-write", "code-write", "destructive", "external", "arbitrary-code", "build-system", "test-execution"])
        .optional(),
      mutates: z.boolean().optional(),
      limit: z.number().int().positive().max(100).default(25),
      cursor: z.string().max(100).optional(),
      fields: z
        .array(
          z.enum([
            "description",
            "version",
            "inputSchema",
            "outputSchema",
            "examples",
            "risk",
            "mutates",
            "supportsDryRun",
            "phase",
            "relatedResources",
            "destructive",
            "idempotent",
            "openWorld",
            "permissionClass",
            "mainThread",
            "undoable",
            "expectedDurationMs",
            "bridgeOperations"
          ])
        )
        .max(20)
        .default(["description", "risk", "mutates", "supportsDryRun", "examples"])
    },
    {
      risk: "read",
      mutates: false,
      supportsDryRun: false,
      phase: 7,
      relatedResources: ["unity://capabilities"],
      examples: [{ query: "compile", profiles: ["validation"], limit: 10, fields: ["description", "inputSchema", "risk", "examples"] }]
    },
    async (args) => {
      const startedAt = Date.now();
      try {
        const data = searchOperationCatalog(server, args);
        return successResponse(`Found ${data.totalMatched} matching Ghost operations.`, data, startedAt, { projectId: context.projectId });
      } catch (error) {
        return failureResponse("Operation catalog search failed", error, startedAt, [], { projectId: context.projectId });
      }
    }
  );

  registerCoreResources(server, context);
  server.registerResource(
    "scenario-evidence",
    new ResourceTemplate("unity://evidence/{operationId}/{file}", { list: undefined }),
    {
      title: "Scenario evidence",
      description: "Read a deterministic scenario manifest, result, compiler log, Console log, or Markdown summary.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const evidence = await scenarios.readEvidence(variableString(variables.operationId), variableString(variables.file));
      return { contents: [{ uri: uri.toString(), mimeType: evidence.mimeType, text: evidence.text ?? "" }] };
    }
  );
  server.registerResource(
    "scenario-screenshot-evidence",
    new ResourceTemplate("unity://evidence/{operationId}/screenshots/{file}", { list: undefined }),
    { title: "Scenario screenshot evidence", description: "Read a PNG captured by a scenario case.", mimeType: "image/png" },
    async (uri, variables) => {
      const evidence = await scenarios.readArtifact(variableString(variables.operationId), "screenshots", variableString(variables.file));
      return { contents: [{ uri: uri.toString(), mimeType: evidence.mimeType, blob: evidence.blob?.toString("base64") ?? "" }] };
    }
  );
  server.registerResource(
    "scenario-source-diff-evidence",
    new ResourceTemplate("unity://evidence/{operationId}/diffs/{file}", { list: undefined }),
    { title: "Scenario source diff evidence", description: "Read a redacted unified source diff captured by a scenario case.", mimeType: "text/x-diff" },
    async (uri, variables) => {
      const evidence = await scenarios.readArtifact(variableString(variables.operationId), "diffs", variableString(variables.file));
      return { contents: [{ uri: uri.toString(), mimeType: evidence.mimeType, text: evidence.text ?? "" }] };
    }
  );
  registerCorePrompts(server);

  return server;
}

function isScenarioOperationId(operationId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId);
}

function variableString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
