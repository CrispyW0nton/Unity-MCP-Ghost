import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { getEventListeners, once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { stopOwnedProcess } from "../src/testing/unityEditor.js";
import { defaultUnityTestTimeoutMs, runUnityTestSuite, unityTestTimeoutMs, type UnityTestDependencies } from "../src/testing/unityTestRunner.js";

const greenXml = '<test-run result="Passed" total="2" passed="2" failed="0" skipped="0" inconclusive="0"></test-run>';

async function fixture(t: TestContext, mode: "green" | "failed" | "missing" | "red" | "hang") {
  const projectPath = await mkdtemp(join(tmpdir(), "ghost-unity-runner-"));
  await mkdir(join(projectPath, "Logs"));
  const stableResult = join(projectPath, "Logs", "editmode-results.xml");
  await writeFile(stableResult, "previous certified result");
  let child: ChildProcess | undefined;
  let resolveLaunched!: (child: ChildProcess) => void;
  const launched = new Promise<ChildProcess>((done) => {
    resolveLaunched = done;
  });
  const launches: string[][] = [];
  t.after(async () => {
    if (child) await stopOwnedProcess(child);
    await rm(projectPath, { recursive: true, force: true });
  });
  const dependencies = {
    verifyEditor: async () => {},
    launchEditor: (_path: string, args: string[]) => {
      launches.push(args);
      const resultPath = args[args.indexOf("-testResults") + 1];
      const source =
        mode === "hang"
          ? "setInterval(() => {}, 1000)"
          : `const fs=require('node:fs'); if(process.argv[3]!=='missing') fs.writeFileSync(process.argv[1],process.argv[2]); process.exit(process.argv[3]==='failed'?2:0);`;
      child = spawn(process.execPath, ["-e", source, resultPath, mode === "red" ? greenXml.replace('result="Passed"', 'result="Failed"') : greenXml, mode], {
        stdio: "ignore",
        windowsHide: true
      });
      resolveLaunched(child);
      return child;
    }
  };
  return { projectPath, stableResult, dependencies, launches, launched, child: () => child };
}

describe("owned Unity test runner", () => {
  it("validates a bounded timeout before starting work", () => {
    assert.equal(unityTestTimeoutMs(undefined), defaultUnityTestTimeoutMs);
    assert.equal(unityTestTimeoutMs("1"), 1);
    assert.equal(unityTestTimeoutMs("3600000"), 3600000);
    for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "3600001"]) {
      assert.throws(() => unityTestTimeoutMs(value), /UNITY_TEST_TIMEOUT_INVALID/);
    }
  });

  it("accepts only fresh green evidence without replacing historical aggregate files", async (t) => {
    const f = await fixture(t, "green");
    const result = await runUnityTestSuite({ editorPath: "fixture", projectPath: f.projectPath, platform: "EditMode" }, f.dependencies);
    assert.equal(result.counts.passed, 2);
    assert.notEqual(result.resultPath, f.stableResult);
    assert.equal(await readFile(result.resultPath, "utf8"), greenXml);
    assert.equal(await readFile(f.stableResult, "utf8"), "previous certified result");
    assert.ok(f.child()!.exitCode !== null);
  });

  it("does not certify a nonzero exit even when it writes green XML", async (t) => {
    const f = await fixture(t, "failed");
    await assert.rejects(runUnityTestSuite({ editorPath: "fixture", projectPath: f.projectPath, platform: "EditMode" }, f.dependencies), /exit code 2/);
    assert.equal(await readFile(f.stableResult, "utf8"), "previous certified result");
  });

  it("does not reuse an old result when this invocation produces no XML", async (t) => {
    const f = await fixture(t, "missing");
    await assert.rejects(runUnityTestSuite({ editorPath: "fixture", projectPath: f.projectPath, platform: "EditMode" }, f.dependencies), /ENOENT/);
    assert.equal(await readFile(f.stableResult, "utf8"), "previous certified result");
  });

  it("rejects a failed NUnit report even when the Editor exits zero", async (t) => {
    const f = await fixture(t, "red");
    await assert.rejects(runUnityTestSuite({ editorPath: "fixture", projectPath: f.projectPath, platform: "EditMode" }, f.dependencies), (error: unknown) => {
      assertFailureEvidence(error, f.projectPath, /not completely green/);
      assert.match(String(error.cause), /not completely green/);
      return true;
    });
    assert.equal(await readFile(f.stableResult, "utf8"), "previous certified result");
  });

  it("does not verify or launch an Editor when already cancelled", async (t) => {
    const f = await fixture(t, "green");
    const controller = new AbortController();
    controller.abort();
    let verified = false;
    await assert.rejects(
      runUnityTestSuite(
        { editorPath: "fixture", projectPath: f.projectPath, platform: "EditMode", signal: controller.signal },
        {
          ...f.dependencies,
          verifyEditor: async () => {
            verified = true;
          }
        }
      ),
      /UNITY_TEST_CANCELLED/
    );
    assert.equal(verified, false);
    assert.equal(f.launches.length, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  it("propagates the total deadline through executable verification without launching the suite", async (t) => {
    const f = await fixture(t, "green");
    await assert.rejects(
      runUnityTestSuite(
        { editorPath: "fixture", projectPath: f.projectPath, platform: "EditMode", timeoutMs: 50 },
        {
          ...f.dependencies,
          verifyEditor: async (_path, signal) => {
            assert.ok(signal);
            await new Promise<void>((_done, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              if (signal.aborted) reject(signal.reason);
            });
          }
        }
      ),
      /UNITY_TEST_TIMEOUT/
    );
    assert.equal(f.launches.length, 0);
  });

  it("rejects a failed spawn and removes its lifecycle listeners", async (t) => {
    const f = await fixture(t, "green");
    let child: ChildProcess | undefined;
    await assert.rejects(
      runUnityTestSuite(
        { editorPath: "fixture", projectPath: f.projectPath, platform: "EditMode" },
        {
          ...f.dependencies,
          launchEditor: () => {
            child = spawn(join(f.projectPath, "missing-editor-executable"), [], { stdio: "ignore", windowsHide: true });
            return child;
          }
        }
      ),
      /ENOENT/
    );
    assert.equal(child!.listenerCount("exit"), 0);
    assert.equal(child!.listenerCount("error"), 0);
  });

  it("retains the timeout and cleanup failure rather than claiming successful cleanup", async (t) => {
    const f = await fixture(t, "hang");
    const cleanupFailure = new Error("controlled cleanup failure");
    await assert.rejects(
      runUnityTestSuite(
        { editorPath: "fixture", projectPath: f.projectPath, platform: "EditMode", timeoutMs: 50 },
        {
          ...f.dependencies,
          stopEditor: async (child) => {
            await stopOwnedProcess(child);
            throw cleanupFailure;
          }
        }
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assertFailureEvidence(error, f.projectPath, /UNITY_TEST_CLEANUP_FAILED/);
        assert.match(String(error.errors[0]), /UNITY_TEST_TIMEOUT/);
        assert.equal(error.errors[1], cleanupFailure);
        return true;
      }
    );
  });

  it("times out and awaits owned Editor termination without replacing old evidence", async (t) => {
    const f = await fixture(t, "hang");
    const running = runUnityTestSuite({ editorPath: "fixture", projectPath: f.projectPath, platform: "EditMode", timeoutMs: 50 }, f.dependencies);
    const outcome = await observe(running);
    assert.equal(outcome.status, "rejected", "Runner ignored its deadline");
    if (outcome.status === "rejected") assert.match(String(outcome.error), /UNITY_TEST_TIMEOUT/);
    assert.ok(f.child()!.exitCode !== null || f.child()!.signalCode !== null, "Runner returned before its owned Editor stopped");
    assert.equal(await readFile(f.stableResult, "utf8"), "previous certified result");
  });

  it("cancels an active Editor and waits for termination", async (t) => {
    const f = await fixture(t, "hang");
    const controller = new AbortController();
    const running = runUnityTestSuite({ editorPath: "fixture", projectPath: f.projectPath, platform: "EditMode", signal: controller.signal }, f.dependencies);
    const child = await f.launched;
    if (!child.pid) await once(child, "spawn");
    controller.abort(new Error("test cancellation"));
    const outcome = await observe(running);
    assert.equal(outcome.status, "rejected", "Runner ignored cancellation");
    if (outcome.status === "rejected") {
      assertFailureEvidence(outcome.error, f.projectPath, /UNITY_TEST_CANCELLED/);
      assert.ok(outcome.error.cause instanceof Error);
      assert.equal(outcome.error.cause.cause, controller.signal.reason);
    }
    assert.ok(f.child()!.exitCode !== null || f.child()!.signalCode !== null);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(f.child()!.listenerCount("exit"), 0);
    assert.equal(f.child()!.listenerCount("error"), 0);
    assert.equal(await readFile(f.stableResult, "utf8"), "previous certified result");
  });

  for (const stage of ["mkdir", "stat", "read"] as const) {
    for (const terminal of ["timeout", "cancellation"] as const) {
      it(`observes ${terminal} during delayed ${stage} without continuing abandoned work`, async (t) => {
        const f = await fixture(t, "green");
        const controller = new AbortController();
        const entered = deferred<void>();
        const release = deferred<void>();
        const waitForRelease = async () => {
          entered.resolve();
          await release.promise;
        };
        const dependencies: UnityTestDependencies = {
          ...f.dependencies,
          makeLogDirectory: stage === "mkdir" ? waitForRelease : undefined,
          statResult:
            stage === "stat"
              ? async () => {
                  await waitForRelease();
                  return { size: greenXml.length };
                }
              : undefined,
          readResult:
            stage === "read"
              ? async () => {
                  await waitForRelease();
                  return greenXml;
                }
              : undefined
        };
        const running = runUnityTestSuite(
          { editorPath: "fixture", projectPath: f.projectPath, platform: "EditMode", signal: controller.signal, timeoutMs: 2000 },
          dependencies
        );
        const observed = observe(running, 3000);
        try {
          assert.equal((await observe(entered.promise, 1500)).status, "resolved", `Runner did not enter the ${stage} stage`);
          if (terminal === "cancellation") controller.abort(new Error("cancel held filesystem stage"));
          const outcome = await observed;
          assert.equal(outcome.status, "rejected", `Runner kept awaiting ${stage} after ${terminal}`);
          if (outcome.status === "rejected") {
            assertFailureEvidence(outcome.error, f.projectPath, terminal === "timeout" ? /UNITY_TEST_TIMEOUT/ : /UNITY_TEST_CANCELLED/);
          }
          assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        } finally {
          release.resolve();
          await running.catch(() => {});
        }
        assert.equal(f.launches.length, stage === "mkdir" ? 0 : 1, "Abandoned directory creation launched a later Editor");
        assert.equal(await readFile(f.stableResult, "utf8"), "previous certified result");
      });
    }
  }

  for (const terminal of ["timeout", "cancellation"] as const) {
    it(`does not accept green results when ${terminal} arrives during required cleanup`, async (t) => {
      const f = await fixture(t, "green");
      const controller = new AbortController();
      const entered = deferred<void>();
      const release = deferred<void>();
      const running = runUnityTestSuite(
        {
          editorPath: "fixture",
          projectPath: f.projectPath,
          platform: "EditMode",
          signal: controller.signal,
          timeoutMs: terminal === "timeout" ? 2000 : 10000
        },
        {
          ...f.dependencies,
          stopEditor: async () => {
            entered.resolve();
            await release.promise;
          }
        }
      );
      const observed = observe(running, terminal === "timeout" ? 2500 : 500);
      try {
        assert.equal((await observe(entered.promise, 2500)).status, "resolved", "Runner did not reach required cleanup");
        if (terminal === "cancellation") controller.abort(new Error("cancel during cleanup"));
        assert.equal((await observed).status, "pending", "Runner returned before required cleanup completed");
      } finally {
        release.resolve();
      }
      await assert.rejects(running, (error: unknown) => {
        assertFailureEvidence(error, f.projectPath, terminal === "timeout" ? /UNITY_TEST_TIMEOUT/ : /UNITY_TEST_CANCELLED/);
        return true;
      });
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(await readFile(f.stableResult, "utf8"), "previous certified result");
    });
  }

  it("retains cancellation and a cleanup error after green XML without certifying the invocation", async (t) => {
    const f = await fixture(t, "green");
    const controller = new AbortController();
    const cleanupFailure = new Error("cleanup failed after validation");
    await assert.rejects(
      runUnityTestSuite(
        { editorPath: "fixture", projectPath: f.projectPath, platform: "EditMode", signal: controller.signal },
        {
          ...f.dependencies,
          stopEditor: async () => {
            controller.abort();
            throw cleanupFailure;
          }
        }
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assertFailureEvidence(error, f.projectPath, /UNITY_TEST_CLEANUP_FAILED/);
        assert.match(String(error.errors[0]), /UNITY_TEST_CANCELLED/);
        assert.equal(error.errors[1], cleanupFailure);
        return true;
      }
    );
    assert.equal(await readFile(f.stableResult, "utf8"), "previous certified result");
  });

  it("preserves a filesystem failure code and cause alongside unique evidence paths", async (t) => {
    const f = await fixture(t, "missing");
    await assert.rejects(runUnityTestSuite({ editorPath: "fixture", projectPath: f.projectPath, platform: "EditMode" }, f.dependencies), (error: unknown) => {
      assertFailureEvidence(error, f.projectPath, /ENOENT/);
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    });
  });
});

function assertFailureEvidence(error: unknown, projectPath: string, expected: RegExp): asserts error is Error & { resultPath: string; logPath: string } {
  assert.ok(error instanceof Error);
  assert.match(error.message, expected);
  assert.ok("resultPath" in error && typeof error.resultPath === "string");
  assert.ok("logPath" in error && typeof error.logPath === "string");
  assert.ok(error.resultPath.startsWith(join(projectPath, "Logs", "editmode-")));
  assert.ok(error.logPath.startsWith(join(projectPath, "Logs", "unity-editmode-")));
  assert.ok(error.message.includes(error.resultPath));
  assert.ok(error.message.includes(error.logPath));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function observe(promise: Promise<unknown>, timeoutMs = 8000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error })
      ),
      new Promise<{ status: "pending" }>((done) => {
        timer = setTimeout(() => done({ status: "pending" }), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
