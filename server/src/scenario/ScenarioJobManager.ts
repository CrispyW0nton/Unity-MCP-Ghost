import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { UnityClient } from "../unity/UnityClient.js";
import { PackageVersion } from "../version.js";

export type ScenarioExpectedResult = "pass" | "compile-failure" | "assertion-failure" | "timeout" | "cancelled";

export interface ScenarioSourceMutation {
  path: string;
  content: string;
  expectedSha256: string;
}

export interface ScenarioInput {
  device: "keyboard" | "pointer";
  action: "tap" | "press" | "release" | "click";
  key?: string;
  button?: "left";
  x?: number;
  y?: number;
  timeoutMs?: number;
}

export interface ScenarioConsoleAssertion {
  boundary?: string;
  generation?: number;
  severity?: "log" | "warning" | "error" | "all";
  exact?: string;
  contains?: string;
  regex?: string;
  file?: string;
  line?: number;
  count?: number;
  minimumCount?: number;
  maximumCount?: number;
  limit?: number;
  failOnUnexpectedErrors?: boolean;
  timeoutMs?: number;
}

export interface ScenarioObjectAssertion {
  hierarchyPath?: string;
  name?: string;
  exists?: boolean;
  activeSelf?: boolean;
  component?: string;
  propertyPath?: string;
  equals?: unknown;
  contains?: string;
}

export interface ScenarioScreenshotAssertion {
  label: string;
  mode?: "auto" | "mainCamera" | "game" | "sceneView" | "scene";
  width?: number;
  height?: number;
  superSize?: number;
  baselinePath?: string;
  dimensionMode?: "reject" | "resample-current";
  threshold?: number;
  maxSamples?: number;
}

export interface ScenarioCaseDefinition {
  id: string;
  description?: string;
  expectedResult?: ScenarioExpectedResult;
  expectedFailureCode?: string;
  timeoutMs?: number;
  sourceMutations?: ScenarioSourceMutation[];
  inputs?: ScenarioInput[];
  consoleAssertions?: ScenarioConsoleAssertion[];
  objectAssertions?: ScenarioObjectAssertion[];
  screenshotAssertions?: ScenarioScreenshotAssertion[];
}

export interface ScenarioMatrixDefinition {
  name: string;
  projectId?: string;
  editorInstanceId?: string;
  scenePath: string;
  compileTimeoutMs?: number;
  zeroCompilerErrors?: boolean;
  failFast?: boolean;
  cleanupRequired?: boolean;
  cases: ScenarioCaseDefinition[];
}

interface ScenarioFailureShape {
  code: string;
  message: string;
  data?: unknown;
}

interface ScenarioCaseRecord {
  id: string;
  description: string;
  expectedResult: ScenarioExpectedResult;
  expectedFailureCode?: string;
  status: "running" | "passed" | "failed" | "cancelled";
  startedUtc: string;
  completedUtc?: string;
  durationMs?: number;
  startingState?: Record<string, unknown>;
  startingObjectState?: unknown[];
  consoleBoundary?: string;
  sourceApply?: Record<string, unknown>;
  compile?: Record<string, unknown>;
  inputs: Record<string, unknown>[];
  consoleAssertions: Record<string, unknown>[];
  objectAssertions: Record<string, unknown>[];
  screenshots: Record<string, unknown>[];
  observedResult?: ScenarioExpectedResult;
  failure?: ScenarioFailureShape;
  observedFailure?: ScenarioFailureShape;
  restoration?: Record<string, unknown>;
}

export interface ScenarioJobRecord {
  schemaVersion: 1;
  operationId: string;
  kind: "scenario-matrix";
  name: string;
  status: "running" | "cancelling" | "success" | "failed" | "cancelled" | "outcomeUnknown";
  phase: string;
  createdUtc: string;
  updatedUtc: string;
  completedUtc?: string;
  projectId: string;
  editorInstanceId: string;
  definition: ScenarioMatrixDefinition;
  originalState?: Record<string, unknown>;
  health?: Record<string, unknown>;
  cases: ScenarioCaseRecord[];
  activeCase?: ScenarioCaseRecord;
  currentCaseIndex: number;
  cancelRequested: boolean;
  restorationRequired: boolean;
  restorationComplete: boolean;
  evidenceDirectory: string;
  failure?: ScenarioFailureShape;
}

interface ScenarioJobManagerOptions {
  unity: UnityClient;
  projectPath?: string;
  projectId?: string;
  editorInstanceId?: string;
}

const terminalStatuses = new Set(["success", "failed", "cancelled", "outcomeUnknown"]);
const evidenceFiles = new Set(["manifest.json", "scenario-results.json", "compiler.json", "console.json", "summary.md"]);

export class ScenarioJobManager {
  private readonly projectPath?: string;
  private readonly projectId: string;
  private readonly editorInstanceId: string;
  private readonly jobsRoot?: string;
  private readonly evidenceRoot?: string;
  private readonly controllers = new Map<string, AbortController>();
  private recovery: Promise<void> | undefined;

  public constructor(private readonly options: ScenarioJobManagerOptions) {
    this.projectPath = options.projectPath ? resolve(options.projectPath) : undefined;
    this.projectId = options.projectId ?? "";
    this.editorInstanceId = options.editorInstanceId ?? "";
    this.jobsRoot = this.projectPath ? join(this.projectPath, "Library", "UnityMcpGhost", "scenario-jobs") : undefined;
    this.evidenceRoot = this.projectPath ? join(this.projectPath, "Library", "UnityMcpGhost", "evidence") : undefined;
  }

  public get available(): boolean {
    return Boolean(this.projectPath && this.projectId && this.editorInstanceId && this.jobsRoot && this.evidenceRoot);
  }

