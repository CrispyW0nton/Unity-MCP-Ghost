#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readConfig } from "./config.js";

interface SmokeCheck {
  name: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

const FixtureScene = "Assets/GAM215Fixture/RuntimeControlFixture.unity";

async function main(): Promise<void> {
  const config = readConfig(process.argv.slice(2));
  const checks: SmokeCheck[] = [];
  const client = new Client({ name: "unity-mcp-ghost-runtime-smoke", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [
      "dist/index.js",
      "--transport",
      "stdio",
      "--unity-project-path",
      config.unityProjectPath ?? "",
      "--request-timeout-ms",
      String(Math.max(config.requestTimeoutMs, 30000))
    ]
  });

  await client.connect(transport);
  try {
    await setupFixture(client, config.unityProjectPath ?? "", checks);
    const clear = await checkedCall(client, checks, "console clear", "console_clear", {});
    const clearBoundary = stringValue(clear.boundary);
    await checkedCall(client, checks, "enter normal Play mode", "play_mode_set", {
      state: "playing",
      waitForSettled: true,
      timeoutMs: 30000,
      saveModifiedScenes: false
    });
    await checkedCall(client, checks, "fixture Start Console evidence", "console_wait", {
      boundary: clearBoundary,
      severity: "log",
      exact: "GAM215_FIXTURE_READY:0",
      count: 1,
      timeoutMs: 10000,
      failOnUnexpectedErrors: true
    });

    await inputCase(client, checks, "PageUp", "GAM215_PAGE:1");
    await inputCase(client, checks, "PageDown", "GAM215_PAGE:0");
    await expectedFailure(client, checks, "unsupported input is truthful", "input_simulate", {
      device: "keyboard",
      action: "tap",
      key: "F12",
      timeoutMs: 5000
    }, "UNSUPPORTED_INPUT_BACKEND");
    const pointerMark = await checkedCall(client, checks, "pointer boundary", "console_mark", { label: "before-pointer" });
    await checkedCall(client, checks, "pointer click delivery", "input_simulate", {
      device: "pointer",
      action: "click",
      button: "left",
      x: 100,
      y: 100,
      timeoutMs: 5000
    });
    await checkedCall(client, checks, "pointer Console evidence", "console_assert", {
      boundary: stringValue(pointerMark.boundary),
      severity: "log",
      exact: "GAM215_POINTER_CLICK:1",
      count: 1,
      failOnUnexpectedErrors: true
    });

    await checkedCall(client, checks, "pause normal Play mode", "play_mode_set", {
      state: "paused",
      waitForSettled: true,
      timeoutMs: 10000,
      saveModifiedScenes: false
    });
    await checkedCall(client, checks, "step exactly one frame", "play_mode_step", { timeoutMs: 5000 });
  } finally {
    try {
      await checkedCall(client, checks, "stop normal Play mode", "play_mode_set", {
        state: "stopped",
        waitForSettled: true,
        timeoutMs: 30000,
        saveModifiedScenes: false
      });
    } catch {
      // The failed check is already included in the evidence list.
    }
    await client.close();
  }

  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({ ok, fixtureScene: FixtureScene, checks }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

async function setupFixture(client: Client, projectPath: string, checks: SmokeCheck[]): Promise<void> {
  if (existsSync(join(projectPath, FixtureScene))) {
    await checkedCall(client, checks, "open runtime fixture", "scene_open", { path: FixtureScene, mode: "single", dryRun: false });
    return;
  }

  await checkedCall(client, checks, "create runtime fixture scene", "scene_create", { setup: "empty", mode: "single", dryRun: false });
  const gameObject = await checkedCall(client, checks, "create runtime fixture object", "gameobject_create", {
    name: "GAM215 Runtime Driver",
    dryRun: false
  });
  await checkedCall(client, checks, "attach runtime fixture driver", "component_add", {
    instanceId: numberValue(gameObject.instanceId),
    type: "Gam215InputDriver",
    dryRun: false
  });
  await checkedCall(client, checks, "save runtime fixture scene", "scene_save", { path: FixtureScene, dryRun: false });
}

async function inputCase(client: Client, checks: SmokeCheck[], key: "PageUp" | "PageDown", expectedLog: string): Promise<void> {
  const mark = await checkedCall(client, checks, `${key} boundary`, "console_mark", { label: `before-${key}` });
  const input = await checkedCall(client, checks, `${key} delivery`, "input_simulate", {
    device: "keyboard",
    action: "tap",
    key,
    timeoutMs: 5000
  });
  if (!stringValue(input.backend).startsWith("project-test-driver:")) {
    throw new Error(`${key} selected an unexpected backend: ${String(input.backend)}`);
  }
  await checkedCall(client, checks, `${key} Console evidence`, "console_assert", {
    boundary: stringValue(mark.boundary),
    severity: "log",
    exact: expectedLog,
    count: 1,
    failOnUnexpectedErrors: true
  });
}

async function checkedCall(client: Client, checks: SmokeCheck[], name: string, toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    const envelope = (result.structuredContent ?? {}) as Record<string, unknown>;
    const data = objectValue(envelope.data);
    const ok = result.isError !== true && envelope.ok === true;
    checks.push({ name, ok, data: ok ? data : envelope });
    if (!ok) {
      throw new Error(`${toolName} failed: ${JSON.stringify(envelope.error ?? envelope)}`);
    }
    return data;
  } catch (error) {
    if (!checks.some((check) => check.name === name && !check.ok)) {
      checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    throw error;
  }
}

async function expectedFailure(
  client: Client,
  checks: SmokeCheck[],
  name: string,
  toolName: string,
  args: Record<string, unknown>,
  expectedCode: string
): Promise<void> {
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    const envelope = (result.structuredContent ?? {}) as Record<string, unknown>;
    const error = objectValue(envelope.error);
    const observedCode = stringValue(error.code);
    const ok = result.isError === true && envelope.ok === false && observedCode === expectedCode;
    checks.push({ name, ok, data: envelope });
    if (!ok) {
      throw new Error(`${toolName} returned ${observedCode || "no error code"}; expected ${expectedCode}`);
    }
  } catch (error) {
    if (!checks.some((check) => check.name === name)) {
      checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    throw error;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
