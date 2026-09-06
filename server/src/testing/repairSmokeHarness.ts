import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface SmokeStep {
  name: string;
  ok: boolean;
  summary?: unknown;
  assertions?: unknown;
  error?: string;
}

export interface RepairSmokeOptions {
  projectPath?: string;
  projectId?: string;
  editorInstanceId?: string;
  /** Deterministic collision testing; the CLI always uses a new random UUID. */
  runId?: string;
}

export async function restoreSmokeEditor(
  steps: SmokeStep[],
  restore: () => Promise<Record<string, unknown> | undefined>,
  originalSnapshot?: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const recovery = steps.find((step) => !step.ok && (step.name === "retain scratch recovery" || hasUnsettledEvidence(step.summary)));
  if (recovery) {
    throw Object.assign(
      new Error(
        "Editor restoration skipped because a smoke operation remains unresolved; preserve the original snapshot and reconcile before further mutation."
      ),
      {
        code: "SMOKE_EDITOR_RESTORATION_DEFERRED",
        originalSnapshot,
        recovery: recovery.summary,
        restored: false
      }
    );
  }
  return restore();
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(asRecord) : []);
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

// Inspect structured evidence only. In particular, a timeout of the compiler
// wait does not mean that the import initiated by validation has stopped.
function hasUnsettledEvidence(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const detail = asRecord(value);
  if (detail.outcomeUnknown === true || detail.executionUnsettled === true) return true;
  if (["COMPILE_GENERATION_TIMEOUT", "MISSING_COMPILE_GENERATION", "UNKNOWN_COMPILE_GENERATION", "COMPILE_GENERATION_MISMATCH"].includes(String(detail.code)))
    return true;
  if (
    detail.outcomeUnknown !== false &&
    ["EXECUTING", "OUTCOME_UNKNOWN", "REQUEST_EXECUTION_IN_PROGRESS", "UNITY_REQUEST_TIMEOUT_OUTCOME_UNKNOWN", "UNITY_REQUEST_FAILED"].includes(
      String(detail.code)
    )
  )
    return true;
  return Object.values(value).some((child) => hasUnsettledEvidence(child, seen));
}

function requireEvidence(ok: unknown, code: string, message: string): asserts ok {
  if (!ok) throw Object.assign(new Error(message), { code });
}

export function smokeErrorEvidence(error: unknown): Record<string, unknown> {
  const detail = asRecord(error);
  return {
    ...detail,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof SmokeToolError ? { response: error.response } : {})
  };
}

class SmokeToolError extends Error {
  readonly code: unknown;
  readonly requestId: unknown;
  readonly operationId: unknown;
  readonly outcomeUnknown: unknown;
  readonly executionUnsettled: boolean;
  constructor(
    readonly tool: string,
    readonly response: Record<string, unknown>
  ) {
    const error = asRecord(response.error);
    super(`${tool} failed: ${String(error.message ?? JSON.stringify(response))}`);
    this.code = error.code;
    this.requestId = response.requestId;
    this.operationId = response.operationId;
    this.outcomeUnknown = asRecord(response.data).outcomeUnknown ?? asRecord(error.data).outcomeUnknown;
    // Failed MCP validation responses bypass assertSmokeValidation. A generic
    // "failed" status may mean the requested generation was never observed.
    const data = asRecord(response.data);
    const generation = Number(data.requestedCompileGeneration);
    this.executionUnsettled =
      tool === "script_validate" && !(compileEvidence(asRecord(data.compile), generation) || compileEvidence(asRecord(data.compile), generation, "failed"));
  }
}

// Deliberately one send for every operation, including reads which may start an
// import or capture. Text such as "fetch failed" cannot prove non-execution.
async function toolEnvelope(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestId = typeof args.requestId === "string" ? args.requestId : randomUUID();
  try {
    const result = await client.callTool({ name, arguments: { ...args, requestId } });
    requireEvidence(
      result.structuredContent && typeof result.structuredContent === "object",
      "SMOKE_RECEIPT_MISSING",
      `Tool '${name}' returned no structured content.`
    );
    return { ...result.structuredContent, isError: result.isError === true };
  } catch (error) {
    // Retain the generated correlation ID if transport failure has no producer ID.
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
      ...smokeErrorEvidence(error),
      requestId: asRecord(error).requestId ?? requestId,
      outcomeUnknown: asRecord(error).outcomeUnknown ?? true
    });
  }
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await toolEnvelope(client, name, args);
  if (result.isError || result.ok !== true || asRecord(result.data).ok === false) throw new SmokeToolError(name, result);
  return result;
}