  public async start(definition: ScenarioMatrixDefinition): Promise<Record<string, unknown>> {
    this.requireAvailable();
    await this.ensureRecovered();
    if (definition.projectId && definition.projectId !== this.projectId) {
      throw new ScenarioFailure("SCENARIO_PROJECT_MISMATCH", "The scenario projectId does not match the pinned Unity project.");
    }
    if (definition.editorInstanceId && definition.editorInstanceId !== this.editorInstanceId) {
      throw new ScenarioFailure("SCENARIO_EDITOR_MISMATCH", "The scenario editorInstanceId does not match the pinned Unity editor.");
    }
    if (definition.cases.length === 0 || definition.cases.length > 200) {
      throw new ScenarioFailure("INVALID_SCENARIO_CASE_COUNT", "A scenario matrix requires between 1 and 200 cases.");
    }
    if (definition.cleanupRequired === false) {
      throw new ScenarioFailure("SCENARIO_CLEANUP_REQUIRED", "This milestone requires source and editor restoration for every scenario matrix.");
    }
    const ids = new Set<string>();
    for (const item of definition.cases) {
      if (!ids.add(item.id)) throw new ScenarioFailure("DUPLICATE_SCENARIO_CASE", `Duplicate scenario case id: ${item.id}`);
    }

    const operationId = randomUUID();
    const now = new Date().toISOString();
    const evidenceDirectory = this.safeEvidenceDirectory(operationId);
    const record: ScenarioJobRecord = {
      schemaVersion: 1,
      operationId,
      kind: "scenario-matrix",
      name: definition.name,
      status: "running",
      phase: "queued",
      createdUtc: now,
      updatedUtc: now,
      projectId: this.projectId,
      editorInstanceId: this.editorInstanceId,
      definition,
      cases: [],
      currentCaseIndex: 0,
      cancelRequested: false,
      restorationRequired: false,
      restorationComplete: false,
      evidenceDirectory
    };
    await mkdir(evidenceDirectory, { recursive: true });
    await this.save(record);
    this.launch(record);
    return this.summary(record);
  }

  public async get(operationId: string): Promise<Record<string, unknown>> {
    this.requireAvailable();
    await this.ensureRecovered();
    return this.envelope(await this.loadRequired(operationId));
  }

  public async list(limit = 50): Promise<Record<string, unknown>> {
    this.requireAvailable();
    await this.ensureRecovered();
    const files = (await readdir(this.jobsRoot!)).filter((name) => name.endsWith(".json"));
    const records = (await Promise.all(files.map((name) => this.loadPath(join(this.jobsRoot!, name)))))
      .filter((record): record is ScenarioJobRecord => record !== undefined)
      .sort((left, right) => right.updatedUtc.localeCompare(left.updatedUtc))
      .slice(0, Math.max(1, Math.min(limit, 200)));
    return { ok: true, operations: records.map((record) => this.summary(record)), count: records.length, truncated: files.length > records.length };
  }

  public async cancel(operationId: string): Promise<Record<string, unknown>> {
    this.requireAvailable();
    await this.ensureRecovered();
    const record = await this.loadRequired(operationId);
    if (terminalStatuses.has(record.status)) return this.envelope(record);
    record.cancelRequested = true;
    record.status = "cancelling";
    record.phase = "cancellation-requested";
    await this.save(record);
    this.controllers.get(operationId)?.abort();
    return this.envelope(record);
  }

  public async result(operationId: string): Promise<Record<string, unknown>> {
    this.requireAvailable();
    await this.ensureRecovered();
    const record = await this.loadRequired(operationId);
    if (!terminalStatuses.has(record.status)) {
      return { ok: true, operationId, status: record.status, ready: false };
    }
    return {
      ok: record.status === "success",
      operationId,
      status: record.status,
      ready: true,
      result: {
        name: record.name,
        passed: record.cases.filter((item) => item.status === "passed").length,
        failed: record.cases.filter((item) => item.status === "failed").length,
        cancelled: record.cases.filter((item) => item.status === "cancelled").length,
        restorationComplete: record.restorationComplete,
        evidence: this.evidenceHandles(record)
      },
      error: record.failure ?? null
    };
  }

  public async createEvidence(operationId: string): Promise<Record<string, unknown>> {
    this.requireAvailable();
    await this.ensureRecovered();
    const record = await this.loadRequired(operationId);
    if (!terminalStatuses.has(record.status)) {
      throw new ScenarioFailure("SCENARIO_NOT_COMPLETE", "Evidence can only be finalized after the scenario reaches a terminal state.");
    }
    await this.writeEvidence(record);
    return {
      ok: true,
      operationId,
      format: "directory",
      directory: record.evidenceDirectory,
      files: [...this.evidenceHandles(record), ...(await this.artifactHandles(record))]
    };
  }

  public async readEvidence(operationId: string, file: string): Promise<{ path: string; mimeType: string; text?: string; blob?: Buffer }> {
    this.requireAvailable();
    await this.ensureRecovered();
    if (!evidenceFiles.has(file)) throw new ScenarioFailure("EVIDENCE_FILE_NOT_FOUND", "The requested evidence file is not a public bundle document.");
    const record = await this.loadRequired(operationId);
    const path = this.safeEvidencePath(record, file);
    const bytes = await readFile(path);
    const mimeType = file.endsWith(".md") ? "text/markdown" : "application/json";
    return { path, mimeType, text: bytes.toString("utf8") };
  }

  public async readArtifact(
    operationId: string,
    kind: "screenshots" | "diffs",
    file: string
  ): Promise<{ path: string; mimeType: string; text?: string; blob?: Buffer }> {
    this.requireAvailable();
    await this.ensureRecovered();
    if (basename(file) !== file || safeSegment(file) !== file) {
      throw new ScenarioFailure("EVIDENCE_FILE_NOT_FOUND", "Evidence artifact filenames may not contain path traversal or separators.");
    }
    if (kind === "screenshots" && !file.toLowerCase().endsWith(".png")) {
      throw new ScenarioFailure("EVIDENCE_FILE_NOT_FOUND", "Screenshot evidence must be a PNG.");
    }
    if (kind === "diffs" && !file.toLowerCase().endsWith(".diff")) {
      throw new ScenarioFailure("EVIDENCE_FILE_NOT_FOUND", "Source-diff evidence must be a .diff file.");
    }
    const record = await this.loadRequired(operationId);
    const path = this.safeEvidencePath(record, join(kind, file));
    const bytes = await readFile(path);
    return kind === "screenshots" ? { path, mimeType: "image/png", blob: bytes } : { path, mimeType: "text/x-diff", text: bytes.toString("utf8") };
  }

  private launch(record: ScenarioJobRecord): void {
    const controller = new AbortController();
    this.controllers.set(record.operationId, controller);
    void this.execute(record, controller.signal)
      .catch(async (error: unknown) => {
        const latest = await this.loadRequired(record.operationId).catch(() => record);
        latest.status = "failed";
        latest.phase = "failed";
        latest.failure = failureShape(error);
        latest.completedUtc = new Date().toISOString();
        await this.writeEvidence(latest).catch(() => undefined);
        await this.save(latest).catch(() => undefined);
      })
      .finally(() => this.controllers.delete(record.operationId));
  }

