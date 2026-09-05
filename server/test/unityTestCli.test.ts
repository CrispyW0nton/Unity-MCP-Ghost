import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { runUnityTestCli } from "../src/testing/unityTestCli.js";
import { defaultUnityTestTimeoutMs, type UnityTestOptions } from "../src/testing/unityTestRunner.js";

const result = {
  counts: { total: 2, passed: 2, failed: 0, skipped: 0, inconclusive: 0 },
  resultPath: "fresh-results.xml",
  logPath: "fresh-editor.log"
};

function fixture(platform?: string, timeout?: string) {
  const signals = Object.assign(new EventEmitter(), {
    argv: platform === undefined ? ["node", "runUnityTests.ts"] : ["node", "runUnityTests.ts", platform],
    env: { UNITY_TEST_TIMEOUT_MS: timeout }
  });
  const existingListener = () => {};
  signals.on("SIGINT", existingListener);
  signals.on("SIGTERM", existingListener);
  const messages: string[] = [];
  const assertListenersRestored = () => {
    assert.deepEqual(signals.listeners("SIGINT"), [existingListener]);
    assert.deepEqual(signals.listeners("SIGTERM"), [existingListener]);
  };
  return {
    signals,
    messages,
    assertListenersRestored,
    dependencies: { process: signals, editorPath: () => "fixture-editor", log: (message: string) => messages.push(message) }
  };
}

describe("Unity test CLI", () => {
  for (const platform of [undefined, "EditMode", "PlayMode"]) {
    it(`forwards ${platform ?? "the default platform"} and reports unique evidence after success`, async () => {
      const f = fixture(platform, platform === "PlayMode" ? "4500" : undefined);
      let observed: UnityTestOptions | undefined;
      await runUnityTestCli({
        ...f.dependencies,
        runSuite: async (options) => {
          observed = options;
          assert.equal(f.signals.listenerCount("SIGINT"), 2);
          assert.equal(f.signals.listenerCount("SIGTERM"), 2);
          return result;
        }
      });
      assert.ok(observed);
      assert.equal(observed.platform, platform ?? "EditMode");
      assert.equal(observed.editorPath, "fixture-editor");
      assert.equal(observed.projectPath, resolve("test-project"));
      assert.equal(observed.timeoutMs, platform === "PlayMode" ? 4500 : defaultUnityTestTimeoutMs);
      assert.equal(observed.signal?.aborted, false);
      assert.deepEqual(f.messages, [`Unity ${platform ?? "EditMode"} tests passed (2/2). Fresh results: fresh-results.xml. Log: fresh-editor.log`]);
      f.assertListenersRestored();
    });
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`forwards ${signal} as suite cancellation and removes only its own signal listeners`, async () => {
      const f = fixture();
      let observed: AbortSignal | undefined;
      let release!: () => void;
      const running = runUnityTestCli({
        ...f.dependencies,
        runSuite: async (options) => {
          const signal = options.signal;
          assert.ok(signal);
          observed = signal;
          return await new Promise<typeof result>((done, reject) => {
            release = () => done(result);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
      });
      const rejected = assert.rejects(running, /Unity test CLI interrupted/);
      try {
        assert.ok(observed);
        assert.equal(observed.aborted, false);
        f.signals.emit(signal);
        assert.equal(observed.aborted, true);
        await rejected;
        assert.deepEqual(f.messages, [], "Cancellation must not print a successful test result");
        f.assertListenersRestored();
      } finally {
        release();
        await rejected.catch(() => {});
      }
    });
  }

  for (const stage of ["editor path", "suite setup", "suite rejection", "output"] as const) {
    it(`removes listeners and preserves the error after ${stage} failure`, async () => {
      const f = fixture();
      const failure = new Error(`controlled ${stage} failure`);
      let launched = false;
      await assert.rejects(
        runUnityTestCli({
          ...f.dependencies,
          editorPath: () => {
            if (stage === "editor path") throw failure;
            return "fixture-editor";
          },
          runSuite: () => {
            launched = true;
            if (stage === "suite setup") throw failure;
            return stage === "suite rejection" ? Promise.reject(failure) : Promise.resolve(result);
          },
          log: () => {
            throw failure;
          }
        }),
        (error: unknown) => error === failure
      );
      assert.equal(launched, stage !== "editor path");
      f.assertListenersRestored();
    });
  }

  for (const invalid of ["platform", "timeout"] as const) {
    it(`rejects an invalid ${invalid} without launching a suite or leaking listeners`, async () => {
      const f = fixture(invalid === "platform" ? "Editor" : undefined, invalid === "timeout" ? "0" : undefined);
      let launched = false;
      await assert.rejects(
        runUnityTestCli({
          ...f.dependencies,
          runSuite: async () => {
            launched = true;
            return result;
          }
        }),
        invalid === "platform" ? /Unsupported Unity test platform: Editor/ : /UNITY_TEST_TIMEOUT_INVALID/
      );
      assert.equal(launched, false);
      assert.deepEqual(f.messages, []);
      f.assertListenersRestored();
    });
  }

  it("cleans up a partially registered signal pair when synchronous listener setup fails", async () => {
    const f = fixture();
    const failure = new Error("controlled SIGTERM registration failure");
    let launched = false;
    f.signals.on("newListener", (event) => {
      if (event === "SIGTERM") throw failure;
    });
    await assert.rejects(
      runUnityTestCli({
        ...f.dependencies,
        runSuite: async () => {
          launched = true;
          return result;
        }
      }),
      (error: unknown) => error === failure
    );
    assert.equal(launched, false);
    assert.deepEqual(f.messages, []);
    f.assertListenersRestored();
  });
});