export function compileEvidence(compile: Record<string, unknown>, generation: number, status = "success"): boolean {
  return (
    Number.isInteger(generation) &&
    generation > 0 &&
    compile.generation === generation &&
    compile.requestedCompileGeneration === generation &&
    compile.status === status &&
    compile.observed === true &&
    typeof compile.observedAtUtc === "string" &&
    compile.observedAtUtc.length > 0 &&
    typeof compile.completedAtUtc === "string" &&
    compile.completedAtUtc.length > 0 &&
    compile.ok === (status === "success")
  );
}

export function assertSmokeValidation(result: Record<string, unknown>, requestedGeneration?: number): void {
  const data = asRecord(result.data);
  const generation = requestedGeneration ?? Number(data.requestedCompileGeneration);
  const settled = compileEvidence(asRecord(data.compile), generation) || compileEvidence(asRecord(data.compile), generation, "failed");
  if (!(
    result.ok === true &&
    result.isError !== true &&
    data.ok === true &&
    data.requestedCompileGeneration === generation &&
    compileEvidence(asRecord(data.compile), generation) &&
    Array.isArray(data.diagnostics) &&
    data.diagnostics.length === 0
  )) {
    throw Object.assign(new Error("Validation must confirm the exact observed and completed compile generation without errors."), {
      code: "SMOKE_BASELINE_INVALID",
      response: result,
      executionUnsettled: !settled
    });
  }
}

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (asRecord(error).code === "ENOENT") return true;
    throw error;
  }
}

async function regularBytes(path: string): Promise<Buffer> {
  const info = await lstat(path);
  requireEvidence(info.isFile() && !info.isSymbolicLink(), "SMOKE_PATH_UNSAFE", `Expected a regular owned file: ${path}`);
  return readFile(path);
}