  private async execute(record: ScenarioJobRecord, signal: AbortSignal): Promise<void> {
    let originalState: Record<string, unknown> | undefined;
    try {
      record.phase = "capturing-original-state";
      record.health = await this.request("health", {}, signal);
      originalState = await this.request("editor.snapshot", {}, signal);
      record.originalState = originalState;
      const dirtyScenes = arrayValue(originalState.dirtyScenes);
      if (dirtyScenes.length > 0) {
        throw new ScenarioFailure("SCENARIO_DIRTY_SCENE_CONFLICT", "Scenario execution refuses to discard pre-existing modified scenes.", {
          scenes: dirtyScenes
        });
      }
      await this.save(record);

      const originalPlay = objectValue(originalState.playMode);
      if (originalPlay.state !== "stopped") {
        await this.setPlayMode("stopped", 30000, signal);
      }
      this.checkCancellation(record, signal);
      record.phase = "opening-scenario-scene";
      await this.request("scene.open", { path: record.definition.scenePath, mode: "single", dryRun: false }, signal);
      await this.save(record);

      for (let index = record.currentCaseIndex; index < record.definition.cases.length; index += 1) {
        this.checkCancellation(record, signal);
        record.currentCaseIndex = index;
        record.phase = `case:${record.definition.cases[index].id}`;
        await this.save(record);
        const result = await this.runCase(record, record.definition.cases[index], signal);
        record.cases.push(result);
        record.activeCase = undefined;
        record.currentCaseIndex = index + 1;
        await this.save(record);
        if (result.status !== "passed" && (record.definition.failFast ?? true)) break;
      }

      const failures = record.cases.filter((item) => item.status !== "passed");
      record.status = failures.length === 0 ? "success" : failures.some((item) => item.status === "cancelled") ? "cancelled" : "failed";
      record.phase = record.status;
      if (failures.length > 0) {
        record.failure = failures[0].failure ?? { code: "SCENARIO_CASE_FAILED", message: `Scenario case '${failures[0].id}' failed.` };
      }
    } catch (error) {
      const failure = failureShape(error);
      record.status = failure.code === "OPERATION_CANCELLED" ? "cancelled" : "failed";
      record.phase = record.status;
      record.failure = failure;
    } finally {
      const terminalStatus = record.status;
      record.restorationRequired = true;
      record.status = terminalStatus === "cancelled" ? "cancelling" : "running";
      record.phase = "restoring-original-state";
      await this.save(record).catch(() => undefined);
      try {
        await this.restoreOriginalState(record, originalState);
        record.restorationComplete = true;
        record.status = terminalStatus;
        record.phase = terminalStatus;
      } catch (restoreError) {
        record.restorationComplete = false;
        record.status = "failed";
        record.phase = "restore-failed";
        record.failure = {
          code: "SCENARIO_FINAL_RESTORE_FAILED",
          message: failureShape(restoreError).message,
          data: { originalFailure: record.failure }
        };
      }
      record.completedUtc = new Date().toISOString();
      await this.writeEvidence(record);
      await this.save(record);
    }
  }

