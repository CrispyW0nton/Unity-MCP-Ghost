#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readConfig } from "./config.js";

interface SmokeStep {
  name: string;
  ok: boolean;
  summary?: unknown;
  error?: string;
}

const DefaultKotorScript = "Assets/Scripts/KotOR/Modules/Spawning/ModuleSpawnPipeline.cs";
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
      "--unity-host",
      config.unityHost,
      "--unity-port",
      String(config.unityPort),
      "--request-timeout-ms",
      String(config.requestTimeoutMs),
      ...(config.unityQueueDir ? ["--unity-queue-dir", config.unityQueueDir] : [])
    ]
  });

  const steps: SmokeStep[] = [];
  let failed = false;

  try {
    await client.connect(transport);
    await record(steps, "compile wait", () => callTool(client, "compile_wait", { timeoutMs: config.requestTimeoutMs }));
    await record(steps, "repair loop semantic test scope", () =>
      callTool(client, "repair_loop_run", {
        objective: "Verify repair loop includes semantic test-scope planning for the target gameplay script.",
        scriptPath: flags.scriptPath,
        useSemanticTestScope: true,
        runTests: false,
        compileTimeoutMs: config.requestTimeoutMs
      })
    );
    await record(steps, "repair apply dry-run against target script", () =>
      callTool(client, "repair_apply_edits", {
        objective: "Preview a no-op ranged repair edit without mutating gameplay code.",
        scriptPath: flags.scriptPath,
        edits: [{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 0, text: "" }],
        dryRun: true
      })
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

    await record(steps, "compile scratch script", () => callTool(client, "compile_wait", { timeoutMs }));
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
    if (scriptCreated) {
      await record(steps, "delete scratch script", () =>
        callTool(client, "script_delete", {
          path: ScratchScriptPath,
          dryRun: false
        })
      );
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

    if (scriptCreated || folderCreated) {
      await record(steps, "compile after scratch cleanup", () => callTool(client, "compile_wait", { timeoutMs }));
    }
  }
}

async function record(steps: SmokeStep[], name: string, run: () => Promise<Record<string, unknown>>): Promise<boolean> {
  try {
    const result = await run();
    steps.push({ name, ok: result.ok !== false, summary: summarize(result) });
    return result.ok !== false;
  } catch (error) {
    steps.push({ name, ok: false, error: message(error) });
    return false;
  }
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
  return text.includes("ECONNREFUSED")
    || text.includes("fetch failed")
    || text.includes("socket hang up")
    || text.includes("other side closed")
    || text.includes("Unity HTTP bridge responded 503");
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
    stepCount: Array.isArray(record.steps) ? record.steps.length : undefined
  };
}

function readFlags(args: string[]): { allowMutation: boolean; scriptPath: string } {
  let scriptPath = DefaultKotorScript;
  let allowMutation = false;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--allow-mutation") {
      allowMutation = true;
    }

    if (args[index] === "--script-path" && args[index + 1]) {
      scriptPath = args[index + 1];
    }
  }

  return { allowMutation, scriptPath };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  process.stderr.write(`${message(error)}\n`);
  process.exitCode = 1;
});
