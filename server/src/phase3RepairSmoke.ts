#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readConfig } from "./config.js";

interface SmokeStep {
  name: string;
  ok: boolean;
  summary?: unknown;
  assertions?: unknown;
  error?: string;
}

const DefaultFixtureScript = "Assets/GAM215Fixture/StudentExercise.cs";
const ScratchScriptPath = "Assets/UnityMcpGhostScratch/GhostRepairScratch.cs";
const ScratchFolderPath = "Assets/UnityMcpGhostScratch";
const ScratchContent = `using UnityEngine;

public class GhostRepairScratch : MonoBehaviour
{
    private int health = 1;

    public int Health => health;
}
`;

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const config = readConfig(rawArgs);
  const flags = readFlags(rawArgs);
  const client = new Client({ name: "unity-mcp-ghost-phase3-repair-smoke", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [
      "dist/index.js",
      "--transport",
      "stdio",
      "--tool-profile",
      "all",
      "--unity-host",
      config.unityHost,
      "--unity-port",
      String(config.unityPort),
      "--unity-websocket-port",
      String(config.unityWebSocketPort),
      "--unity-project-id",
      config.unityProjectId,
      "--unity-editor-id",
      config.unityEditorInstanceId,
      "--unity-token-file",
      config.unityTokenFile,
      "--request-timeout-ms",
      String(config.requestTimeoutMs),
      ...(config.unityQueueDir ? ["--unity-queue-dir", config.unityQueueDir] : [])
    ]
  });

  const steps: SmokeStep[] = [];
  let failed = false;

  try {
    await client.connect(transport);
    await record(steps, "target script validation", () =>
      callTool(client, "script_validate", {
        path: flags.scriptPath,
        timeoutMs: config.requestTimeoutMs
      })
    );
    await record(
      steps,
      "repair loop semantic test scope",
      () =>
        callTool(client, "repair_inspect", {
          objective: "Verify repair inspection selects a declared test scope for the target gameplay script.",
          scriptPath: flags.scriptPath,
          useSemanticTestScope: true,
          runTests: false,
          captureScreenshot: true,
          screenshotBaselineFilter: flags.screenshotBaselineFilter,
          screenshotWidth: 640,
          screenshotHeight: 360,
          screenshotWaitMs: 5000,
          compileTimeoutMs: config.requestTimeoutMs
        }),
      (result) => assertRepairLoop(result, flags.screenshotBaselineFilter.length > 0)
    );
    await record(
      steps,
      "visual validation report",
      () =>
        callTool(client, "visual_validation_report", {
          currentFilter: "repair-loop",
          baselineFilter: flags.screenshotBaselineFilter,
          cleanupKeepNewest: 3,
          includeCleanup: true
        }),
      (result) => assertVisualValidationReport(result, flags.screenshotBaselineFilter.length > 0)
    );
    await record(
      steps,
      "repair apply dry-run against target script",
      () =>
        callTool(client, "repair_apply_edits", {
          objective: "Preview a no-op ranged repair edit without mutating gameplay code.",
          scriptPath: flags.scriptPath,
          edits: [{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, text: "" }],
          dryRun: true
        }),
      assertRepairApplyDryRun
    );

    if (flags.allowMutation) {
      await runMutationRollbackSmoke(client, steps, config.requestTimeoutMs);
    }
  } catch (error) {
    failed = true;
    steps.push({ name: "phase3 repair smoke", ok: false, error: message(error) });
  } finally {
    await client.close().catch(() => undefined);
  }

  if (steps.some((step) => !step.ok)) {
    failed = true;
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: !failed,
        mode: flags.allowMutation ? "scratch-mutation-rollback" : "dry-run",
        targetScript: flags.scriptPath,
        steps
      },
      null,
      2
    )}\n`
  );

  if (failed) {
    process.exitCode = 1;
  }
}

async function runMutationRollbackSmoke(client: Client, steps: SmokeStep[], timeoutMs: number): Promise<void> {
  let folderCreated = false;
  let scriptCreated = false;

  try {
    folderCreated = await record(steps, "create scratch folder", () =>
      callTool(client, "asset_create_folder", {
        parentPath: "Assets",
        folderName: "UnityMcpGhostScratch",
        dryRun: false
      })
    );
    if (!folderCreated) {
      return;
    }

    scriptCreated = await record(steps, "create scratch script", () =>
      callTool(client, "script_create", {
        path: ScratchScriptPath,
        content: ScratchContent,
        overwrite: true,
        dryRun: false
      })
    );
    if (!scriptCreated) {
      return;
    }

    await record(steps, "validate scratch script", () =>
      callTool(client, "script_validate", {
        path: ScratchScriptPath,
        timeoutMs
      })
    );
    const repairRan = await record(steps, "apply invalid edit and roll back", () =>
      callTool(client, "repair_apply_edits", {
        objective: "Verify non-dry-run repair rollback on a controlled scratch C# script.",
        scriptPath: ScratchScriptPath,
        edits: [{ startLine: 4, startColumn: 26, endLine: 4, endColumn: 27, text: "" }],
        dryRun: false,
        rollbackOnFailure: true,
        compileTimeoutMs: timeoutMs
      })
    );

    if (repairRan) {
      const readBack = await callTool(client, "script_read", { path: ScratchScriptPath });
      const readBackData = readBack.data && typeof readBack.data === "object" ? (readBack.data as Record<string, unknown>) : {};
      const readBackContent = typeof readBackData.content === "string" ? readBackData.content : "";
      steps.push({
        name: "verify scratch rollback content",
        ok: readBackContent === ScratchContent,
        summary: { matchesOriginal: readBackContent === ScratchContent }
      });
    }
  } finally {
    let cleanupGeneration = 0;
    if (scriptCreated) {
      try {
        const result = await callTool(client, "script_delete", {
          path: ScratchScriptPath,
          dryRun: false
        });
        const ok = result.ok !== false;
        cleanupGeneration = Number(asRecord(result.data).requestedCompileGeneration ?? 0);
        steps.push({ name: "delete scratch script", ok, summary: summarize(result) });
      } catch (error) {
        steps.push({ name: "delete scratch script", ok: false, error: message(error) });
      }
    }

    if (folderCreated) {
      await record(steps, "delete scratch folder", () =>
        callTool(client, "asset_delete", {
          path: ScratchFolderPath,
          moveToTrash: false,
          dryRun: false
        })
      );
    }

    if (cleanupGeneration > 0) {
      await record(
        steps,
        "compile after scratch cleanup",
        () => callTool(client, "compile_wait", { requestedCompileGeneration: cleanupGeneration, timeoutMs }),
        assertCompileWait
      );
    }
  }
}

async function record(
  steps: SmokeStep[],
  name: string,
  run: () => Promise<Record<string, unknown>>,
  assert?: (result: Record<string, unknown>) => AssertionResult
): Promise<boolean> {
  try {
    const result = await run();
    const assertion = assert?.(result);
    const ok = result.ok !== false && assertion?.ok !== false;
    steps.push({ name, ok, summary: summarize(result), assertions: assertion });
    return ok;
  } catch (error) {
    steps.push({ name, ok: false, error: message(error) });
    return false;
  }
}

interface AssertionResult {
  ok: boolean;
  checks: Record<string, boolean>;
  details?: Record<string, unknown>;
}

function assertCompileWait(result: Record<string, unknown>): AssertionResult {
  const data = asRecord(result.data);
  return assertion(
    {
      toolOk: result.ok !== false,
      compileSettled: data.status === "success" || data.ok === true,
      notCompiling: asRecord(data.state).isCompiling !== true
    },
    {
      status: data.status,
      elapsedMs: data.elapsedMs
    }
  );
}

function assertRepairLoop(result: Record<string, unknown>, baselineRequired: boolean): AssertionResult {
  const data = asRecord(result.data);
  const plannedTestScope = asRecord(data.plannedTestScope);
  const screenshotValidation = asRecord(data.screenshotValidation);
  const capture = asRecord(screenshotValidation.capture);
  const selectedBaseline = asRecord(screenshotValidation.selectedBaseline);
  const diff = asRecord(screenshotValidation.diff);
  return assertion(
    {
      toolOk: result.ok !== false,
      diagnosticPassMode: data.mode === "diagnostic-pass",
      testScopeDeclared:
        (plannedTestScope.mode === "editmode" || plannedTestScope.mode === "playmode") &&
        (plannedTestScope.source === "semantic-test-scope" || plannedTestScope.source === "caller-default"),
      screenshotCaptured: typeof capture.path === "string" && capture.path.length > 0,
      baselineHandled: baselineRequired ? typeof selectedBaseline.path === "string" && selectedBaseline.path.length > 0 : true,
      visualDiffHandled: baselineRequired ? diff.withinThreshold === true : !selectedBaseline.path || typeof diff.differentRatio === "number"
    },
    {
      plannedTestScope,
      screenshotPath: capture.path,
      baselinePath: selectedBaseline.path,
      differentRatio: diff.differentRatio
    }
  );
}

function assertVisualValidationReport(result: Record<string, unknown>, baselineRequired: boolean): AssertionResult {
  const data = asRecord(result.data);
  const currentCapture = asRecord(data.currentCapture);
  const selectedBaseline = asRecord(data.selectedBaseline);
  const diff = asRecord(data.diff);
  return assertion(
    {
      toolOk: result.ok !== false,
      currentCaptureFound: typeof currentCapture.path === "string" && currentCapture.path.length > 0,
      baselineHandled: baselineRequired ? typeof selectedBaseline.path === "string" && selectedBaseline.path.length > 0 : true,
      visualDiffHandled: baselineRequired ? diff.withinThreshold === true : !selectedBaseline.path || typeof diff.differentRatio === "number",
      recommendationsPresent: Array.isArray(data.recommendations)
    },
    {
      current: currentCapture.fileName,
      baseline: selectedBaseline.fileName,
      differentRatio: diff.differentRatio
    }
  );
}

function assertRepairApplyDryRun(result: Record<string, unknown>): AssertionResult {
  const data = asRecord(result.data);
  return assertion(
    {
      toolOk: result.ok !== false,
      dryRunMode: data.mode === "dry-run",
      hasEditPreview: Number(data.editCount ?? 0) >= 1
    },
    {
      mode: data.mode,
      editCount: data.editCount
    }
  );
}

function assertion(checks: Record<string, boolean>, details?: Record<string, unknown>): AssertionResult {
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    details
  };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return await callToolOnce(client, name, args);
    } catch (error) {
      lastError = error;
      if (!isTransientUnityBridgeError(error) || attempt === 8) {
        throw error;
      }

      await delay(1500);
    }
  }

  throw lastError;
}

async function callToolOnce(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.structuredContent as { ok?: boolean; data?: unknown; diagnostics?: unknown[] } | undefined;
  if (!content) {
    throw new Error(`Tool '${name}' returned no structured content.`);
  }

  if (result.isError || content.ok === false) {
    throw new Error(`${name} failed: ${JSON.stringify(content.diagnostics ?? content)}`);
  }

  return {
    ok: content.ok,
    data: content.data
  };
}

function isTransientUnityBridgeError(error: unknown): boolean {
  const text = message(error);
  return (
    text.includes("ECONNREFUSED") ||
    text.includes("fetch failed") ||
    text.includes("socket hang up") ||
    text.includes("other side closed") ||
    text.includes("Unity HTTP bridge responded 503")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarize(result: Record<string, unknown>): unknown {
  const data = result.data;
  if (!data || typeof data !== "object") {
    return result;
  }

  const record = data as Record<string, unknown>;
  return {
    ok: result.ok,
    mode: record.mode,
    scriptPath: record.scriptPath ?? record.path,
    editCount: record.editCount,
    scopedErrorCount: record.scopedErrorCount,
    testsFailed: record.testsFailed,
    plannedTestScope: record.plannedTestScope,
    screenshotCaptured: Boolean(asRecord(record.screenshotValidation).capture),
    selectedBaseline: asRecord(record.screenshotValidation).selectedBaseline,
    screenshotDiff: asRecord(record.screenshotValidation).diff,
    screenshotPath: asRecord(asRecord(record.screenshotValidation).capture).path,
    stepCount: Array.isArray(record.steps) ? record.steps.length : undefined
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readFlags(args: string[]): { allowMutation: boolean; scriptPath: string; screenshotBaselineFilter: string } {
  let scriptPath = DefaultFixtureScript;
  let allowMutation = false;
  let screenshotBaselineFilter = "";

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--allow-mutation") {
      allowMutation = true;
    }

    if (args[index] === "--script-path" && args[index + 1]) {
      scriptPath = args[index + 1];
    }

    if (args[index] === "--screenshot-baseline-filter" && args[index + 1]) {
      screenshotBaselineFilter = args[index + 1];
    }
  }

  return { allowMutation, scriptPath, screenshotBaselineFilter };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  process.stderr.write(`${message(error)}\n`);
  process.exitCode = 1;
});