  private async runCase(record: ScenarioJobRecord, definition: ScenarioCaseDefinition, signal: AbortSignal): Promise<ScenarioCaseRecord> {
    const started = Date.now();
    const deadline = started + (definition.timeoutMs ?? 120000);
    const expectedResult = definition.expectedResult ?? "pass";
    const result: ScenarioCaseRecord = {
      id: definition.id,
      description: definition.description ?? "",
      expectedResult,
      expectedFailureCode: definition.expectedFailureCode,
      status: "running",
      startedUtc: new Date(started).toISOString(),
      inputs: [],
      consoleAssertions: [],
      objectAssertions: [],
      screenshots: []
    };
    record.activeCase = result;
    await this.save(record);
    let caseState: Record<string, unknown> | undefined;
    let applyReceipts: Record<string, unknown>[] = [];
    let restoreOutcomes: Record<string, unknown>[] = [];
    let transactionId = "";
    let observedResult: ScenarioExpectedResult = "pass";
    let observedFailure: ScenarioFailureShape | undefined;

    try {
      caseState = await this.request("editor.snapshot", {}, signal, this.remaining(deadline));
      result.startingState = caseState;
      result.startingObjectState = [];
      for (const assertion of definition.objectAssertions ?? []) {
        result.startingObjectState.push(await this.request("runtime.inspect", assertion, signal, this.remaining(deadline)));
      }
      const mark = await this.request("console.mark", { label: `scenario:${record.operationId}:${definition.id}` }, signal, this.remaining(deadline));
      result.consoleBoundary = stringValue(mark.boundary);

      if ((definition.sourceMutations?.length ?? 0) > 0) {
        this.checkCancellation(record, signal);
        transactionId = `${record.operationId}:${definition.id}`;
        result.sourceApply = { transactionId, status: "starting" };
        await this.save(record);
        let applied: Record<string, unknown>;
        try {
          applied = await this.request("scenario.source_apply", { transactionId, mutations: definition.sourceMutations }, undefined, this.remaining(deadline));
        } catch (error) {
          applied = await this.recoverAppliedTransaction(transactionId, Math.min(30000, this.remaining(deadline)), error);
        }
        if (requiresDurableTransactionRecovery(applied)) {
          applied = await this.recoverAppliedTransaction(
            transactionId,
            Math.min(30000, this.remaining(deadline)),
            new ScenarioFailure(errorCode(applied, "SCENARIO_SOURCE_APPLY_INTERRUPTED"), errorMessage(applied), applied)
          );
        }
        if (applied.ok === false) throw new ScenarioFailure(errorCode(applied, "SCENARIO_SOURCE_APPLY_FAILED"), errorMessage(applied), applied);
        result.sourceApply = applied;
        applyReceipts = arrayValue(applied.receipts).map(objectValue);
        record.restorationRequired = true;
        await this.save(record);
        await this.writeDiffs(record, definition.id, applyReceipts);
        this.checkCancellation(record, signal);
        const generation = numberValue(applied.requestedCompileGeneration);
        const compile = await this.waitForCompile(generation, record.definition.compileTimeoutMs ?? 60000, signal, deadline);
        result.compile = compile;
        if (compile.ok === false) {
          throw new ScenarioFailure("SCENARIO_COMPILE_FAILED", `Compile generation ${generation} failed.`, compile);
        }
        if ((record.definition.zeroCompilerErrors ?? true) && arrayValue(compile.diagnostics).some(isErrorDiagnostic)) {
          throw new ScenarioFailure("SCENARIO_COMPILE_FAILED", `Compile generation ${generation} contained compiler errors.`, compile);
        }
      }

      if (expectedResult === "compile-failure") {
        throw new ScenarioFailure("EXPECTED_COMPILE_FAILURE_NOT_OBSERVED", "The case expected compiler failure, but the exact generation completed cleanly.");
      }

      await this.setPlayMode("playing", this.remaining(deadline), signal);
      for (const input of definition.inputs ?? []) {
        this.checkCancellation(record, signal);
        result.inputs.push(await this.simulateInput(input, signal, Math.min(input.timeoutMs ?? 5000, this.remaining(deadline))));
      }
      for (const assertion of definition.consoleAssertions ?? []) {
        const observed = await this.waitForConsole({ ...assertion, boundary: assertion.boundary ?? result.consoleBoundary }, signal, deadline);
        result.consoleAssertions.push(observed);
      }
      for (const screenshot of definition.screenshotAssertions ?? []) {
        result.screenshots.push(await this.captureScreenshot(record, definition.id, screenshot, signal, deadline));
      }
      for (const assertion of definition.objectAssertions ?? []) {
        const observed = await this.request("runtime.assert", assertion, signal, this.remaining(deadline));
        result.objectAssertions.push(observed);
        if (observed.ok === false || observed.matched === false) {
          throw new ScenarioFailure(errorCode(observed, "RUNTIME_ASSERTION_FAILED"), errorMessage(observed), observed);
        }
      }

      if (expectedResult !== "pass") {
        throw new ScenarioFailure("EXPECTED_FAILURE_NOT_OBSERVED", `The case expected ${expectedResult}, but every operation passed.`);
      }
    } catch (error) {
      observedFailure = failureShape(error);
      observedResult = classifyFailure(observedFailure.code);
    } finally {
      try {
        await this.setPlayMode("stopped", 30000, undefined);
      } catch (error) {
        observedFailure ??= { code: "SCENARIO_STOP_FAILED", message: failureShape(error).message };
        observedResult = classifyFailure(observedFailure.code);
      }

      if (transactionId || applyReceipts.length > 0) {
        try {
          let restored: Record<string, unknown>;
          try {
            restored = await this.request("scenario.source_restore", { transactionId, receipts: applyReceipts }, undefined, 30000);
          } catch (error) {
            restored = await this.recoverRestoredTransaction(transactionId, 30000, error);
          }
          if (requiresDurableTransactionRecovery(restored)) {
            restored = await this.recoverRestoredTransaction(
              transactionId,
              30000,
              new ScenarioFailure(errorCode(restored, "SCENARIO_SOURCE_RESTORE_INTERRUPTED"), errorMessage(restored), restored)
            );
          }
          if (applyReceipts.length === 0) applyReceipts = arrayValue(restored.receipts).map(objectValue);
          restoreOutcomes = arrayValue(restored.outcomes).map(objectValue);
          if (restored.ok === false) throw new ScenarioFailure("SCENARIO_RESTORE_FAILED", errorMessage(restored), restored);
          const generation = numberValue(restored.requestedCompileGeneration);
          const restorationCompile = await this.waitForCompile(generation, record.definition.compileTimeoutMs ?? 60000, undefined);
          if (restorationCompile.ok === false)
            throw new ScenarioFailure("SCENARIO_RESTORE_COMPILE_FAILED", errorMessage(restorationCompile), restorationCompile);
          const hashes = await this.verifyRestoredHashes(applyReceipts);
          if (!hashes.every((item) => item.matches))
            throw new ScenarioFailure("SCENARIO_RESTORE_HASH_MISMATCH", "Source restoration was not byte-identical.", hashes);
          await this.request("scenario.source_complete", { transactionId, receipts: [...applyReceipts, ...restoreOutcomes] }, undefined, 10000);
          result.restoration = { ok: true, source: restored, compile: restorationCompile, hashes };
        } catch (error) {
          result.restoration = { ok: false, error: failureShape(error), outcomes: restoreOutcomes };
          observedFailure = { code: "SCENARIO_RESTORE_FAILED", message: failureShape(error).message, data: { originalFailure: observedFailure } };
          observedResult = "assertion-failure";
        }
      }

      if (caseState) {
        try {
          const restoredEditor = await this.request("editor.restore_snapshot", { snapshot: caseState }, undefined, 30000);
          if (restoredEditor.ok === false) throw new ScenarioFailure("SCENARIO_EDITOR_RESTORE_FAILED", errorMessage(restoredEditor), restoredEditor);
          result.restoration = { ...(result.restoration ?? { ok: true }), editor: restoredEditor };
        } catch (error) {
          result.restoration = { ...(result.restoration ?? {}), ok: false, editorError: failureShape(error) };
          observedFailure = { code: "SCENARIO_EDITOR_RESTORE_FAILED", message: failureShape(error).message, data: { originalFailure: observedFailure } };
        }
      }
    }

    const expectedMatched = failureMatchesExpected(expectedResult, definition.expectedFailureCode, observedResult, observedFailure);
    result.observedResult = observedFailure ? observedResult : "pass";
    result.observedFailure = observedFailure;
    result.failure = expectedMatched && expectedResult !== "pass" ? undefined : observedFailure;
    result.status = expectedMatched && result.restoration?.ok !== false ? "passed" : observedFailure?.code === "OPERATION_CANCELLED" ? "cancelled" : "failed";
    if (result.status === "failed" && !result.failure) {
      result.failure = { code: "SCENARIO_EXPECTATION_MISMATCH", message: `Expected ${expectedResult}, observed ${result.observedResult}.` };
    }
    result.completedUtc = new Date().toISOString();
    result.durationMs = Date.now() - started;
    return result;
  }

  private async restoreOriginalState(record: ScenarioJobRecord, originalState?: Record<string, unknown>): Promise<void> {
    await this.setPlayMode("stopped", 30000, undefined).catch(() => undefined);
    if (!originalState) return;
    const restored = await this.request("editor.restore_snapshot", { snapshot: originalState }, undefined, 30000);
    if (restored.ok === false) throw new ScenarioFailure("SCENARIO_FINAL_EDITOR_RESTORE_FAILED", errorMessage(restored), restored);
    const originalPlay = objectValue(originalState.playMode);
    const state = stringValue(originalPlay.state);
    if (state === "playing" || state === "paused") {
      await this.setPlayMode(state, 30000, undefined);
    }
  }

