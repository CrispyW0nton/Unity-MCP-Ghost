import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { access, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ScenarioJobManager, type ScenarioJobRecord } from "../src/scenario/ScenarioJobManager.js";
import type { UnityClient } from "../src/unity/UnityClient.js";

describe("durable scenario matrix jobs", () => {
  it("closes admission immediately but drains a start still acquiring its lease", async (context) => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-drain-start-"));
    const fake = new FakeScenarioUnity();
    const manager = new ScenarioJobManager({ unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" });
    const acquiring = deferred();
    const allowAcquire = deferred();
    const acquire = internals(manager).acquireLease.bind(manager);
    context.mock.method(internals(manager), "acquireLease", async (id: string) => {
      acquiring.resolve();
      await allowAcquire.promise;
      await acquire(id);
    });
    const definition = { name: "drain start", scenePath: "Assets/Fixture.unity", cases: [{ id: "green" }] };
    const starting = manager.start(definition);
    let closing: ReturnType<ScenarioJobManager["close"]> | undefined;
    try {
      await acquiring.promise;
      closing = manager.close();
      assert.equal(manager.close(), closing);
      let settled = false;
      void closing.then(() => {
        settled = true;
      });
      await assert.rejects(manager.start(definition), { code: "SCENARIO_MANAGER_CLOSED" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      allowAcquire.resolve();
      const receipt = await starting;
      assert.deepEqual(await closing, { outcomeUnknown: false });
      assert.equal((await manager.get(String(receipt.operationId))).status, "success");
      assert.equal(fake.restoreCount, 2);
      await assert.rejects(access(join(projectPath, "Library", "UnityMcpGhost", "scenario-jobs", "active-scenario-lease.json")), { code: "ENOENT" });
    } finally {
      allowAcquire.resolve();
      await starting;
      await closing;
      await removeTestProject(projectPath);
    }
  });

  it("drains recovery triggered by a read through terminal persistence and lease release", async (context) => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-drain-recovery-"));
    const fake = new FakeScenarioUnity();
    const options = { unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" };
    const first = new ScenarioJobManager(options);
    const started = await first.start({ name: "interrupted", scenePath: "Assets/Fixture.unity", cases: [{ id: "green" }] });
    await first.close();
    const operationId = String(started.operationId);
    const jobsRoot = join(projectPath, "Library", "UnityMcpGhost", "scenario-jobs");
    const jobPath = join(jobsRoot, `${operationId}.json`);
    const previous = JSON.parse(await readFile(jobPath, "utf8")) as ScenarioJobRecord;
    await writeFile(
      jobPath,
      JSON.stringify({ ...previous, status: "running", phase: "restoring-original-state", restorationComplete: false, completedUtc: undefined })
    );
    const recovering = deferred();
    const allowRecovery = deferred();
    const request = fake.request.bind(fake);
    context.mock.method(fake, "request", async (method: string, params: unknown) => {
      if (method === "editor.restore_snapshot") {
        recovering.resolve();
        await allowRecovery.promise;
      }
      return request(method, params);
    });
    const manager = new ScenarioJobManager(options);
    const reading = manager.get(operationId);
    let closing: ReturnType<ScenarioJobManager["close"]> | undefined;
    try {
      await recovering.promise;
      let settled = false;
      closing = manager.close();
      void closing.then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      await access(join(jobsRoot, "active-scenario-lease.json"));
      allowRecovery.resolve();
      assert.deepEqual(await closing, { outcomeUnknown: false });
      assert.equal((await reading).phase, "recovered-after-server-restart");
      const terminal = JSON.parse(await readFile(jobPath, "utf8")) as ScenarioJobRecord;
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.restorationComplete, true);
      await assert.rejects(access(join(jobsRoot, "active-scenario-lease.json")), { code: "ENOENT" });
    } finally {
      allowRecovery.resolve();
      await reading;
      await closing;
      await removeTestProject(projectPath);
    }
  });

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

      assert.equal(completed.status, "success", JSON.stringify(completed.error));
      assert.equal(completed.restorationComplete, true);
      assert.equal(fake.restoreCount, 2);
      const bundle = await manager.createEvidence(operationId);
      const directory = String(bundle.directory);
      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Record<string, unknown>;
      assert.equal(manifest.status, "success");
      assert.equal(manifest.projectId, "project-1");
      assert.deepEqual(manifest.scenarioIds, ["page-up"]);
    } finally {
      await removeTestProject(projectPath);
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

      assert.equal(completed.status, "cancelled", JSON.stringify(completed.error));
      assert.equal(completed.restorationComplete, true);
      assert.ok(fake.restoreCount >= 2);
      await assert.rejects(access(join(projectPath, "Library", "UnityMcpGhost", "scenario-jobs", "active-scenario-lease.json")), {
        code: "ENOENT"
      });
    } finally {
      await removeTestProject(projectPath);
    }
  });

  for (const code of ["EPERM", "ENOSPC"]) {
    it(`preserves the previous durable record when atomic replacement fails with ${code}`, async (context) => {
      const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-replace-failure-"));
      const path = join(projectPath, "record.json");
      const manager = new ScenarioJobManager({ unity: new FakeScenarioUnity() as unknown as UnityClient });
      await writeFile(path, '{"status":"running"}', "utf8");
      let attempts = 0;
      context.mock.method(internals(manager), "replaceFile", async () => {
        attempts++;
        throw Object.assign(new Error("Synthetic atomic replace failure"), { code });
      });
      try {
        await assert.rejects(internals(manager).atomicWrite(path, '{"status":"success"}'), { code });
        assert.equal(await readFile(path, "utf8"), '{"status":"running"}');
        assert.deepEqual(await readdir(projectPath), ["record.json"]);
        assert.equal(attempts, code === "EPERM" ? 8 : 1);
      } finally {
        await removeTestProject(projectPath);
      }
    });
  }

  it("retries transient atomic replacement failures without removing the live record", async (context) => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-replace-retry-"));
    const path = join(projectPath, "record.json");
    const manager = new ScenarioJobManager({ unity: new FakeScenarioUnity() as unknown as UnityClient });
    await writeFile(path, '{"status":"running"}', "utf8");
    let attempts = 0;
    const replace = internals(manager).replaceFile.bind(manager);
    context.mock.method(internals(manager), "replaceFile", async (temporary: string, destination: string) => {
      assert.equal(await readFile(destination, "utf8"), '{"status":"running"}');
      const code = ["EPERM", "EACCES", "EBUSY"][attempts++];
      if (code) throw Object.assign(new Error("Synthetic transient file lock"), { code });
      await replace(temporary, destination);
    });
    try {
      await internals(manager).atomicWrite(path, '{"status":"success"}');
      assert.equal(await readFile(path, "utf8"), '{"status":"success"}');
      assert.equal(attempts, 4);
      assert.deepEqual(await readdir(projectPath), ["record.json"]);
    } finally {
      await removeTestProject(projectPath);
    }
  });

  it("replaces a record after a real Windows sharing lock clears without a read gap", { skip: process.platform !== "win32" }, async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-sharing-lock-"));
    const path = join(projectPath, "record.json");
    await writeFile(path, '{"status":"running"}', "utf8");
    const manager = new ScenarioJobManager({ unity: new FakeScenarioUnity() as unknown as UnityClient });
    const locker = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '$stream = [System.IO.File]::Open($env:GHOST_TEST_RECORD_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); try { [Console]::WriteLine("LOCKED"); [Console]::Out.Flush(); [System.Threading.Thread]::Sleep(700) } finally { $stream.Dispose() }'
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GHOST_TEST_RECORD_PATH: path } }
    );
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((done, reject) => {
        readyTimer = setTimeout(() => reject(new Error("Windows lock helper did not acquire the test file.")), 15000);
        locker.once("error", reject);
        locker.once("exit", () => reject(new Error("Windows lock helper exited before reporting ownership.")));
        locker.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("LOCKED")) done();
        });
      });
      clearTimeout(readyTimer);
      const replacement = internals(manager).atomicWrite(path, '{"status":"success"}');
      assert.equal(await readFile(path, "utf8"), '{"status":"running"}');
      await replacement;
      assert.equal(await readFile(path, "utf8"), '{"status":"success"}');
    } finally {
      clearTimeout(readyTimer);
      if (locker.exitCode === null && locker.signalCode === null) {
        const exited = new Promise<void>((done) => locker.once("exit", () => done()));
        locker.kill("SIGKILL");
        await exited;
      }
      await removeTestProject(projectPath);
    }
  });

  for (const document of ["job", "lease", "evidence"] as const) {
    it(`waits for a held ${document} read in another manager before replacing its file`, async (context) => {
      const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-owned-read-"));
      const options = { unity: new FakeScenarioUnity() as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" };
      const writer = new ScenarioJobManager(options);
      const reader = new ScenarioJobManager(options);
      const started = await writer.start({ name: "owned read", scenePath: "Assets/Fixture.unity", cases: [{ id: "green" }] });
      const operationId = String(started.operationId);
      await waitForTerminal(writer, operationId);
      await reader.get(operationId);
      const jobsRoot = join(projectPath, "Library", "UnityMcpGhost", "scenario-jobs");
      const path =
        document === "job"
          ? join(jobsRoot, `${operationId}.json`)
          : document === "lease"
            ? join(jobsRoot, "active-scenario-lease.json")
            : join(projectPath, "Library", "UnityMcpGhost", "evidence", operationId, "manifest.json");
      if (document === "lease") await writeFile(path, JSON.stringify({ operationId: "another-operation", processId: process.pid }));
      const previous = await readFile(path, "utf8");
      const opened = deferred();
      const allowRead = deferred();
      const replacementAttempted = deferred();
      const originalRead = fs.readFile;
      const heldRead = context.mock.method(fs, "readFile", async (...args: Parameters<typeof readFile>) => {
        if (args[0] !== path) return originalRead(...args);
        const handle = await open(path, "r");
        opened.resolve();
        try {
          await allowRead.promise;
          return await handle.readFile(args[1]);
        } finally {
          await handle.close();
        }
      });
      syncBuiltinESMExports();
      let attempts = 0;
      let replacementCode: unknown;
      const replace = internals(writer).replaceFile.bind(writer);
      context.mock.method(internals(writer), "replaceFile", async (temporary: string, destination: string) => {
        if (destination.toLowerCase() !== path.toLowerCase()) return replace(temporary, destination);
        attempts++;
        try {
          await replace(temporary, destination);
        } catch (error) {
          replacementCode = (error as NodeJS.ErrnoException).code;
          throw error;
        } finally {
          replacementAttempted.resolve();
        }
      });
      let reading: Promise<unknown> | undefined;
      let replacing: Promise<void> | undefined;
      let observationTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        reading = document === "evidence" ? reader.readEvidence(operationId, "manifest.json") : reader.get(operationId);
        await opened.promise;
        // Windows aliases must share the same interlock across manager instances.
        replacing = internals(writer).atomicWrite(process.platform === "win32" ? path.toUpperCase() : path, previous);
        const observed = await Promise.race([
          replacementAttempted.promise.then(() => "replacement attempted"),
          new Promise<string>((done) => {
            observationTimer = setTimeout(() => done("read still held"), 200);
          })
        ]);
        assert.equal(observed, "read still held", `Replacement reached an owned open reader (code: ${String(replacementCode)}).`);
        assert.equal(attempts, 0);
        await internals(writer).atomicWrite(join(projectPath, "unrelated.json"), "{}");
        allowRead.resolve();
        await reading;
        await replacing;
        assert.equal(attempts, 1);
        assert.equal(await originalRead(path, "utf8"), previous);
      } finally {
        clearTimeout(observationTimer);
        allowRead.resolve();
        await Promise.allSettled([reading, replacing]);
        heldRead.mock.restore();
        syncBuiltinESMExports();
        await removeTestProject(projectPath);
      }
    });
  }

  it("does not report a known operation missing during an atomic job-file replacement", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-read-race-"));
    const fake = new FakeScenarioUnity();
    const manager = new ScenarioJobManager({ unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" });

    try {
      const started = await manager.start({ name: "read race", scenePath: "Assets/Fixture.unity", cases: [{ id: "green" }] });
      const operationId = String(started.operationId);
      await waitForTerminal(manager, operationId);
      const jobPath = join(projectPath, "Library", "UnityMcpGhost", "scenario-jobs", `${operationId}.json`);
      const replacementPath = `${jobPath}.replacement`;
      await rename(jobPath, replacementPath);
      const restore = new Promise<void>((resolveRestore, rejectRestore) => {
        setTimeout(() => void rename(replacementPath, jobPath).then(resolveRestore, rejectRestore), 25);
      });

      const observed = await manager.get(operationId);
      await restore;
      assert.equal(observed.operationId, operationId);
      assert.equal(observed.status, "success", JSON.stringify(observed.error));
    } finally {
      await removeTestProject(projectPath);
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
      await removeTestProject(projectPath);
    }
  });

  it("retries input only when expiry proves the event never executed", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-input-expiry-"));
    const fake = new FakeScenarioUnity();
    fake.inputKnownNonExecutionExpirations = 1;
    const manager = new ScenarioJobManager({ unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" });

    try {
      const started = await manager.start({
        name: "known input non-execution",
        scenePath: "Assets/Fixture.unity",
        cases: [{ id: "input", inputs: [{ device: "keyboard", action: "tap", key: "PageUp" }] }]
      });
      const completed = await waitForTerminal(manager, String(started.operationId));

      assert.equal(completed.status, "success", JSON.stringify(completed.error));
      assert.equal(fake.inputAttempts, 2);
    } finally {
      await removeTestProject(projectPath);
    }
  });

  it("does not replay input when the execution outcome is unknown", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-input-unknown-"));
    const fake = new FakeScenarioUnity();
    fake.inputUnknownOutcomeFailures = 1;
    const manager = new ScenarioJobManager({ unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" });

    try {
      const started = await manager.start({
        name: "unknown input outcome",
        scenePath: "Assets/Fixture.unity",
        cases: [{ id: "input", inputs: [{ device: "keyboard", action: "tap", key: "PageUp" }] }]
      });
      const completed = await waitForTerminal(manager, String(started.operationId));
      const result = (completed.cases as Array<Record<string, unknown>>)[0];

      assert.equal(completed.status, "failed");
      assert.equal((result.observedFailure as Record<string, unknown>).code, "OUTCOME_UNKNOWN");
      assert.equal(fake.inputAttempts, 1);
    } finally {
      await removeTestProject(projectPath);
    }
  });

  it("fails an expected Console timeout when every read expires without observing the matching message", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-console-expiry-"));
    const fake = new FakeScenarioUnity();
    fake.consoleKnownNonExecutionExpirations = 100;
    const manager = new ScenarioJobManager({ unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" });

    try {
      const started = await manager.start({
        name: "known Console non-execution",
        scenePath: "Assets/Fixture.unity",
        cases: [
          {
            id: "console-timeout",
            expectedResult: "timeout",
            expectedFailureCode: "CONSOLE_WAIT_TIMEOUT",
            consoleAssertions: [{ exact: "never", timeoutMs: 30 }]
          }
        ]
      });
      const completed = await waitForTerminal(manager, String(started.operationId));
      const result = (completed.cases as Array<Record<string, unknown>>)[0];

      assert.equal(completed.status, "failed", JSON.stringify(completed));
      assert.equal((result.observedFailure as Record<string, unknown>).code, "CONSOLE_OBSERVATION_UNAVAILABLE");
      assert.equal(result.observedResult, "assertion-failure");
      assert.equal(fake.consoleMatches, true);
      assert.ok(fake.consoleQueries > 0);
    } finally {
      await removeTestProject(projectPath);
    }
  });

  for (const matches of [false, true]) {
    it(`retries Console reads then records the observed ${matches ? "match" : "non-match timeout"}`, async () => {
      const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-console-retry-"));
      const fake = new FakeScenarioUnity();
      fake.consoleKnownNonExecutionExpirations = 1;
      fake.consoleMatches = matches;
      const manager = new ScenarioJobManager({ unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" });
      try {
        const started = await manager.start({
          name: "observed Console retry",
          scenePath: "Assets/Fixture.unity",
          cases: [
            {
              id: "console",
              expectedResult: matches ? "pass" : "timeout",
              expectedFailureCode: matches ? undefined : "CONSOLE_WAIT_TIMEOUT",
              consoleAssertions: [{ exact: "PAGE:1", timeoutMs: 250 }]
            }
          ]
        });
        const completed = await waitForTerminal(manager, String(started.operationId));
        const result = (completed.cases as Array<Record<string, unknown>>)[0];
        assert.equal(completed.status, "success", JSON.stringify(completed));
        assert.ok(fake.consoleQueries >= 2);
        if (matches) assert.equal(result.observedResult, "pass");
        else assert.equal((result.observedFailure as Record<string, unknown>).code, "CONSOLE_WAIT_TIMEOUT");
      } finally {
        await removeTestProject(projectPath);
      }
    });
  }

  it("retries input.status once after a read timeout without replaying the accepted input", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-input-status-"));
    const fake = new FakeScenarioUnity();
    fake.inputRunsAsynchronously = true;
    fake.inputStatusSafeTimeoutFailures = 1;
    const manager = new ScenarioJobManager({ unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" });
    try {
      const started = await manager.start({
        name: "input status retry",
        scenePath: "Assets/Fixture.unity",
        cases: [{ id: "input", inputs: [{ device: "keyboard", action: "tap", key: "PageUp" }] }]
      });
      const completed = await waitForTerminal(manager, String(started.operationId));
      assert.equal(completed.status, "success", JSON.stringify(completed));
      assert.equal(fake.inputAttempts, 1);
      assert.equal(fake.inputStatusAttempts, 2);
      const input = ((completed.cases as Array<Record<string, unknown>>)[0].inputs as Array<Record<string, unknown>>)[0];
      assert.equal(input.pressObserved, true);
      assert.equal(input.releaseObserved, true);
    } finally {
      await removeTestProject(projectPath);
    }
  });

  for (const timing of [
    { mutationMs: 4500, firstReadMs: 1000, expected: [1500, 500] },
    { mutationMs: 4500, firstReadMs: 1460, expected: [1500, 40] },
    { mutationMs: 6000, firstReadMs: 0, expected: [] }
  ]) {
    it(`bounds Play reads after ${timing.mutationMs} ms mutation and ${timing.firstReadMs} ms retry`, async (context) => {
      let now = 0;
      const readTimeouts: number[] = [];
      context.mock.method(Date, "now", () => now);
      const unity = {
        async request(method: string, _params: unknown, options: { timeoutMs: number }): Promise<unknown> {
          if (method === "play_mode.set") {
            now += timing.mutationMs;
            return { ok: true, transitionGeneration: 1 };
          }
          assert.equal(method, "play_mode.get");
          readTimeouts.push(options.timeoutMs);
          now += readTimeouts.length === 1 ? timing.firstReadMs : options.timeoutMs;
          throw readTimeout();
        }
      };
      const manager = new ScenarioJobManager({ unity: unity as unknown as UnityClient });
      await assert.rejects(internals(manager).setPlayMode("playing", 6000), { code: "PLAY_MODE_TRANSITION_TIMEOUT" });
      assert.deepEqual(readTimeouts, timing.expected);
      assert.equal(now, 6000);
    });
  }

  for (const failedEvidence of [false, true]) {
    it(`persists ${failedEvidence ? "launch-catch failure" : "success"} under its lease and hides completion until cleanup`, async (context) => {
      const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-finalize-"));
      const fake = new FakeScenarioUnity();
      const options = { unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" };
      const manager = new ScenarioJobManager(options);
      const contender = new ScenarioJobManager(options);
      const releasing = deferred();
      const allowRelease = deferred();
      const methods = internals(manager);
      const release = methods.releaseLease.bind(manager);
      context.mock.method(methods, "releaseLease", async (operationId: string) => {
        releasing.resolve();
        await allowRelease.promise;
        await release(operationId);
      });
      if (failedEvidence) {
        const writeEvidence = methods.writeEvidence.bind(manager);
        let calls = 0;
        context.mock.method(methods, "writeEvidence", async (record: ScenarioJobRecord) => {
          if (++calls === 1) throw new Error("Synthetic evidence write failure");
          await writeEvidence(record);
        });
      }
      let operationId = "";
      try {
        const started = await manager.start({ name: "finalize boundary", scenePath: "Assets/Fixture.unity", cases: [{ id: "green" }] });
        operationId = String(started.operationId);
        await releasing.promise;
        const jobPath = join(projectPath, "Library", "UnityMcpGhost", "scenario-jobs", `${operationId}.json`);
        const durable = JSON.parse(await readFile(jobPath, "utf8")) as ScenarioJobRecord;
        assert.equal(durable.status, failedEvidence ? "failed" : "success");
        assert.equal(durable.restorationComplete, true);
        for (const reader of [manager, contender]) {
          assert.equal((await reader.get(operationId)).status, "running");
          assert.equal((await reader.result(operationId)).ready, false);
          assert.equal(((await reader.list()).operations as Array<Record<string, unknown>>)[0].status, "running");
          assert.equal((await reader.cancel(operationId)).status, "running");
          await assert.rejects(reader.createEvidence(operationId), { code: "SCENARIO_NOT_COMPLETE" });
          await assert.rejects(reader.readEvidence(operationId, "manifest.json"), { code: "SCENARIO_NOT_COMPLETE" });
        }
        assert.equal(fake.restoreCount, 2);
        let closed = false;
        const closing = manager.close().then((receipt) => {
          closed = true;
          return receipt;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(closed, false, "close must await the execution's lease cleanup");
        allowRelease.resolve();
        assert.deepEqual(await closing, { outcomeUnknown: false });
        const completed = await waitForTerminal(manager, operationId);
        assert.equal(completed.status, failedEvidence ? "failed" : "success");
        assert.equal((await contender.get(operationId)).status, completed.status);
        assert.equal(fake.restoreCount, 2);
        await assert.rejects(access(join(projectPath, "Library", "UnityMcpGhost", "scenario-jobs", "active-scenario-lease.json")), { code: "ENOENT" });
        const next = await contender.start({ name: "after cleanup", scenePath: "Assets/Fixture.unity", cases: [{ id: "next" }] });
        await waitForTerminal(contender, String(next.operationId));
      } finally {
        allowRelease.resolve();
        if (operationId) await waitForTerminal(manager, operationId);
        await removeTestProject(projectPath);
      }
    });
  }

  it("retains ownership and reports a non-ready failure when both terminal saves fail", async (context) => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-final-save-failure-"));
    const fake = new FakeScenarioUnity();
    const options = { unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" };
    const manager = new ScenarioJobManager(options);
    const contender = new ScenarioJobManager(options);
    const failedSaves = deferred();
    let terminalSaveAttempts = 0;
    const save = internals(manager).save.bind(manager);
    context.mock.method(internals(manager), "save", async (record: ScenarioJobRecord) => {
      if (["success", "failed", "cancelled", "outcomeUnknown"].includes(record.status)) {
        if (++terminalSaveAttempts === 2) failedSaves.resolve();
        throw Object.assign(new Error("Synthetic terminal persistence failure"), { code: "ENOSPC" });
      }
      await save(record);
    });
    let operationId = "";
    try {
      const started = await manager.start({ name: "failed terminal save", scenePath: "Assets/Fixture.unity", cases: [{ id: "green" }] });
      operationId = String(started.operationId);
      await failedSaves.promise;
      await waitUntil(() => !internals(manager).controllers.has(operationId));
      assert.equal((await manager.get(operationId)).phase, "finalization-failed");
      const result = await manager.result(operationId);
      assert.equal(result.ok, false);
      assert.equal(result.ready, false);
      assert.equal(result.outcomeUnknown, true);
      assert.equal((result.error as Record<string, unknown>).code, "SCENARIO_FINALIZATION_PERSIST_FAILED");
      assert.equal((await manager.cancel(operationId)).phase, "finalization-failed");
      await assert.rejects(manager.createEvidence(operationId), { code: "SCENARIO_NOT_COMPLETE" });
      await assert.rejects(contender.get(operationId), { code: "SCENARIO_ALREADY_RUNNING" });
      await assert.rejects(manager.start({ name: "blocked", scenePath: "Assets/Fixture.unity", cases: [{ id: "blocked" }] }), {
        code: "SCENARIO_ALREADY_RUNNING"
      });
      const jobsRoot = join(projectPath, "Library", "UnityMcpGhost", "scenario-jobs");
      const lease = JSON.parse(await readFile(join(jobsRoot, "active-scenario-lease.json"), "utf8")) as Record<string, unknown>;
      assert.equal(lease.operationId, operationId);
      const durable = JSON.parse(await readFile(join(jobsRoot, `${operationId}.json`), "utf8")) as ScenarioJobRecord;
      assert.equal(durable.phase, "restoring-original-state");
      assert.equal(fake.restoreCount, 2);
      assert.equal(terminalSaveAttempts, 2);
      assert.deepEqual(await manager.close(), { outcomeUnknown: true });
    } finally {
      if (operationId) await internals(manager).releaseLease(operationId);
      await removeTestProject(projectPath);
    }
  });

  it("reports a failed finalization fallback without releasing its lease or leaking a rejection", async (context) => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-drain-finalize-failure-"));
    const fake = new FakeScenarioUnity();
    const manager = new ScenarioJobManager({ unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" });
    let releaseAttempts = 0;
    context.mock.method(internals(manager), "releaseLease", async () => {
      releaseAttempts++;
      throw new Error("synthetic lease cleanup failure");
    });
    try {
      const started = await manager.start({ name: "failed finalization", scenePath: "Assets/Fixture.unity", cases: [{ id: "green" }] });
      assert.deepEqual(await manager.close(), { outcomeUnknown: true });
      assert.equal(releaseAttempts, 2);
      assert.equal(fake.restoreCount, 2);
      assert.equal((await manager.get(String(started.operationId))).phase, "finalization-failed");
      await access(join(projectPath, "Library", "UnityMcpGhost", "scenario-jobs", "active-scenario-lease.json"));
    } finally {
      await manager.close();
      await removeTestProject(projectPath);
    }
  });

  it("rereads a stale running record after the second manager acquires its recovery lease", async (context) => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-stale-recovery-"));
    const fake = new FakeScenarioUnity();
    const options = { unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" };
    const manager = new ScenarioJobManager(options);
    const contender = new ScenarioJobManager(options);
    const restoring = deferred();
    const allowRestore = deferred();
    const acquiring = deferred();
    const allowAcquire = deferred();
    const request = fake.request.bind(fake);
    context.mock.method(fake, "request", async (method: string, params: unknown) => {
      if (method === "editor.restore_snapshot" && fake.restoreCount === 1) {
        restoring.resolve();
        await allowRestore.promise;
      }
      return request(method, params);
    });
    const acquire = internals(contender).acquireLease.bind(contender);
    context.mock.method(internals(contender), "acquireLease", async (operationId: string) => {
      acquiring.resolve();
      await allowAcquire.promise;
      await acquire(operationId);
    });
    let operationId = "";
    let recovery: Promise<Record<string, unknown>> | undefined;
    try {
      const started = await manager.start({ name: "stale recovery", scenePath: "Assets/Fixture.unity", cases: [{ id: "green" }] });
      operationId = String(started.operationId);
      await restoring.promise;
      recovery = contender.get(operationId);
      await acquiring.promise;
      allowRestore.resolve();
      assert.equal((await waitForTerminal(manager, operationId)).status, "success");
      allowAcquire.resolve();
      assert.equal((await recovery).status, "success");
      assert.equal(fake.restoreCount, 2);
      assert.equal((await manager.get(operationId)).status, "success");
    } finally {
      allowRestore.resolve();
      allowAcquire.resolve();
      await recovery;
      if (operationId) await waitForTerminal(manager, operationId);
      await removeTestProject(projectPath);
    }
  });

  it("retries a timed-out read-only Play mode status poll", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-play-status-timeout-"));
    const fake = new FakeScenarioUnity();
    fake.playGetSafeTimeoutFailures = 1;
    const manager = new ScenarioJobManager({ unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" });

    try {
      const started = await manager.start({
        name: "safe Play status retry",
        scenePath: "Assets/Fixture.unity",
        cases: [{ id: "play-status" }]
      });
      const completed = await waitForTerminal(manager, String(started.operationId));

      assert.equal(completed.status, "success");
      assert.equal(fake.playGetSafeTimeoutFailures, 0);
    } finally {
      await removeTestProject(projectPath);
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
      await removeTestProject(projectPath);
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
      await removeTestProject(projectPath);
    }
  });

  it("removes source credentials from durable records and every evidence document", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-redaction-"));
    const sourcePath = "Assets/Fixture.cs";
    const sourceFullPath = join(projectPath, sourcePath);
    const original = "public sealed class Fixture {}\n";
    const mutated = [
      'public sealed class Fixture { const string token = "super secret phrase"; string localName = "Student Name"; string localUsername = "student_user"; string localPassword = "h&ck pr00f"; int localSecurityPin = 48151623;',
      'string apiKey = @"SYNTHETIC_VERBATIM; secret tail with ""SYNTHETIC_DOUBLED"" quotes"; int visibleCount = 42;',
      'string secret = $"SYNTHETIC_INTERPOLATED {DateTime.Now.ToString("SYNTHETIC_FORMAT")} SYNTHETIC_AFTER_INTERPOLATION";',
      'string password = $@"SYNTHETIC_MULTILINE',
      'SYNTHETIC_SECOND_LINE; {string.Join(";", new[] { "SYNTHETIC_NESTED" })} ""SYNTHETIC_END""";',
      'string token = @$"SYNTHETIC_OTHER_PREFIX {1 + 1}";',
      'string localName = @"SYNTHETIC;STUDENT"; string localUsername = $"SYNTHETIC_USER;tail";',
      'string secret = "SYNTHETIC_CONCAT" + @"SYNTHETIC_CONCAT_TAIL"; int visibleAfterSecrets = 7;',
      'string token = @"""SYNTHETIC_LEADING_QUOTE"";tail"; int visibleAfterLeadingQuote = 11;',
      "}\n"
    ].join("\n");
    const sensitive = /super secret phrase|Student Name|student_user|h&ck pr00f|48151623|SYNTHETIC|STUDENT/;
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
        assert.doesNotMatch(await readFile(join(evidenceDirectory, name), "utf8"), sensitive);
      }
      assert.doesNotMatch(await readFile(join(projectPath, "Library", "UnityMcpGhost", "scenario-jobs", `${operationId}.json`), "utf8"), sensitive);
      const redactedDiff = await readFile(join(evidenceDirectory, "diffs", "secret-1-Fixture.cs.diff"), "utf8");
      assert.doesNotMatch(redactedDiff, sensitive);
      assert.match(redactedDiff, /\[REDACTED\]/);
      assert.match(redactedDiff, /int visibleCount = 42;/);
      assert.match(redactedDiff, /int visibleAfterSecrets = 7;/);
      assert.match(redactedDiff, /int visibleAfterLeadingQuote = 11;/);
    } finally {
      await removeTestProject(projectPath);
    }
  });

  it("redacts the remaining diff when a sensitive C# literal is unterminated", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "unity-mcp-scenario-redaction-incomplete-"));
    const sourcePath = "Assets/Fixture.cs";
    const sourceFullPath = join(projectPath, sourcePath);
    const original = "public sealed class Fixture {}\n";
    const mutated = 'int visibleBefore = 9; string token = @"SYNTHETIC_UNTERMINATED;\nSYNTHETIC_SECRET_TAIL\n';
    await mkdir(join(projectPath, "Assets"), { recursive: true });
    await writeFile(sourceFullPath, original, "utf8");
    const fake = new ReloadRaceScenarioUnity(sourceFullPath, sourcePath, original, mutated);
    const manager = new ScenarioJobManager({ unity: fake as unknown as UnityClient, projectPath, projectId: "project-1", editorInstanceId: "editor-1" });
    try {
      const started = await manager.start({
        name: "malformed literal redaction",
        scenePath: "Assets/Fixture.unity",
        cases: [{ id: "secret", sourceMutations: [{ path: sourcePath, content: mutated, expectedSha256: sha256(original) }] }]
      });
      const operationId = String(started.operationId);
      const completed = await waitForTerminal(manager, operationId);
      assert.equal(completed.status, "success", JSON.stringify(completed.error));
      const diff = await manager.readArtifact(operationId, "diffs", "secret-1-Fixture.cs.diff");
      assert.doesNotMatch(String(diff.text), /SYNTHETIC/);
      assert.match(String(diff.text), /int visibleBefore = 9;/);
      const durable = await readFile(join(projectPath, "Library", "UnityMcpGhost", "scenario-jobs", `${operationId}.json`), "utf8");
      assert.doesNotMatch(durable, /SYNTHETIC/);
    } finally {
      await removeTestProject(projectPath);
    }
  });
});

class FakeScenarioUnity {
  public state = "stopped";
  public generation = 0;
  public restoreCount = 0;
  public consoleMatches = true;
  public consoleQueries = 0;
  public consoleKnownNonExecutionExpirations = 0;
  public inputAttempts = 0;
  public inputKnownNonExecutionExpirations = 0;
  public inputUnknownOutcomeFailures = 0;
  public inputRunsAsynchronously = false;
  public inputStatusSafeTimeoutFailures = 0;
  public inputStatusAttempts = 0;
  public playGetTransientFailures = 0;
  public playGetSafeTimeoutFailures = 0;

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
        if (this.playGetSafeTimeoutFailures > 0) {
          this.playGetSafeTimeoutFailures--;
          throw Object.assign(new Error("Unity durable queue request timed out: play_mode.get"), {
            code: "UNITY_REQUEST_TIMEOUT",
            data: { code: "UNITY_REQUEST_TIMEOUT", outcomeUnknown: false }
          });
        }
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
        if (this.consoleKnownNonExecutionExpirations > 0) {
          this.consoleKnownNonExecutionExpirations--;
          throw knownNonExecutionExpiry();
        }
        return { ok: true, matched: this.consoleMatches, entries: this.consoleMatches ? [{ message: "PAGE:1" }] : [], unexpectedErrors: [] };
      case "input.simulate":
        this.inputAttempts++;
        if (this.inputUnknownOutcomeFailures > 0) {
          this.inputUnknownOutcomeFailures--;
          throw Object.assign(new Error("The input outcome is unknown."), {
            code: "OUTCOME_UNKNOWN",
            data: { code: "OUTCOME_UNKNOWN", status: "timedOut", outcomeUnknown: true }
          });
        }
        if (this.inputKnownNonExecutionExpirations > 0) {
          this.inputKnownNonExecutionExpirations--;
          throw knownNonExecutionExpiry();
        }
        if (this.inputRunsAsynchronously) return { ok: true, status: "running", operationId: "input-operation" };
        return { ok: true, status: "completed", backend: "project-test-driver:fixture", pressObserved: true, releaseObserved: true };
      case "input.status":
        this.inputStatusAttempts++;
        assert.equal(values.operationId, "input-operation");
        if (this.inputStatusSafeTimeoutFailures > 0) {
          this.inputStatusSafeTimeoutFailures--;
          throw readTimeout();
        }
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

function readTimeout(): Error {
  return Object.assign(new Error("Read-only Unity request timed out."), {
    code: "UNITY_REQUEST_TIMEOUT",
    data: { code: "UNITY_REQUEST_TIMEOUT", outcomeUnknown: false }
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function internals(manager: ScenarioJobManager): {
  controllers: Map<string, AbortController>;
  atomicWrite(path: string, contents: string): Promise<void>;
  replaceFile(temporary: string, destination: string): Promise<void>;
  setPlayMode(state: "playing" | "paused" | "stopped", timeoutMs: number): Promise<unknown>;
  releaseLease(operationId: string): Promise<void>;
  acquireLease(operationId: string): Promise<void>;
  writeEvidence(record: ScenarioJobRecord): Promise<void>;
  save(record: ScenarioJobRecord): Promise<void>;
} {
  return manager as unknown as ReturnType<typeof internals>;
}

function knownNonExecutionExpiry(): Error {
  return Object.assign(new Error("Request deadline elapsed before execution."), {
    code: "EXPIRED",
    data: { code: "EXPIRED", status: "expired", outcomeUnknown: false }
  });
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
      diff: `--- before\n+++ after\n${original
        .split("\n")
        .map((line) => `-${line}`)
        .join("\n")}\n${mutated
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n")}`
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
  }).catch((cause: unknown) => {
    throw new Error(`Scenario test observation expired: ${JSON.stringify({ operationId, status: state.status, error: state.error })}`, { cause });
  });
  return state;
}

async function removeTestProject(projectPath: string): Promise<void> {
  await rm(projectPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  // These observations include real disk writes, bounded sharing-lock retries,
  // and lease cleanup. They are not the operation deadlines tested by each case.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for scenario job test state.");
}
