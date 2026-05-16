#!/usr/bin/env node
import { readConfig } from "./config.js";
import { UnityClient } from "./unity/UnityClient.js";

interface SmokeStep {
  name: string;
  method: string;
  params?: unknown;
  required?: boolean;
}

async function main(): Promise<void> {
  const config = readConfig(process.argv.slice(2));
  const unity = new UnityClient({
    host: config.unityHost,
    port: config.unityPort,
    queueDir: config.unityQueueDir,
    requestTimeoutMs: config.requestTimeoutMs
  });

  const steps: SmokeStep[] = [
    { name: "bridge health", method: "health", required: true },
    { name: "editor state", method: "editor.get_state", required: true },
    {
      name: "active scene hierarchy",
      method: "scene.get_hierarchy",
      params: { includeInactive: true, maxDepth: 3 },
      required: true
    },
    {
      name: "console errors",
      method: "console.get_logs",
      params: { severity: "error", limit: 25 }
    },
    {
      name: "find prefabs",
      method: "asset.find",
      params: { type: "Prefab", limit: 10 }
    },
    {
      name: "find materials",
      method: "asset.find",
      params: { type: "Material", limit: 10 }
    },
    {
      name: "dry-run create marker object",
      method: "gameobject.create",
      params: { name: "GhostSmoke_DryRun_Marker", dryRun: true }
    },
    {
      name: "dry-run create package folder",
      method: "asset.create_folder",
      params: { parentPath: "Assets", folderName: "GhostSmoke_DryRun", dryRun: true }
    }
  ];

  const results = [];
  let failedRequired = false;

  for (const step of steps) {
    const startedAt = Date.now();
    try {
      const data = await unity.request(step.method, step.params ?? {});
      results.push({
        ok: true,
        name: step.name,
        method: step.method,
        durationMs: Date.now() - startedAt,
        summary: summarize(data)
      });
    } catch (error) {
      if (step.required) {
        failedRequired = true;
      }

      results.push({
        ok: false,
        name: step.name,
        method: step.method,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      { ok: !failedRequired, httpEndpoint: unity.httpEndpoint, websocketEndpoint: unity.endpoint, queueEndpoint: unity.queueEndpoint ?? null, results },
      null,
      2
    )}\n`
  );
  if (failedRequired) {
    process.exitCode = 1;
  }
}

function summarize(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["ok", "package", "version", "unityVersion", "activeSceneName", "activeScenePath", "scene", "filter", "note"]) {
    if (key in record) {
      summary[key] = record[key];
    }
  }

  for (const key of ["roots", "logs", "assets", "matches", "components"]) {
    const child = record[key];
    if (Array.isArray(child)) {
      summary[`${key}Count`] = child.length;
    }
  }

  if (Object.keys(summary).length > 0) {
    return summary;
  }

  return record;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