  private async recoverAppliedTransaction(transactionId: string, timeoutMs: number, originalError: unknown): Promise<Record<string, unknown>> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const response = await this.request("scenario.source_get", { transactionId }, undefined, Math.min(5000, timeoutMs));
        const transaction = objectValue(response.transaction);
        const status = stringValue(transaction.status);
        if (status === "applied") {
          return {
            ok: true,
            transactionId,
            status,
            requestedCompileGeneration: transaction.requestedCompileGeneration,
            receipts: transaction.receipts,
            recoveredAfterReload: true
          };
        }
        if (status === "applyFailed") {
          throw new ScenarioFailure("SCENARIO_SOURCE_APPLY_FAILED", "The durable source transaction reports an apply failure.", transaction);
        }
      } catch (error) {
        if (error instanceof ScenarioFailure && error.code === "SCENARIO_SOURCE_APPLY_FAILED") throw error;
      }
      await delay(250);
    }
    throw new ScenarioFailure(
      "SCENARIO_SOURCE_OUTCOME_UNKNOWN",
      `The source-apply response was interrupted and its durable transaction could not be recovered: ${failureShape(originalError).message}`,
      { transactionId }
    );
  }

  private async recoverRestoredTransaction(transactionId: string, timeoutMs: number, originalError: unknown): Promise<Record<string, unknown>> {
    if (!transactionId) throw originalError;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const response = await this.request("scenario.source_get", { transactionId }, undefined, Math.min(5000, timeoutMs));
        const transaction = objectValue(response.transaction);
        const status = stringValue(transaction.status);
        if (status === "restored") {
          return {
            ok: true,
            transactionId,
            status,
            requestedCompileGeneration: transaction.restoreCompileGeneration,
            receipts: transaction.receipts,
            outcomes: transaction.restoreOutcomes,
            recoveredAfterReload: true
          };
        }
        if (status === "restoreFailed") {
          throw new ScenarioFailure("SCENARIO_RESTORE_FAILED", "The durable source transaction reports a restoration failure.", transaction);
        }
        if (status === "applied" || status === "restoring") {
          try {
            const retried = await this.request(
              "scenario.source_restore",
              { transactionId },
              undefined,
              Math.min(5000, Math.max(100, timeoutMs - (Date.now() - started)))
            );
            if (retried.ok === true) return { ...retried, recoveredAfterReload: true };
            if (!requiresDurableTransactionRecovery(retried)) {
              throw new ScenarioFailure(errorCode(retried, "SCENARIO_RESTORE_FAILED"), errorMessage(retried), retried);
            }
          } catch (error) {
            if (!isAmbiguousExecutionCode(failureShape(error).code)) throw error;
          }
        }
      } catch (error) {
        if (error instanceof ScenarioFailure && error.code === "SCENARIO_RESTORE_FAILED") throw error;
      }
      await delay(250);
    }
    throw new ScenarioFailure(
      "SCENARIO_RESTORE_OUTCOME_UNKNOWN",
      `The source-restore response was interrupted and its durable transaction could not be recovered: ${failureShape(originalError).message}`,
      { transactionId }
    );
  }

  private async setPlayMode(state: "playing" | "paused" | "stopped", timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let initiated: Record<string, unknown> = {};
    let generation = 0;
    try {
      initiated = await this.request("play_mode.set", { state, saveModifiedScenes: false }, signal, timeoutMs);
      if (initiated.ok === false) {
        if (!requiresDurableTransactionRecovery(initiated)) {
          throw new ScenarioFailure(errorCode(initiated, "PLAY_MODE_TRANSITION_FAILED"), errorMessage(initiated), initiated);
        }
      } else {
        generation = numberValue(initiated.transitionGeneration);
      }
    } catch (error) {
      if (!isAmbiguousExecutionCode(failureShape(error).code)) throw error;
    }
    const started = Date.now();
    let last = initiated;
    while (Date.now() - started < timeoutMs) {
      throwIfAborted(signal);
      try {
        last = await this.request("play_mode.get", {}, signal, Math.min(5000, timeoutMs));
      } catch (error) {
        if (!isAmbiguousExecutionCode(failureShape(error).code)) throw error;
        await delay(100, signal);
        continue;
      }
      if (last.ok === false) {
        if (!requiresDurableTransactionRecovery(last)) {
          throw new ScenarioFailure(errorCode(last, "PLAY_MODE_STATUS_FAILED"), errorMessage(last), last);
        }
        await delay(100, signal);
        continue;
      }
      if (last.state === state && numberValue(last.transitionGeneration) >= generation) return last;
      await delay(100, signal);
    }
    throw new ScenarioFailure("PLAY_MODE_TRANSITION_TIMEOUT", `Timed out waiting for Play mode state '${state}'.`, last);
  }

  private async simulateInput(input: ScenarioInput, signal: AbortSignal, timeoutMs: number): Promise<Record<string, unknown>> {
    const { timeoutMs: _ignored, ...request } = input;
    const initiated = await this.request("input.simulate", request, signal, timeoutMs);
    if (initiated.ok === false) throw new ScenarioFailure(errorCode(initiated, "INPUT_SIMULATION_FAILED"), errorMessage(initiated), initiated);
    if (initiated.status !== "running") return initiated;
    const operationId = stringValue(initiated.operationId);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const status = await this.request("input.status", { operationId }, signal, timeoutMs);
      if (status.status !== "running") {
        if (status.ok === false) throw new ScenarioFailure(errorCode(status, "INPUT_DELIVERY_NOT_VERIFIED"), errorMessage(status), status);
        return status;
      }
      await delay(50, signal);
    }
    throw new ScenarioFailure("INPUT_SIMULATION_TIMEOUT", "Timed out waiting for verified input delivery.", initiated);
  }

  private async waitForCompile(generation: number, timeoutMs: number, signal?: AbortSignal, caseDeadline?: number): Promise<Record<string, unknown>> {
    if (generation <= 0) throw new ScenarioFailure("COMPILE_GENERATION_REQUIRED", "Unity did not return an exact compile generation.");
    const started = Date.now();
    let last: Record<string, unknown> = {};
    while (Date.now() - started < timeoutMs && (!caseDeadline || Date.now() < caseDeadline)) {
      throwIfAborted(signal);
      try {
        last = await this.request("compile.status_get", { requestedCompileGeneration: generation }, signal, Math.min(5000, timeoutMs));
      } catch (error) {
        if (failureShape(error).code === "OPERATION_CANCELLED") throw error;
        await delay(250, signal);
        continue;
      }
      if (last.status === "success" || last.status === "failed") return last;
      await delay(100, signal);
    }
    throw new ScenarioFailure("COMPILE_GENERATION_TIMEOUT", `Timed out waiting for compile generation ${generation}.`, last);
  }

  private async waitForConsole(assertion: ScenarioConsoleAssertion, signal: AbortSignal, caseDeadline: number): Promise<Record<string, unknown>> {
    const timeoutMs = Math.min(assertion.timeoutMs ?? 30000, this.remaining(caseDeadline));
    const started = Date.now();
    const { timeoutMs: _ignored, ...query } = assertion;
    let last: Record<string, unknown> = {};
    while (Date.now() - started < timeoutMs) {
      last = await this.request("console.query", query, signal, Math.min(5000, timeoutMs));
      if (last.ok === false) throw new ScenarioFailure(errorCode(last, "CONSOLE_QUERY_FAILED"), errorMessage(last), last);
      if (last.matched === true) return last;
      if (arrayValue(last.unexpectedErrors).length > 0) {
        throw new ScenarioFailure("UNEXPECTED_CONSOLE_ERROR", "An unexpected Unity Console error appeared after the case boundary.", last);
      }
      await delay(100, signal);
    }
    throw new ScenarioFailure("CONSOLE_WAIT_TIMEOUT", "Timed out waiting for the declared Console assertion.", last);
  }

  private async captureScreenshot(
    record: ScenarioJobRecord,
    caseId: string,
    assertion: ScenarioScreenshotAssertion,
    signal: AbortSignal,
    deadline: number
  ): Promise<Record<string, unknown>> {
    const capture = await this.request(
      "screenshot.capture",
      {
        label: assertion.label,
        mode: assertion.mode ?? "auto",
        width: assertion.width ?? 1280,
        height: assertion.height ?? 720,
        superSize: assertion.superSize ?? 1,
        dryRun: false
      },
      signal,
      this.remaining(deadline)
    );
    if (capture.ok === false) throw new ScenarioFailure(errorCode(capture, "SCREENSHOT_CAPTURE_FAILED"), errorMessage(capture), capture);
    const sourcePath = stringValue(capture.path);
    const extension = sourcePath.toLowerCase().endsWith(".png") ? ".png" : ".bin";
    const fileName = `${safeSegment(caseId)}-${safeSegment(assertion.label)}${extension}`;
    const destination = this.safeEvidencePath(record, join("screenshots", fileName));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(sourcePath, destination);
    const result: Record<string, unknown> = {
      capture,
      evidencePath: destination,
      evidenceUri: `unity://evidence/${record.operationId}/screenshots/${fileName}`
    };
    if (assertion.baselinePath) {
      const diff = await this.request(
        "screenshot.diff",
        {
          baselinePath: assertion.baselinePath,
          currentPath: sourcePath,
          dimensionMode: assertion.dimensionMode ?? "reject",
          threshold: assertion.threshold ?? 0.02,
          maxSamples: assertion.maxSamples ?? 20000
        },
        signal,
        this.remaining(deadline)
      );
      result.diff = diff;
      if (diff.ok === false || diff.withinThreshold === false) {
        throw new ScenarioFailure(errorCode(diff, "SCREENSHOT_ASSERTION_FAILED"), errorMessage(diff, "Screenshot exceeded the declared tolerance."), diff);
      }
    }
    return result;
  }

  private async verifyRestoredHashes(
    receipts: Record<string, unknown>[]
  ): Promise<Array<{ path: string; expectedSha256: string; observedSha256: string; matches: boolean }>> {
    const results = [];
    for (const receipt of receipts) {
      const path = stringValue(receipt.path);
      const expectedSha256 = stringValue(receipt.beforeSha256);
      if (receipt.created === true) {
        const fullPath = this.safeProjectPath(path);
        let exists = true;
        try {
          await stat(fullPath);
        } catch {
          exists = false;
        }
        results.push({ path, expectedSha256, observedSha256: exists ? "present" : expectedSha256, matches: !exists });
      } else {
        const read = await this.request("script.read", { path }, undefined, 10000);
        const observedSha256 = stringValue(read.sha256);
        results.push({ path, expectedSha256, observedSha256, matches: observedSha256 === expectedSha256 });
      }
    }
    return results;
  }

  private async writeDiffs(record: ScenarioJobRecord, caseId: string, receipts: Record<string, unknown>[]): Promise<void> {
    for (let index = 0; index < receipts.length; index += 1) {
      const receipt = receipts[index];
      const fileName = `${safeSegment(caseId)}-${index + 1}-${safeSegment(basename(stringValue(receipt.path)))}.diff`;
      const path = this.safeEvidencePath(record, join("diffs", fileName));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, redactSecrets(stringValue(receipt.diff)), "utf8");
    }
  }

  private async writeEvidence(record: ScenarioJobRecord): Promise<void> {
    await mkdir(record.evidenceDirectory, { recursive: true });
    const commit = await readGitCommit(this.projectPath!);
    const manifest = {
      schemaVersion: 1,
      operationId: record.operationId,
      name: record.name,
      status: record.status,
      packageVersion: PackageVersion,
      commit,
      unityVersion: stringValue(record.health?.unityVersion),
      projectId: record.projectId,
      editorInstanceId: record.editorInstanceId,
      scenePath: record.definition.scenePath,
      createdUtc: record.createdUtc,
      completedUtc: record.completedUtc ?? null,
      scenarioIds: record.definition.cases.map((item) => item.id),
      expectedOutcomes: Object.fromEntries(record.definition.cases.map((item) => [item.id, item.expectedResult ?? "pass"])),
      inputs: redactDefinition(record.definition),
      observedOutcomes: Object.fromEntries(record.cases.map((item) => [item.id, item.observedResult ?? item.status])),
      durationsMs: Object.fromEntries(record.cases.map((item) => [item.id, item.durationMs ?? null])),
      restorationComplete: record.restorationComplete,
      restorationHashes: record.cases.flatMap((item) => arrayValue(objectValue(item.restoration).hashes)),
      failure: record.failure ?? null
    };
    const compiler = record.cases.map((item) => ({ caseId: item.id, compile: item.compile, restorationCompile: objectValue(item.restoration).compile }));
    const console = record.cases.map((item) => ({ caseId: item.id, boundary: item.consoleBoundary, assertions: item.consoleAssertions }));
    await this.atomicWrite(this.safeEvidencePath(record, "manifest.json"), JSON.stringify(manifest, null, 2));
    await this.atomicWrite(
      this.safeEvidencePath(record, "scenario-results.json"),
      JSON.stringify({ ...record, definition: redactDefinition(record.definition) }, null, 2)
    );
    await this.atomicWrite(this.safeEvidencePath(record, "compiler.json"), JSON.stringify(compiler, null, 2));
    await this.atomicWrite(this.safeEvidencePath(record, "console.json"), JSON.stringify(console, null, 2));
    const rows = record.cases.map(
      (item) => `| ${item.id} | ${item.expectedResult} | ${item.observedResult ?? "-"} | ${item.status} | ${item.durationMs ?? "-"} |`
    );
    const summary = `# ${record.name}\n\nStatus: **${record.status}**\n\nProject: \`${record.projectId}\`  \nUnity: \`${stringValue(record.health?.unityVersion) || "unknown"}\`  \nCommit: \`${commit}\`  \nRestoration complete: **${record.restorationComplete}**\n\n| Case | Expected | Observed | Result | Duration (ms) |\n|---|---|---|---|---:|\n${rows.join("\n")}\n`;
    await this.atomicWrite(this.safeEvidencePath(record, "summary.md"), summary);
  }

  private evidenceHandles(record: ScenarioJobRecord): Array<{ name: string; path: string; uri: string }> {
    return [...evidenceFiles]
      .sort()
      .map((name) => ({ name, path: this.safeEvidencePath(record, name), uri: `unity://evidence/${record.operationId}/${name}` }));
  }

  private async artifactHandles(record: ScenarioJobRecord): Promise<Array<{ name: string; path: string; uri: string }>> {
    const handles: Array<{ name: string; path: string; uri: string }> = [];
    for (const kind of ["diffs", "screenshots"] as const) {
      const directory = this.safeEvidencePath(record, kind);
      const files = await readdir(directory).catch(() => []);
      for (const file of files.sort()) {
        const path = this.safeEvidencePath(record, join(kind, file));
        handles.push({ name: `${kind}/${file}`, path, uri: `unity://evidence/${record.operationId}/${kind}/${file}` });
      }
    }
    return handles;
  }

  private async ensureRecovered(): Promise<void> {
    this.recovery ??= this.recoverInterrupted();
    await this.recovery;
  }

  private async recoverInterrupted(): Promise<void> {
    if (!this.available) return;
    await mkdir(this.jobsRoot!, { recursive: true });
    await mkdir(this.evidenceRoot!, { recursive: true });
    const files = (await readdir(this.jobsRoot!)).filter((name) => name.endsWith(".json"));
    for (const file of files) {
      const record = await this.loadPath(join(this.jobsRoot!, file));
      if (!record || terminalStatuses.has(record.status)) continue;
      await this.recoverInterruptedJob(record);
    }
  }

  private async recoverInterruptedJob(record: ScenarioJobRecord): Promise<void> {
    record.phase = "recovery-restoring";
    await this.save(record);
    try {
      await this.setPlayMode("stopped", 30000, undefined).catch(() => undefined);
      const active = record.activeCase;
      let receipts = arrayValue(active?.sourceApply?.receipts).map(objectValue);
      const transactionId = stringValue(active?.sourceApply?.transactionId);
      if (active && (receipts.length > 0 || transactionId) && active.restoration?.ok !== true) {
        let restored: Record<string, unknown>;
        try {
          restored = await this.request("scenario.source_restore", { transactionId, receipts }, undefined, 30000);
        } catch (error) {
          restored = await this.recoverRestoredTransaction(transactionId, 30000, error);
        }
        if (requiresDurableTransactionRecovery(restored)) {
          restored = await this.recoverRestoredTransaction(
            transactionId,
            30000,
            new ScenarioFailure(errorCode(restored, "SCENARIO_SOURCE_RESTORE_INTERRUPTED"), errorMessage(restored), restored)
          );
        }
        if (receipts.length === 0) receipts = arrayValue(restored.receipts).map(objectValue);
        if (restored.ok === false) throw new ScenarioFailure("SCENARIO_RECOVERY_RESTORE_FAILED", errorMessage(restored), restored);
        const restorationCompile = await this.waitForCompile(numberValue(restored.requestedCompileGeneration), record.definition.compileTimeoutMs ?? 60000);
        if (restorationCompile.ok === false)
          throw new ScenarioFailure("SCENARIO_RECOVERY_COMPILE_FAILED", errorMessage(restorationCompile), restorationCompile);
        const outcomes = arrayValue(restored.outcomes).map(objectValue);
        const hashes = await this.verifyRestoredHashes(receipts);
        if (!hashes.every((item) => item.matches))
          throw new ScenarioFailure("SCENARIO_RECOVERY_HASH_MISMATCH", "Interrupted scenario sources were not restored byte-identically.", hashes);
        await this.request("scenario.source_complete", { transactionId, receipts: [...receipts, ...outcomes] }, undefined, 10000);
        active.restoration = { ok: true, source: restored, compile: restorationCompile, hashes, recovered: true };
      }
      if (active?.startingState) {
        const restoredCase = await this.request("editor.restore_snapshot", { snapshot: active.startingState }, undefined, 30000);
        if (restoredCase.ok === false) throw new ScenarioFailure("SCENARIO_RECOVERY_EDITOR_RESTORE_FAILED", errorMessage(restoredCase), restoredCase);
      }
      if (record.originalState) {
        await this.restoreOriginalState(record, record.originalState);
      }
      record.restorationComplete = true;
      record.status = "failed";
      record.phase = "recovered-after-server-restart";
      record.failure = {
        code: "SCENARIO_SERVER_RESTARTED",
        message: "The MCP server restarted during the scenario. Ghost restored the last durable source/editor snapshot; retry with a new operation."
      };
    } catch (error) {
      record.restorationComplete = false;
      record.status = "outcomeUnknown";
      record.phase = "recovery-restore-failed";
      record.failure = {
        code: "SCENARIO_RECOVERY_RESTORE_FAILED",
        message: failureShape(error).message,
        data: { originalOperation: record.operationId }
      };
    }
    record.completedUtc = new Date().toISOString();
    await this.writeEvidence(record).catch(() => undefined);
    await this.save(record);
  }

  private async request(method: string, params: unknown, signal?: AbortSignal, timeoutMs = 30000): Promise<Record<string, unknown>> {
    throwIfAborted(signal);
    try {
      return objectValue(await this.options.unity.request(method, params, { signal, timeoutMs }));
    } catch (error) {
      if (signal?.aborted) throw new ScenarioFailure("OPERATION_CANCELLED", "Scenario cancellation was requested.");
      throw error;
    }
  }

  private checkCancellation(record: ScenarioJobRecord, signal: AbortSignal): void {
    if (record.cancelRequested || signal.aborted) throw new ScenarioFailure("OPERATION_CANCELLED", "Scenario cancellation was requested.");
  }

  private remaining(deadline: number, fallback?: number): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ScenarioFailure("SCENARIO_CASE_TIMEOUT", "Scenario case exceeded its declared timeout.");
    return Math.max(100, fallback === undefined ? remaining : Math.min(remaining, fallback));
  }

  private summary(record: ScenarioJobRecord): Record<string, unknown> {
    return {
      ok: record.status === "running" || record.status === "cancelling" || record.status === "success",
      operationId: record.operationId,
      kind: record.kind,
      name: record.name,
      status: record.status,
      phase: record.phase,
      currentCaseIndex: record.currentCaseIndex,
      caseCount: record.definition.cases.length,
      cancelRequested: record.cancelRequested,
      restorationRequired: record.restorationRequired,
      restorationComplete: record.restorationComplete,
      updatedUtc: record.updatedUtc,
      evidenceDirectory: record.evidenceDirectory
    };
  }

  private envelope(record: ScenarioJobRecord): Record<string, unknown> {
    return { ...this.summary(record), cases: record.cases, activeCase: record.activeCase ?? null, error: record.failure ?? null };
  }

  private requireAvailable(): void {
    if (!this.available) {
      throw new ScenarioFailure(
        "SCENARIO_PROJECT_PATH_REQUIRED",
        "Scenario jobs require the MCP server to start with --unity-project-path so receipts and evidence remain inside the pinned project."
      );
    }
  }

  private jobPath(operationId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(operationId)) throw new ScenarioFailure("INVALID_OPERATION_ID", "Scenario operationId is malformed.");
    return join(this.jobsRoot!, `${operationId}.json`);
  }

  private async save(record: ScenarioJobRecord): Promise<void> {
    record.updatedUtc = new Date().toISOString();
    await mkdir(this.jobsRoot!, { recursive: true });
    await this.atomicWrite(this.jobPath(record.operationId), JSON.stringify(record, null, 2));
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, contents, "utf8");
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(path, { force: true });
      await rename(temporary, path).catch(async (renameError) => {
        await rm(temporary, { force: true });
        throw renameError ?? error;
      });
    }
  }

  private async loadRequired(operationId: string): Promise<ScenarioJobRecord> {
    const record = await this.loadPath(this.jobPath(operationId));
    if (!record) throw new ScenarioFailure("SCENARIO_OPERATION_NOT_FOUND", `Unknown scenario operation: ${operationId}`);
    return record;
  }

  private async loadPath(path: string): Promise<ScenarioJobRecord | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as ScenarioJobRecord;
    } catch {
      return undefined;
    }
  }

  private safeEvidenceDirectory(operationId: string): string {
    return ensureContained(join(this.evidenceRoot!, operationId), this.evidenceRoot!);
  }

  private safeEvidencePath(record: ScenarioJobRecord, file: string): string {
    return ensureContained(join(record.evidenceDirectory, file), record.evidenceDirectory);
  }

  private safeProjectPath(assetPath: string): string {
    return ensureContained(join(this.projectPath!, assetPath.replaceAll("/", sep)), this.projectPath!);
  }
}

