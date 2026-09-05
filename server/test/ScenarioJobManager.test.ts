import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ScenarioJobManager } from "../src/scenario/ScenarioJobManager.js";
import type { UnityClient } from "../src/unity/UnityClient.js";

describe("durable scenario matrix jobs", () => {
  it("runs a case, restores editor state, and writes deterministic evidence files", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-"));
    const fake = new FakeScenarioUnity();
    const manager = new ScenarioJobManager({
      unity: fake as unknown as UnityClient,
      projectPath,
      projectId: "project-1",
      editorInstanceId: "editor-1"
    });

    try {
      const started = await manager.start({
        name: "fixture pass",
        scenePath: "Assets/Fixture.unity",
        cases: [
          {
            id: "page-up",
            inputs: [{ device: "keyboard", action: "tap", key: "PageUp" }],
            consoleAssertions: [{ exact: "PAGE:1", count: 1 }],
            objectAssertions: [{ name: "Fixture", component: "FixtureDriver", propertyPath: "Page", equals: 1 }]
          }
        ]
      });
      const operationId = String(started.operationId);
      const completed = await waitForTerminal(manager, operationId);

      assert.equal(completed.status, "success");
      assert.equal(completed.restorationComplete, true);
      assert.equal(fake.restoreCount, 2);
      const bundle = await manager.createEvidence(operationId);
      const directory = String(bundle.directory);
      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Record<string, unknown>;
      assert.equal(manifest.status, "success");
      assert.equal(manifest.projectId, "project-1");
      assert.deepEqual(manifest.scenarioIds, ["page-up"]);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("cancels a waiting case and still restores the editor snapshot", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-cancel-"));
    const fake = new FakeScenarioUnity();
    fake.consoleMatches = false;
    const manager = new ScenarioJobManager({
      unity: fake as unknown as UnityClient,
      projectPath,
      projectId: "project-1",
      editorInstanceId: "editor-1"
    });

    try {
      const started = await manager.start({
        name: "cancel fixture",
        scenePath: "Assets/Fixture.unity",
        cases: [{ id: "wait", consoleAssertions: [{ exact: "never", timeoutMs: 30000 }] }]
      });
      const operationId = String(started.operationId);
      await waitUntil(() => fake.consoleQueries > 0);
      await manager.cancel(operationId);
      const completed = await waitForTerminal(manager, operationId);

      assert.equal(completed.status, "cancelled");
      assert.equal(completed.restorationComplete, true);
      assert.ok(fake.restoreCount >= 2);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects a second scenario while the project/editor lease is active", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-lease-"));
    const fake = new FakeScenarioUnity();
    fake.consoleMatches = false;
    const manager = new ScenarioJobManager({ unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" });

    try {
      const first = await manager.start({
        name: "lease owner",
        scenePath: "Assets/Fixture.unity",
        cases: [{ id: "waiting", consoleAssertions: [{ exact: "never", timeoutMs: 30000 }] }]
      });
      await waitUntil(() => fake.consoleQueries > 0);
      const leasePath = join(projectPath, "Library", "UnityMcpGhost", "scenario-jobs", "active-scenario-lease.json");
      const lease = JSON.parse(await readFile(leasePath, "utf8")) as Record<string, unknown>;
      await writeFile(leasePath, JSON.stringify({ ...lease, expiresUnixMs: 0 }), "utf8");
      const contender = new ScenarioJobManager({
        unity: fake as unknown as UnityClient,
        projectPath,
        projectId: "project-1",
        editorInstanceId: "editor-1"
      });

      await assert.rejects(
        contender.start({ name: "overlap", scenePath: "Assets/Fixture.unity", cases: [{ id: "overlap" }] }),
        (error: unknown) => (error as { code?: string }).code === "SCENARIO_ALREADY_RUNNING"
      );

      await manager.cancel(String(first.operationId));
      const completed = await waitForTerminal(manager, String(first.operationId));
      assert.equal(completed.restorationComplete, true);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("recovers durable source apply and restore receipts when reload retries report EXECUTING", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-reload-"));
    const sourcePath = "Assets/Fixture.cs";
    const sourceFullPath = join(projectPath, sourcePath);
    const original = "public sealed class Fixture {}\n";
    const mutated = "public sealed class Fixture { /* scenario */ }\n";
    await mkdir(join(projectPath, "Assets"), { recursive: true });
    await writeFile(sourceFullPath, original, "utf8");
    const fake = new ReloadRaceScenarioUnity(sourceFullPath, sourcePath, original, mutated);
    fake.playGetTransientFailures = 1;
    const manager = new ScenarioJobManager({
      unity: fake as unknown as UnityClient,
      projectPath,
      projectId: "project-1",
      editorInstanceId: "editor-1"
    });

    try {
      const started = await manager.start({
        name: "reload receipt recovery",
        scenePath: "Assets/Fixture.unity",
        cases: [
          {
            id: "reload",
            sourceMutations: [{ path: sourcePath, content: mutated, expectedSha256: sha256(original) }]
          }
        ]
      });
      const completed = await waitForTerminal(manager, String(started.operationId));
      const caseRecord = (completed.cases as Array<Record<string, unknown>>)[0];
      const restoration = caseRecord.restoration as Record<string, Record<string, unknown>>;

      assert.equal(completed.status, "success");
      assert.equal((caseRecord.sourceApply as Record<string, unknown>).recoveredAfterReload, true);
      assert.equal(restoration.source.recoveredAfterReload, true);
      assert.equal(await readFile(sourceFullPath, "utf8"), original);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("retries a durable restore when reload loses the first queued invocation", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-lost-restore-"));
    const sourcePath = "Assets/Fixture.cs";
    const sourceFullPath = join(projectPath, sourcePath);
    const original = "public sealed class Fixture {}\n";
    const mutated = "public sealed class Fixture { /* scenario */ }\n";
    await mkdir(join(projectPath, "Assets"), { recursive: true });
    await writeFile(sourceFullPath, original, "utf8");
    const fake = new LostRestoreScenarioUnity(sourceFullPath, sourcePath, original, mutated);
    const manager = new ScenarioJobManager({
      unity: fake as unknown as UnityClient,
      projectPath,
      projectId: "project-1",
      editorInstanceId: "editor-1"
    });

    try {
      const started = await manager.start({
        name: "lost restore retry",
        scenePath: "Assets/Fixture.unity",
        cases: [{ id: "retry", sourceMutations: [{ path: sourcePath, content: mutated, expectedSha256: sha256(original) }] }]
      });
      const completed = await waitForTerminal(manager, String(started.operationId));

      assert.equal(completed.status, "success");
      assert.equal(fake.restoreAttempts, 2);
      assert.equal(await readFile(sourceFullPath, "utf8"), original);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("removes source credentials from durable records and every evidence document", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-redaction-"));
    const sourcePath = "Assets/Fixture.cs";
    const sourceFullPath = join(projectPath, sourcePath);
    const original = "public sealed class Fixture {}\n";
    const mutated = 'public sealed class Fixture { const string token = "super-secret"; }\n';
    await mkdir(join(projectPath, "Assets"), { recursive: true });
    await writeFile(sourceFullPath, original, "utf8");
    const fake = new ReloadRaceScenarioUnity(sourceFullPath, sourcePath, original, mutated);
    const manager = new ScenarioJobManager({ unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" });

    try {
      const started = await manager.start({
        name: "redaction",
        scenePath: "Assets/Fixture.unity",
        cases: [{ id: "secret", sourceMutations: [{ path: sourcePath, content: mutated, expectedSha256: sha256(original) }] }]
      });
      const operationId = String(started.operationId);
      const completed = await waitForTerminal(manager, operationId);
      assert.equal(completed.status, "success");
      await manager.createEvidence(operationId);

      const evidenceDirectory = join(projectPath, "Library", "UnityMcpGhost", "evidence", operationId);
      for (const name of ["manifest.json", "scenario-results.json", "compiler.json", "console.json", "summary.md"]) {
        assert.doesNotMatch(await readFile(join(evidenceDirectory, name), "utf8"), /super-secret/);
      }
      assert.doesNotMatch(await readFile(join(projectPath, "Library", "UnityMcpGhost", "scenario-jobs", `${operationId}.json`), "utf8"), /super-secret/);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});

class FakeScenarioUnity {
  public state = "stopped";
  public generation = 0;
  public restoreCount = 0;
  public consoleMatches = true;
  public consoleQueries = 0;
  public playGetTransientFailures = 0;

  public async request(method: string, params: unknown = {}): Promise<unknown> {
    const values = params as Record<string, unknown>;
    switch (method) {
      case "health":
        return { ok: true, unityVersion: "2022.3.62f1", projectId: "project-1", editorInstanceId: "editor-1" };
      case "editor.snapshot":
        return {
          ok: true,
          playMode: { ok: true, state: this.state, transitionGeneration: this.generation },
          sceneSetup: [{ path: "Assets/Original.unity", isLoaded: true, isActive: true }],
          dirtyScenes: [],
          selectionGlobalObjectIds: []
        };
      case "editor.restore_snapshot":
        this.restoreCount++;
        return { ok: true, restored: true };
      case "scene.open":
        return { ok: true, scene: { path: values.path } };
      case "play_mode.set":
        this.state = String(values.state);
        this.generation++;
        return { ok: true, state: this.state, requestedState: this.state, transitionGeneration: this.generation };
      case "play_mode.get":
        if (this.playGetTransientFailures > 0) {
          this.playGetTransientFailures--;
          throw Object.assign(new Error("The request is already executing."), {
            code: "EXECUTING",
            data: { code: "EXECUTING", outcomeUnknown: true }
          });
        }
        return { ok: true, state: this.state, transitionGeneration: this.generation };
      case "console.mark":
        return { ok: true, boundary: "boundary-1" };
      case "console.query":
        this.consoleQueries++;
        return { ok: true, matched: this.consoleMatches, entries: this.consoleMatches ? [{ message: "PAGE:1" }] : [], unexpectedErrors: [] };
      case "input.simulate":
        return { ok: true, status: "completed", backend: "project-test-driver:fixture", pressObserved: true, releaseObserved: true };
      case "runtime.inspect":
        return { ok: true, matched: false, observed: 0 };
      case "runtime.assert":
        return { ok: true, matched: true, observed: 1 };
      default:
        throw new Error(`Unexpected fake Unity method: ${method}`);
    }
  }
}

class ReloadRaceScenarioUnity extends FakeScenarioUnity {
  private transactionStatus: "missing" | "applied" | "restored" = "missing";
  private readonly receipt: Record<string, unknown>;

  public constructor(
    private readonly sourceFullPath: string,
    sourcePath: string,
    private readonly original: string,
    private readonly mutated: string
  ) {
    super();
    this.receipt = {
      ok: true,
      path: sourcePath,
      created: false,
      beforeSha256: sha256(original),
      afterSha256: sha256(mutated),
      diff: `--- before\n+++ after\n-${original}+${mutated}`
    };
  }

  public override async request(method: string, params: unknown = {}): Promise<unknown> {
    switch (method) {
      case "scenario.source_apply":
        await writeFile(this.sourceFullPath, this.mutated, "utf8");
        this.generation++;
        this.transactionStatus = "applied";
        return { ok: false, error: { code: "EXECUTING", message: "The request is already executing." } };
      case "scenario.source_get":
        return {
          ok: true,
          transaction: {
            status: this.transactionStatus,
            requestedCompileGeneration: 1,
            restoreCompileGeneration: 2,
            receipts: [this.receipt],
            restoreOutcomes: [{ ok: true, path: this.receipt.path, restoredSha256: this.receipt.beforeSha256 }]
          }
        };
      case "scenario.source_restore":
        await writeFile(this.sourceFullPath, this.original, "utf8");
        this.generation++;
        this.transactionStatus = "restored";
        return { ok: false, error: { code: "EXECUTING", message: "The request is already executing." } };
      case "scenario.source_complete":
        return { ok: true, completed: true };
      case "compile.status_get":
        return { ok: true, status: "success", requestedCompileGeneration: this.generation, diagnostics: [] };
      case "script.read":
        return { ok: true, path: this.receipt.path, sha256: sha256(await readFile(this.sourceFullPath, "utf8")) };
      default:
        return super.request(method, params);
    }
  }
}

class LostRestoreScenarioUnity extends ReloadRaceScenarioUnity {
  public restoreAttempts = 0;

  public override async request(method: string, params: unknown = {}): Promise<unknown> {
    if (method === "scenario.source_restore") {
      this.restoreAttempts++;
      if (this.restoreAttempts === 1) {
        return { ok: false, error: { code: "EXECUTING", message: "The queued restore was lost during reload." } };
      }
    }
    return super.request(method, params);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function waitForTerminal(manager: ScenarioJobManager, operationId: string): Promise<Record<string, unknown>> {
  let state: Record<string, unknown> = {};
  await waitUntil(async () => {
    state = await manager.get(operationId);
    return ["success", "failed", "cancelled", "outcomeUnknown"].includes(String(state.status));
  });
  return state;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for scenario job test state.");
}