export async function runMutationRollbackSmoke(client: Client, steps: SmokeStep[], timeoutMs: number, options: RepairSmokeOptions = {}): Promise<void> {
  const runId = options.runId ?? randomUUID().replaceAll("-", "");
  const scriptPath = `Assets/GhostRepairScratch_${runId}.cs`;
  const className = `GhostRepairScratch_${runId}`;
  const content = `using UnityEngine;\n\npublic class ${className} : MonoBehaviour\n{\n    private int health = 1;\n\n    public int Health => health;\n}\n`;
  const originalSha256 = hash(content);
  const recovery: Record<string, unknown> = { runId, scriptPath, expectedSha256: originalSha256, originalContent: content, receipts: [] };
  const receipts = recovery.receipts as Record<string, unknown>[];
  let fullPath = "";
  let metadata: Buffer | undefined;
  let cleanupAllowed = false;
  let attemptedCreation = false;
  let deleted = false;
  let stage = "preflight scratch ownership and cleanup capability";

  const checkSource = async (): Promise<void> => {
    const source = await callTool(client, "script_read", { path: scriptPath });
    const data = asRecord(source.data);
    const disk = await regularBytes(fullPath);
    requireEvidence(
      data.path === scriptPath &&
        data.content === content &&
        data.sha256 === originalSha256 &&
        hash(disk) === originalSha256 &&
        disk.equals(Buffer.from(content)),
      "SMOKE_SOURCE_MISMATCH",
      "Independent source bytes and producer read-back must match the owned original."
    );
    if (metadata)
      requireEvidence(
        (await regularBytes(`${fullPath}.meta`)).equals(metadata),
        "SMOKE_METADATA_CHANGED",
        "Scratch metadata changed; preserve the external write."
      );
  };

  try {
    requireEvidence(/^[A-Za-z0-9_]{1,64}$/.test(runId), "SMOKE_RUN_ID_INVALID", "Scratch run ID must be a safe C# identifier suffix.");
    requireEvidence(options.projectPath, "SMOKE_PROJECT_PATH_REQUIRED", "Scratch mutation requires --unity-project-path for independent byte verification.");
    const root = await realpath(resolve(options.projectPath));
    const assets = join(root, "Assets");
    const assetsInfo = await lstat(assets);
    requireEvidence(
      assetsInfo.isDirectory() && !assetsInfo.isSymbolicLink() && (await realpath(assets)) === assets,
      "SMOKE_PATH_UNSAFE",
      "Assets must be a real directory inside the selected project."
    );
    fullPath = join(root, scriptPath);
    requireEvidence(
      (await absent(fullPath)) && (await absent(`${fullPath}.meta`)),
      "SMOKE_PATH_EXISTS",
      "Scratch source or metadata already exists; refusing to overwrite it."
    );
    const identity = asRecord(JSON.parse(await readFile(join(root, "Library/UnityMcpGhost/bridge-identity.json"), "utf8")));
    requireEvidence(
      identity.running === true &&
        typeof identity.projectRoot === "string" &&
        (await realpath(identity.projectRoot)) === root &&
        (!options.projectId || identity.projectId === options.projectId) &&
        (!options.editorInstanceId || identity.editorInstanceId === options.editorInstanceId),
      "SMOKE_IDENTITY_MISMATCH",
      "Scratch disk verification requires the matching running project/editor identity."
    );
    // Identity locates the editor; its startup capability snapshot may be stale.
    // The authenticated health request observes the same active settings used by
    // bridge authorization. Later revocation is still handled as failed cleanup.
    const health = await callTool(client, "health", {});
    receipts.push(health);
    const live = asRecord(health.data);
    requireEvidence(
      live.ok === true &&
        live.authenticated === true &&
        typeof identity.projectId === "string" &&
        identity.projectId.length > 0 &&
        live.projectId === identity.projectId &&
        typeof identity.editorInstanceId === "string" &&
        identity.editorInstanceId.length > 0 &&
        live.editorInstanceId === identity.editorInstanceId &&
        typeof live.projectPath === "string" &&
        (await realpath(live.projectPath)) === root,
      "SMOKE_IDENTITY_MISMATCH",
      "Live health must confirm the authenticated project/editor bound to the scratch path."
    );
    requireEvidence(
      asRecord(live.capabilities).destructive === true,
      "SMOKE_DESTRUCTIVE_DISABLED",
      "Scratch cleanup requires an explicit destructive capability grant before creation."
    );
    steps.push({ name: stage, ok: true, summary: { runId, scriptPath } });

    stage = "create scratch script";
    attemptedCreation = true;
    const creation = await callTool(client, "script_create", { path: scriptPath, content, overwrite: false, dryRun: false });
    receipts.push(creation);
    const created = asRecord(creation.data);
    requireEvidence(
      created.ok === true &&
        created.created === true &&
        created.path === scriptPath &&
        created.dryRun === false &&
        created.beforeSha256 === hash(Buffer.alloc(0)) &&
        created.afterSha256 === originalSha256 &&
        Number.isInteger(created.requestedCompileGeneration) &&
        Number(created.requestedCompileGeneration) > 0,
      "SMOKE_CREATE_UNVERIFIED",
      "Creation must prove a new script, its exact path, bytes, and requested compile generation."
    );
    metadata = await regularBytes(`${fullPath}.meta`);
    recovery.originalMetaBase64 = metadata.toString("base64");
    await checkSource();
    steps.push({ name: stage, ok: true, summary: creation });

    stage = "validate scratch script";
    const generation = Number(created.requestedCompileGeneration);
    const validation = await toolEnvelope(client, "script_validate", { path: scriptPath, requestedCompileGeneration: generation, timeoutMs });
    receipts.push(validation);
    const compile = asRecord(asRecord(validation.data).compile);
    // A known terminal compiler failure still permits cleanup of unchanged owned
    // bytes. A timeout, stale idle record, or lost response cannot settle import.
    cleanupAllowed = compileEvidence(compile, generation) || compileEvidence(compile, generation, "failed");
    assertSmokeValidation(validation, generation);
    steps.push({ name: stage, ok: true, summary: validation });
    await checkSource();

    stage = "apply invalid edit and roll back";
    cleanupAllowed = false;
    const column = content.split("\n")[4].indexOf("1;");
    const repair = await toolEnvelope(client, "repair_apply_edits", {
      objective: "Verify expected compiler failure and byte-identical rollback on an owned scratch script.",
      scriptPath,
      edits: [{ startLine: 4, startColumn: column, endLine: 4, endColumn: column + 1, text: "" }],
      dryRun: false,
      rollbackOnFailure: true,
      compileTimeoutMs: timeoutMs
    });
    receipts.push(repair);
    const data = asRecord(repair.data);
    const rollback = asRecord(data.rollback);
    const apply = asRecord(data.applyResult);
    const failureCompile = asRecord(records(data.steps).find((step) => step.name === "compile_wait")?.data);
    const restoreCompile = asRecord(records(data.steps).find((step) => step.name === "rollback_compile_wait")?.data);
    const compilerFailure = records(failureCompile.diagnostics).some(
      (d) =>
        d.severity === "error" &&
        d.generation === apply.requestedCompileGeneration &&
        typeof d.file === "string" &&
        d.file.replaceAll("\\", "/").endsWith(scriptPath) &&
        (d.code === "CS1525" || /\bCS1525\b/.test(String(d.message)))
    );
    requireEvidence(
      repair.isError === true &&
        repair.ok === false &&
        asRecord(repair.error).code === "COMPILE_GENERATION_FAILED" &&
        compileEvidence(failureCompile, Number(apply.requestedCompileGeneration), "failed") &&
        compilerFailure,
      "SMOKE_EXPECTED_FAILURE_MISSING",
      "Repair must explicitly fail with the expected current-generation CS1525 compiler diagnostic."
    );
    requireEvidence(
      data.resultContractVersion === 2 &&
        data.mode === "rolled-back" &&
        data.scriptPath === scriptPath &&
        data.originalSha256 === originalSha256 &&
        data.currentSha256 === originalSha256 &&
        data.repairVerified === false &&
        apply.ok === true &&
        apply.path === scriptPath &&
        apply.beforeSha256 === originalSha256 &&
        rollback.ok === true &&
        rollback.byteIdentical === true &&
        rollback.restoredSha256 === originalSha256 &&
        compileEvidence(restoreCompile, Number(asRecord(rollback.writeBack).requestedCompileGeneration)) &&
        !data.unconfirmedApply &&
        !data.unconfirmedTests &&
        !data.unconfirmedRestore &&
        !rollback.unconfirmedRestore &&
        data.recoveryPathsUnverified === false &&
        Array.isArray(data.retainedBackups) &&
        data.retainedBackups.length === 0 &&
        Array.isArray(data.transactionCleanup) &&
        data.transactionCleanup.length > 0 &&
        records(data.transactionCleanup).every((receipt) => receipt.ok === true && !receipt.outcomeUnknown),
      "SMOKE_ROLLBACK_UNVERIFIED",
      "Rollback, execution settlement, and transaction cleanup must all be verified; preserve recovery otherwise."
    );
    await checkSource();
    cleanupAllowed = true;
    steps.push({ name: stage, ok: true, summary: repair });
    steps.push({ name: "verify scratch rollback content", ok: true, summary: { sha256: originalSha256, byteIdentical: true, metadataIdentical: true } });
  } catch (error) {
    steps.push({ name: stage, ok: false, error: error instanceof Error ? error.message : String(error), summary: { ...smokeErrorEvidence(error), recovery } });
  } finally {
    if (cleanupAllowed) {
      try {
        await checkSource();
        stage = "delete scratch script";
        const deletion = await callTool(client, "script_delete", { path: scriptPath, expectedSha256: originalSha256, dryRun: false });
        receipts.push(deletion);
        const data = asRecord(deletion.data);
        requireEvidence(
          data.ok === true &&
            data.deleted === true &&
            data.path === scriptPath &&
            data.beforeSha256 === originalSha256 &&
            (await absent(fullPath)) &&
            (await absent(`${fullPath}.meta`)),
          "SMOKE_DELETE_UNVERIFIED",
          "Deletion must confirm the owned bytes and independent source/metadata absence."
        );
        steps.push({ name: stage, ok: true, summary: deletion });
        stage = "compile after scratch cleanup";
        const generation = Number(data.requestedCompileGeneration);
        requireEvidence(Number.isInteger(generation) && generation > 0, "SMOKE_COMPILE_GENERATION_MISSING", "Deletion returned no compile generation.");
        const compile = await callTool(client, "compile_wait", { requestedCompileGeneration: generation, timeoutMs });
        receipts.push(compile);
        requireEvidence(
          compileEvidence(asRecord(compile.data), generation),
          "SMOKE_CLEANUP_COMPILE_UNVERIFIED",
          "Cleanup requires the exact observed and completed compile generation."
        );
        deleted = true;
        steps.push({ name: stage, ok: true, summary: compile });
      } catch (error) {
        steps.push({
          name: stage,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          summary: { ...smokeErrorEvidence(error), recovery }
        });
      }
    }
    if (attemptedCreation && !deleted)
      steps.push({
        name: "retain scratch recovery",
        ok: false,
        summary: {
          recovery,
          cleanupVerified: false,
          hint: "Reconcile the retained request/operation receipts and current source/meta bytes before any further mutation. No automatic retry or folder deletion was attempted."
        }
      });
  }
}