export class ScenarioFailure extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
  }
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

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorCode(value: Record<string, unknown>, fallback: string): string {
  return stringValue(objectValue(value.error).code) || fallback;
}

function errorMessage(value: Record<string, unknown>, fallback = "Unity scenario operation failed."): string {
  return stringValue(objectValue(value.error).message) || fallback;
}

function requiresDurableTransactionRecovery(value: Record<string, unknown>): boolean {
  if (value.ok !== false) return false;
  return isAmbiguousExecutionCode(errorCode(value, ""));
}

function isAmbiguousExecutionCode(code: string): boolean {
  const normalized = code.toUpperCase();
  return normalized === "EXECUTING" || normalized === "OUTCOME_UNKNOWN" || normalized === "REQUEST_EXECUTION_IN_PROGRESS";
}

function isErrorDiagnostic(value: unknown): boolean {
  return stringValue(objectValue(value).severity).toLowerCase() === "error";
}

function failureShape(error: unknown): ScenarioFailureShape {
  if (error instanceof ScenarioFailure) return { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) };
  const value = objectValue(error);
  const data = objectValue(value.data);
  return {
    code: stringValue(value.code) || stringValue(data.code) || "SCENARIO_INFRASTRUCTURE_FAILED",
    message: error instanceof Error ? error.message : String(error),
    ...(value.data === undefined ? {} : { data: value.data })
  };
}

