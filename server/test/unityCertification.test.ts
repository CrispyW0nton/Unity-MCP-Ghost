import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { platform } from "node:os";
import { describe, it } from "node:test";
import { assertCertifiedUnityVersion, stopOwnedProcess, validateUnityTestResults } from "../src/testing/unityEditor.js";

describe("Unity certification evidence", () => {
  it("does not hide failed descendant cleanup when the root has already exited", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    await once(child, "spawn");
    const failure = new Error("Descendant cleanup failed after root exit");
    await assert.rejects(
      stopOwnedProcess(child, async () => {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        throw failure;
      }),
      failure
    );
  });

  it("stops a real Windows descendant without touching an unrelated child", { skip: platform() !== "win32" }, async () => {
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const {spawn}=require('node:child_process'); const descendant=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore',windowsHide:true}); descendant.once('spawn',()=>process.send({pid:descendant.pid})); setInterval(() => {},1000);"
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true }
    );
    let descendantPid: number | undefined;
    try {
      const [message] = await once(child, "message", { signal: AbortSignal.timeout(10000) });
      descendantPid = (message as { pid: number }).pid;
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
      process.kill(descendantPid, 0);
      await stopOwnedProcess(child);
      const deadline = Date.now() + 5000;
      while (isProcessAlive(descendantPid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
      assert.equal(isProcessAlive(descendantPid), false, "Owned descendant survived process-tree cleanup");
      assert.equal(sentinel.exitCode, null);
      assert.equal(sentinel.signalCode, null);
      process.kill(sentinel.pid!, 0);
    } finally {
      // Clean only these test-owned processes even when the regression is red.
      for (const owned of [child, sentinel]) {
        if (owned.exitCode === null && owned.signalCode === null) {
          const exited = once(owned, "exit");
          owned.kill("SIGKILL");
          await exited;
        }
      }
      if (descendantPid && isProcessAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    }
  });

  it("still stops its owned child when tree termination fails, but does not certify tree cleanup", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    try {
      await new Promise<void>((resolveSpawn, reject) => {
        child.once("spawn", resolveSpawn);
        child.once("error", reject);
      });
      const failure = new Error("Synthetic process-tree termination failure");
      await assert.rejects(
        stopOwnedProcess(child, async () => {
          throw failure;
        }),
        failure
      );
      assert.ok(child.exitCode !== null || child.signalCode !== null);
    } finally {
      // The red regression must not strand its synthetic child or hang the suite.
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((done) => child.once("exit", () => done()));
        child.kill("SIGKILL");
        await exited;
      }
    }
  });

  it("stops only its owned child and awaits observed exit", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    try {
      await new Promise<void>((resolveSpawn, reject) => {
        child.once("spawn", resolveSpawn);
        child.once("error", reject);
      });
      await stopOwnedProcess(child);
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      await stopOwnedProcess(child);
    } finally {
      await stopOwnedProcess(child);
    }
  });

  it("accepts only the exact advertised Editor version", () => {
    assert.doesNotThrow(() => assertCertifiedUnityVersion("2022.3.62f1\r\n"));
    for (const version of ["", "2022.3.61f1", "6000.3.2f1", "2022.3.62f1 unexpected"]) {
      assert.throws(() => assertCertifiedUnityVersion(version), /version/i);
    }
  });

  it("requires a complete nonempty green NUnit result", () => {
    const valid = '<test-run result="Passed" total="105" passed="105" failed="0" skipped="0" inconclusive="0"></test-run>';
    assert.deepEqual(validateUnityTestResults(valid), { total: 105, passed: 105, failed: 0, skipped: 0, inconclusive: 0 });
    for (const invalid of [
      "",
      valid.replace('result="Passed"', 'result="Failed"'),
      valid.replace('failed="0"', 'failed="1"'),
      valid.replace('passed="105"', 'passed="104"'),
      valid.replaceAll('="105"', '="0"'),
      valid.replace('skipped="0"', 'skipped="1"'),
      valid.replace('inconclusive="0"', 'inconclusive="1"'),
      valid.replace('total="105"', 'total="105" total="1"'),
      valid.replace("</test-run>", ""),
      valid.replace('total="105"', 'total="NaN"')
    ]) {
      assert.throws(() => validateUnityTestResults(invalid), /Unity test result/i);
    }
  });
});

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
