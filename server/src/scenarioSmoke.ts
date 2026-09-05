#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readConfig } from "./config.js";

const FixtureScene = "Assets/GAM215Fixture/RuntimeControlFixture.unity";
const FixtureScript = "Assets/GAM215Fixture/Gam215InputDriver.cs";

interface Check {
  name: string;
  ok: boolean;
  evidence?: unknown;
}

async function main(): Promise<void> {
  const config = readConfig(process.argv.slice(2));
  const client = new Client({ name: "unity-mcp-ghost-scenario-smoke", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [
      "dist/index.js",
      "--transport",
      "stdio",
      "--tool-profile",
      "all",
      "--unity-project-path",
      config.unityProjectPath ?? "",
      "--request-timeout-ms",
      String(Math.max(config.requestTimeoutMs, 60000))
    ]
  });
  const checks: Check[] = [];
  await client.connect(transport);
  try {
    const source = await successfulTool(client, "script_read", { path: FixtureScript });
    const originalContent = stringValue(source.content);
    const originalHash = stringValue(source.sha256);
    if (!originalContent || !/^[0-9a-f]{64}$/i.test(originalHash)) throw new Error("Fixture source/hash could not be read.");

    await runAndVerify(
      client,
      checks,
      "green",
      {
        id: "green-page-up",
        expectedResult: "pass",
        sourceMutations: [{ path: FixtureScript, content: `${originalContent}\n// scenario smoke: green\n`, expectedSha256: originalHash }],
        inputs: [{ device: "keyboard", action: "tap", key: "PageUp" }],
        consoleAssertions: [{ severity: "log", exact: "GAM215_PAGE:1", count: 1, timeoutMs: 10000 }],
        objectAssertions: [{ name: "GAM215 Runtime Driver", component: "Gam215InputDriver" }]
      },
      "success",
      originalHash
    );

    await runAndVerify(
      client,
      checks,
      "compile-red",
      {
        id: "expected-compile-red",
        expectedResult: "compile-failure",
        expectedFailureCode: "SCENARIO_COMPILE_FAILED",
        sourceMutations: [{ path: FixtureScript, content: `${originalContent}\nthis is deliberately invalid csharp\n`, expectedSha256: originalHash }]
      },
      "success",
      originalHash
    );

    await runAndVerify(
      client,
      checks,
      "unexpected-red",
      {
        id: "unexpected-console-red",
        expectedResult: "pass",
        sourceMutations: [{ path: FixtureScript, content: `${originalContent}\n// scenario smoke: failed assertion\n`, expectedSha256: originalHash }],
        consoleAssertions: [{ severity: "log", exact: "THIS_LOG_MUST_NOT_EXIST", count: 1, timeoutMs: 400 }]
      },
      "failed",
      originalHash
    );

    await runAndVerify(
      client,
      checks,
      "expected-timeout",
      {
        id: "expected-console-timeout",
        expectedResult: "timeout",
        expectedFailureCode: "CONSOLE_WAIT_TIMEOUT",
        sourceMutations: [{ path: FixtureScript, content: `${originalContent}\n// scenario smoke: timeout\n`, expectedSha256: originalHash }],
        consoleAssertions: [{ severity: "log", exact: "THIS_LOG_MUST_NOT_EXIST", count: 1, timeoutMs: 400 }]
      },
      "success",
      originalHash
    );

    const cancelStarted = await startScenario(client, "cancelled", {
      id: "cancel-during-assertion",
      expectedResult: "pass",
      sourceMutations: [{ path: FixtureScript, content: `${originalContent}\n// scenario smoke: cancellation\n`, expectedSha256: originalHash }],
      consoleAssertions: [{ severity: "log", exact: "THIS_LOG_MUST_NOT_EXIST", count: 1, timeoutMs: 30000 }]
    });
    await waitForOperation(client, cancelStarted, (state) => {
      const apply = objectValue(objectValue(state.activeCase).sourceApply);
      return (
        apply.ok === true ||
        arrayValue(apply.receipts).length > 0 ||
        ["applied", "recovered"].includes(stringValue(apply.status)) ||
        apply.recoveredAfterReload === true
      );
    });
    await successfulTool(client, "operation_cancel", { operationId: cancelStarted });
    const cancelled = await waitForTerminal(client, cancelStarted);
    await verifyTerminal(client, checks, "cancelled", cancelStarted, cancelled, "cancelled", originalHash);

    process.stdout.write(`${JSON.stringify({ ok: checks.every((item) => item.ok), checks }, null, 2)}\n`);
    if (!checks.every((item) => item.ok)) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

async function runAndVerify(
  client: Client,
  checks: Check[],
  name: string,
  scenarioCase: Record<string, unknown>,
  expectedStatus: string,
  originalHash: string
): Promise<void> {
  const operationId = await startScenario(client, name, scenarioCase);
  const terminal = await waitForTerminal(client, operationId);
  await verifyTerminal(client, checks, name, operationId, terminal, expectedStatus, originalHash);
}

async function startScenario(client: Client, name: string, scenarioCase: Record<string, unknown>): Promise<string> {
  const data = await successfulTool(client, "scenario_matrix_run", {
    name: `scenario smoke ${name}`,
    scenePath: FixtureScene,
    compileTimeoutMs: 60000,
    zeroCompilerErrors: true,
    failFast: true,
    cleanupRequired: true,
    cases: [{ timeoutMs: 120000, ...scenarioCase }]
  });
  const operationId = stringValue(data.operationId);
  if (!operationId) throw new Error(`Scenario ${name} did not return operationId.`);
  return operationId;
}

async function verifyTerminal(
  client: Client,
  checks: Check[],
  name: string,
  operationId: string,
  terminal: Record<string, unknown>,
  expectedStatus: string,
  originalHash: string
): Promise<void> {
  const caseRecord = objectValue(arrayValue(terminal.cases)[0]);
  const restoration = objectValue(caseRecord.restoration);
  const hashes = arrayValue(restoration.hashes).map(objectValue);
  const source = await successfulTool(client, "script_read", { path: FixtureScript });
  const bundle = await successfulTool(client, "evidence_bundle_create", { operationId });
  const manifestPath = stringValue(
    arrayValue(bundle.files)
      .map(objectValue)
      .find((item) => item.name === "manifest.json")?.path
  );
  await access(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const ok =
    terminal.status === expectedStatus &&
    terminal.restorationComplete === true &&
    stringValue(source.sha256) === originalHash &&
    hashes.every((item) => item.matches === true) &&
    manifest.restorationComplete === true;
  checks.push({
    name,
    ok,
    evidence: {
      operationId,
      status: terminal.status,
      observedResult: caseRecord.observedResult,
      sourceHash: source.sha256,
      restorationHashes: hashes,
      evidenceDirectory: bundle.directory,
      manifestPath
    }
  });
  if (!ok) throw new Error(`Scenario smoke '${name}' failed verification: ${JSON.stringify(terminal)}`);
}

async function waitForTerminal(client: Client, operationId: string): Promise<Record<string, unknown>> {
  let terminal: Record<string, unknown> = {};
  await waitForOperation(client, operationId, (state) => {
    terminal = state;
    return ["success", "failed", "cancelled", "outcomeUnknown"].includes(stringValue(state.status));
  });
  return terminal;
}

async function waitForOperation(client: Client, operationId: string, predicate: (state: Record<string, unknown>) => boolean): Promise<void> {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const state = await toolData(client, "operation_get", { operationId });
    if (predicate(state)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for scenario operation ${operationId}.`);
}

async function successfulTool(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const envelope = objectValue(result.structuredContent);
  if (result.isError === true || envelope.ok !== true) {
    throw new Error(`${name} failed: ${JSON.stringify(envelope.error ?? envelope)}`);
  }
  return objectValue(envelope.data);
}

async function toolData(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  return objectValue(objectValue(result.structuredContent).data);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