function classifyFailure(code: string): ScenarioExpectedResult {
  const normalized = code.toUpperCase();
  if (normalized.includes("CANCEL")) return "cancelled";
  if (normalized.includes("TIMEOUT")) return "timeout";
  if (normalized.includes("COMPILE")) return "compile-failure";
  return "assertion-failure";
}

function failureMatchesExpected(
  expected: ScenarioExpectedResult,
  expectedCode: string | undefined,
  observed: ScenarioExpectedResult,
  failure: ScenarioFailureShape | undefined
): boolean {
  if (expected === "pass") return failure === undefined;
  if (!failure || observed !== expected) return false;
  return !expectedCode || failure.code === expectedCode;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ScenarioFailure("OPERATION_CANCELLED", "Scenario cancellation was requested.");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    const complete = () => {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    };
    const timer = setTimeout(complete, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new ScenarioFailure("OPERATION_CANCELLED", "Scenario cancellation was requested."));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 100) || "item";
}

function ensureContained(candidate: string, root: string): string {
  const normalizedRoot = resolve(root);
  const normalized = resolve(candidate);
  const relation = relative(normalizedRoot, normalized);
  if (relation.startsWith("..") || isAbsolute(relation))
    throw new ScenarioFailure("PATH_OUTSIDE_EVIDENCE_ROOT", "Resolved path escaped its fixed scenario directory.");
  return normalized;
}

