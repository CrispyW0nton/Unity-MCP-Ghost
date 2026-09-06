#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readConfig } from "./config.js";
import { UnityClient, type UnityRequestOptions } from "./unity/UnityClient.js";
import { pathToFileURL } from "node:url";
import { DefaultFixtureScript, repairSmokeScene, RepairSmokeState } from "./testing/repairSmokeState.js";

import {
  callTool,
  runMutationRollbackSmoke,
  assertSmokeValidation,
  smokeErrorEvidence,
  restoreSmokeEditor,
  type SmokeStep
} from "./testing/repairSmokeHarness.js";
export { callTool, runMutationRollbackSmoke, type SmokeStep } from "./testing/repairSmokeHarness.js";

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
  const unity = new UnityClient({
    host: config.unityHost,
    port: config.unityPort,
    webSocketPort: config.unityWebSocketPort,
    queueDir: config.unityQueueDir,
    requestTimeoutMs: config.requestTimeoutMs,
    projectId: config.unityProjectId,
    editorInstanceId: config.unityEditorInstanceId,
    tokenFile: config.unityTokenFile
  });
  let originalEditorSnapshot: Record<string, unknown> | undefined;
  const snapshotObserver: Pick<UnityClient, "request"> = {
    async request<T>(method: string, params: unknown = {}, options: UnityRequestOptions = {}): Promise<T> {
      const result = await unity.request<T>(method, params, options);
      if (method === "editor.snapshot" && !originalEditorSnapshot) originalEditorSnapshot = asRecord(structuredClone(result));
      return result;
    }
  };
  const editorState = new RepairSmokeState(snapshotObserver, Math.max(config.requestTimeoutMs, 30000));

  try {
    await client.connect(transport);
    await editorState.prepare(
      flags.scenePath
        ? async () => {
            const result = await callTool(client, "scene_open", { path: flags.scenePath, mode: "single", dryRun: false });
            steps.push({ name: "open repair fixture scene", ok: true, summary: summarize(result) });
          }
        : undefined
    );
    await record(
      steps,
      "target script validation",
      () =>
        callTool(client, "script_validate", {
          path: flags.scriptPath,
          timeoutMs: config.requestTimeoutMs
        }),
      (result) => {
        assertSmokeValidation(result);
        return assertion({ compileVerified: true });
      }
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
      await runMutationRollbackSmoke(client, steps, config.requestTimeoutMs, {
        projectPath: config.unityProjectPath,
        projectId: config.unityProjectId,
        editorInstanceId: config.unityEditorInstanceId
      });
    }
  } catch (error) {
    failed = true;
    steps.push({ name: "phase3 repair smoke", ok: false, error: message(error), summary: smokeErrorEvidence(error) });
  } finally {
    try {
      const restored = await restoreSmokeEditor(steps, () => editorState.restore(), originalEditorSnapshot);
      if (restored) steps.push({ name: "restore original editor snapshot", ok: true, summary: summarizeBridgeResult(restored) });
    } catch (error) {
      failed = true;
      steps.push({ name: "restore original editor snapshot", ok: false, error: message(error), summary: smokeErrorEvidence(error) });
    } finally {
      unity.dispose();
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
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

export async function record(
  steps: SmokeStep[],
  name: string,
  run: () => Promise<Record<string, unknown>>,
  assert?: (result: Record<string, unknown>) => AssertionResult
): Promise<boolean> {
  try {
    const result = await run();
    const assertion = assert?.(result);
    const ok = result.ok === true && assertion?.ok !== false;
    if (!ok) throw Object.assign(new Error(`${name} did not satisfy its smoke assertions.`), { response: result, assertions: assertion });
    steps.push({ name, ok, summary: summarize(result), assertions: assertion });
    return ok;
  } catch (error) {
    steps.push({ name, ok: false, error: message(error), summary: smokeErrorEvidence(error) });
    throw error;
  }
}

interface AssertionResult {
  ok: boolean;
  checks: Record<string, boolean>;
  details?: Record<string, unknown>;
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

function summarizeBridgeResult(result: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: result.ok,
    restored: result.restored,
    playMode: asRecord(result.playMode).state,
    projectId: result.projectId,
    editorInstanceId: result.editorInstanceId
  };
}

function readFlags(args: string[]): { allowMutation: boolean; scriptPath: string; scenePath?: string; screenshotBaselineFilter: string } {
  let scriptPath = DefaultFixtureScript;
  let explicitScene: string | undefined;
  let allowMutation = false;
  let screenshotBaselineFilter = "";

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--allow-mutation") {
      allowMutation = true;
    }

    if (args[index] === "--script-path" && args[index + 1]) {
      scriptPath = args[index + 1];
    }

    if (args[index] === "--scene-path" && args[index + 1]) {
      explicitScene = args[index + 1];
    }

    if (args[index] === "--screenshot-baseline-filter" && args[index + 1]) {
      screenshotBaselineFilter = args[index + 1];
    }
  }

  return { allowMutation, scriptPath, scenePath: repairSmokeScene(scriptPath, explicitScene), screenshotBaselineFilter };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    process.stderr.write(`${message(error)}\n`);
    process.exitCode = 1;
  });
