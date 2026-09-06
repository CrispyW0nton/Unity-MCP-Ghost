#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readConfig } from "./config.js";
import { buildModule1Matrix, buildModule2Matrix, cancellationCase, CourseFixtureScene, CourseFixtureScript } from "./course/courseMatrices.js";
import { invalidCompilerReceiptCaseIds } from "./course/compilerReceiptValidation.js";
import type { ScenarioMatrixDefinition } from "./scenario/ScenarioJobManager.js";

interface ModuleReceipt {
  module: string;
  operationId: string;
  caseCount: number;
  expectedFailureCases: number;
  screenshotCount: number;
  sourceSha256: string;
  evidenceDirectory: string;
  manifestPath: string;
  cancellationOperationId: string;
}

async function main(): Promise<void> {
  const config = readConfig(process.argv.slice(2));
  if (!config.unityProjectPath) {
    throw new Error("test:course requires --unity-project-path (the package script supplies test-project by default).");
  }
  const client = new Client({ name: "unity-mcp-ghost-course-suite", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [
      "dist/index.js",
      "--transport",
      "stdio",
      "--tool-profile",
      "all",
      "--unity-project-path",
      config.unityProjectPath,
      "--request-timeout-ms",
      String(Math.max(config.requestTimeoutMs, 60000))
    ]
  });

  await client.connect(transport);
  try {
    const baseline = await successfulTool(client, "script_read", { path: CourseFixtureScript });
    const originalContent = stringValue(baseline.content);
    const originalSha256 = stringValue(baseline.sha256);
    if (!originalContent || !/^[0-9a-f]{64}$/i.test(originalSha256)) {
      throw new Error("The clean-room StudentExercise baseline could not be read with a SHA-256 receipt.");
    }

    const receipts: ModuleReceipt[] = [];
    for (const [module, definition] of [
      ["Module 1", buildModule1Matrix(originalContent, originalSha256)],
      ["Module 2", buildModule2Matrix(originalContent, originalSha256)]
    ] as const) {
      const completed = await runMatrix(client, definition);
      const cancellationOperationId = await runCancellation(client, module === "Module 1" ? "m1" : "m2", originalContent, originalSha256);
      receipts.push(await verifyModule(client, module, definition, completed, originalSha256, cancellationOperationId));
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          qualification: "GAM 215-equivalent fixture complete; real course-project certification pending",
          unityProjectPath: config.unityProjectPath,
          modules: receipts
        },
        null,
        2
      )}\n`
    );
  } finally {
    await client.close();
  }
}

async function runMatrix(client: Client, definition: ScenarioMatrixDefinition): Promise<Record<string, unknown>> {
  const started = await successfulTool(client, "scenario_matrix_run", definition as unknown as Record<string, unknown>);
  const operationId = stringValue(started.operationId);
  if (!operationId) throw new Error(`${definition.name} did not return a durable operationId.`);
  return waitForTerminal(client, operationId, 20 * 60 * 1000);
}

async function runCancellation(client: Client, moduleId: "m1" | "m2", originalContent: string, originalSha256: string): Promise<string> {
  const definition: ScenarioMatrixDefinition = {
    name: `GAM 215-equivalent ${moduleId.toUpperCase()} cancellation restoration`,
    scenePath: CourseFixtureScene,
    compileTimeoutMs: 60000,
    zeroCompilerErrors: true,
    failFast: true,
    cleanupRequired: true,
    cases: [cancellationCase(moduleId, originalContent, originalSha256)]
  };
  const started = await successfulTool(client, "scenario_matrix_run", definition as unknown as Record<string, unknown>);
  const operationId = stringValue(started.operationId);
  await waitForOperation(
    client,
    operationId,
    (state) => {
      const apply = objectValue(objectValue(state.activeCase).sourceApply);
      return apply.ok === true || arrayValue(apply.receipts).length > 0 || apply.recoveredAfterReload === true;
    },
    180000
  );
  await successfulTool(client, "operation_cancel", { operationId });
  const terminal = await waitForTerminal(client, operationId, 180000);
  if (terminal.status !== "cancelled" || terminal.restorationComplete !== true) {
    throw new Error(`${moduleId} cancellation did not restore cleanly: ${JSON.stringify(terminal)}`);
  }
  const source = await successfulTool(client, "script_read", { path: CourseFixtureScript });
  if (source.sha256 !== originalSha256) throw new Error(`${moduleId} cancellation changed the StudentExercise baseline.`);
  return operationId;
}

async function verifyModule(
  client: Client,
  module: string,
  definition: ScenarioMatrixDefinition,
  terminal: Record<string, unknown>,
  originalSha256: string,
  cancellationOperationId: string
): Promise<ModuleReceipt> {
  const operationId = stringValue(terminal.operationId);
  const cases = arrayValue(terminal.cases).map(objectValue);
  const failures = cases.filter((item) => item.status !== "passed");
  const incompleteRestorations = cases.filter((item) => objectValue(item.restoration).ok !== true);
  const missingCompilerAssertions = invalidCompilerReceiptCaseIds(definition.cases, cases);
  const source = await successfulTool(client, "script_read", { path: CourseFixtureScript });
  if (
    terminal.status !== "success" ||
    terminal.restorationComplete !== true ||
    cases.length !== definition.cases.length ||
    failures.length > 0 ||
    incompleteRestorations.length > 0 ||
    missingCompilerAssertions.length > 0 ||
    source.sha256 !== originalSha256
  ) {
    throw new Error(`${module} verification failed: ${JSON.stringify({ terminal, failures, incompleteRestorations, missingCompilerAssertions, source })}`);
  }

  const bundle = await successfulTool(client, "evidence_bundle_create", { operationId });
  const manifestPath = stringValue(
    arrayValue(bundle.files)
      .map(objectValue)
      .find((item) => item.name === "manifest.json")?.path
  );
  await access(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  if (manifest.status !== "success" || manifest.restorationComplete !== true) {
    throw new Error(`${module} evidence manifest does not prove successful restoration.`);
  }

  const expectedScreenshots = definition.cases.filter(
    (item) =>
      (item.screenshotAssertions?.length ?? 0) > 0 &&
      item.expectedResult !== "compile-failure" &&
      item.expectedResult !== "timeout" &&
      item.expectedResult !== "cancelled"
  ).length;
  const screenshotCount = cases.reduce((count, item) => count + arrayValue(item.screenshots).length, 0);
  if (screenshotCount !== expectedScreenshots) {
    throw new Error(`${module} expected ${expectedScreenshots} screenshot receipts but observed ${screenshotCount}.`);
  }

  return {
    module,
    operationId,
    caseCount: cases.length,
    expectedFailureCases: definition.cases.filter((item) => item.expectedResult !== undefined && item.expectedResult !== "pass").length,
    screenshotCount,
    sourceSha256: stringValue(source.sha256),
    evidenceDirectory: stringValue(bundle.directory),
    manifestPath,
    cancellationOperationId
  };
}

async function waitForTerminal(client: Client, operationId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  let terminal: Record<string, unknown> = {};
  await waitForOperation(
    client,
    operationId,
    (state) => {
      terminal = state;
      return ["success", "failed", "cancelled", "outcomeUnknown"].includes(stringValue(state.status));
    },
    timeoutMs
  );
  return terminal;
}

async function waitForOperation(client: Client, operationId: string, predicate: (state: Record<string, unknown>) => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await toolData(client, "operation_get", { operationId });
    if (predicate(state)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for course operation ${operationId}.`);
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