function redactSecrets(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)([^\s"']+)/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?)([^\s"']+)/gi, "$1[REDACTED]");
}

function redactDefinition(definition: ScenarioMatrixDefinition): unknown {
  return {
    ...definition,
    cases: definition.cases.map((item) => ({
      ...item,
      sourceMutations: item.sourceMutations?.map((mutation) => ({
        path: mutation.path,
        expectedSha256: mutation.expectedSha256,
        contentSha256: createHash("sha256").update(mutation.content, "utf8").digest("hex"),
        contentBytes: Buffer.byteLength(mutation.content, "utf8")
      }))
    }))
  };
}

async function readGitCommit(projectPath: string): Promise<string> {
  try {
    let repositoryRoot = resolve(projectPath);
    while (dirname(repositoryRoot) !== repositoryRoot) {
      try {
        await stat(join(repositoryRoot, ".git"));
        break;
      } catch {
        repositoryRoot = dirname(repositoryRoot);
      }
    }
    let gitDirectory = join(repositoryRoot, ".git");
    const dotGit = await readFile(gitDirectory, "utf8").catch(() => undefined);
    if (dotGit?.startsWith("gitdir:")) gitDirectory = resolve(projectPath, dotGit.slice("gitdir:".length).trim());
    const head = (await readFile(join(gitDirectory, "HEAD"), "utf8")).trim();
    if (!head.startsWith("ref:")) return head;
    const reference = head.slice("ref:".length).trim();
    const direct = await readFile(join(gitDirectory, reference), "utf8").catch(() => undefined);
    if (direct) return direct.trim();
    const packed = await readFile(join(gitDirectory, "packed-refs"), "utf8");
    return (
      packed
        .split(/\r?\n/)
        .find((line) => line.endsWith(` ${reference}`))
        ?.split(" ")[0] ?? "unknown"
    );
  } catch {
    return "unknown";
  }
}
