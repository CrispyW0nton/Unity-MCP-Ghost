import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertCertifiedUnityEditor, stopOwnedProcess } from "../src/testing/unityEditor.js";

describe("owned Unity version probe", () => {
  for (const terminal of ["success", "timeout", "cancel", "supervisor-loss"] as const) {
    it(`retains descendant ownership after root exit before ${terminal}`, { skip: platform() !== "win32", timeout: 30000 }, async () => {
      const directory = await mkdtemp(join(tmpdir(), "ghost-version-root-exit-"));
      const receiptPath = join(directory, "owned-processes.json");
      const cancellation = new AbortController();
      let owned: { root: number; descendant: number; supervisor: number } | undefined;
      const code = `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: ${terminal === "success" ? "'ignore'" : "['ignore', process.stdout, process.stderr]"}, windowsHide: true, detached: true
        });
        helper.once('spawn', () => {
          writeFileSync(process.argv[1], JSON.stringify({ root: process.pid, descendant: helper.pid, supervisor: process.ppid }));
          process.stdout.write('2022.3.62f1\\n', () => process.exit(0));
        });
      `;
      const observed = assertCertifiedUnityEditor(process.execPath, cancellation.signal, {
        versionArguments: ["-e", code, receiptPath],
        timeoutMs: terminal === "timeout" ? 5000 : 15000
      }).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error })
      );
      try {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          try {
            owned = JSON.parse(await readFile(receiptPath, "utf8")) as typeof owned;
          } catch {
            /* receipt not written yet */
          }
          if (owned && !isProcessAlive(owned.root)) break;
          await new Promise((done) => setTimeout(done, 25));
        }
        assert.ok(owned, "The test program did not create its descendant");
        assert.ok(Number.isSafeInteger(owned.root) && owned.root > 0);
        assert.ok(Number.isSafeInteger(owned.descendant) && owned.descendant > 0);
        assert.equal(isProcessAlive(owned.root), false, "Fixture must observe root exit before its terminal action");
        if (terminal === "cancel") cancellation.abort(new Error("Cancel after observed root exit"));
        if (terminal === "supervisor-loss") {
          assert.ok(Number.isSafeInteger(owned.supervisor) && owned.supervisor > 0);
          assert.notEqual(owned.supervisor, process.pid, "The fixture must be owned by its dedicated supervisor");
          process.kill(owned.supervisor, "SIGKILL");
        }
        const { error } = await observed;
        if (terminal === "success") assert.equal(error, undefined);
        else if (terminal === "cancel") assert.equal(error, cancellation.signal.reason);
        else if (terminal === "timeout") assert.ok(error instanceof Error && "code" in error && error.code === "UNITY_VERSION_TIMEOUT");
        else {
          assert.ok(error instanceof AggregateError && "code" in error && error.code === "UNITY_VERSION_CLEANUP_FAILED");
          assert.ok(error.errors.some((item: unknown) => item instanceof Error && "code" in item && item.code === "UNITY_VERSION_OWNER_FAILED"));
          // Kernel kill-on-close is a fail-safe. It must kill the owned helper,
          // but a dead supervisor cannot provide the normal empty-job proof.
          const killDeadline = Date.now() + 5000;
          while (isProcessAlive(owned.descendant) && Date.now() < killDeadline) await new Promise((done) => setTimeout(done, 25));
        }
        assert.equal(isProcessAlive(owned.descendant), false, "Owned helper survived an exited version root");
        assert.equal(getEventListeners(cancellation.signal, "abort").length, 0);
      } finally {
        cancellation.abort(new Error("Test cleanup"));
        await observed;
        for (const pid of [owned?.root, owned?.descendant]) {
          if (pid && isProcessAlive(pid)) process.kill(pid, "SIGKILL");
        }
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  for (const terminal of ["cancel", "timeout", "stdout-limit", "stderr-limit"] as const) {
    it(`awaits root and descendant cleanup after ${terminal}`, { skip: platform() !== "win32", timeout: 30000 }, async () => {
      const directory = await mkdtemp(join(tmpdir(), "ghost-version-probe-"));
      const receiptPath = join(directory, "owned-processes.json");
      const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
      const cancellation = new AbortController();
      let owned: { root: number; descendant: number } | undefined;
      // The helper is deliberately independent of the root's standard streams.
      // Killing only the root therefore cannot masquerade as tree cleanup.
      const code = `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
        helper.once('spawn', () => {
          writeFileSync(process.argv[1], JSON.stringify({ root: process.pid, descendant: helper.pid }));
          ${terminal === "stdout-limit" ? "process.stdout.write('x'.repeat(5000));" : ""}
          ${terminal === "stderr-limit" ? "process.stderr.write('x'.repeat(5000));" : ""}
        });
        setInterval(() => {}, 1000);
      `;
      const observed = assertCertifiedUnityEditor(process.execPath, cancellation.signal, {
        versionArguments: ["-e", code, receiptPath],
        timeoutMs: terminal === "timeout" ? 3000 : 15000
      }).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error })
      );
      try {
        const deadline = Date.now() + 10000;
        while (!owned && Date.now() < deadline) {
          try {
            owned = JSON.parse(await readFile(receiptPath, "utf8")) as typeof owned;
          } catch {
            await new Promise((done) => setTimeout(done, 25));
          }
        }
        assert.ok(owned, "The test program did not create its descendant");
        assert.ok(Number.isSafeInteger(owned.root) && owned.root > 0);
        assert.ok(Number.isSafeInteger(owned.descendant) && owned.descendant > 0);
        if (terminal === "cancel") cancellation.abort(new Error("Version probe test cancellation"));
        const { error } = await observed;
        assert.ok(error instanceof Error, "Failed verification must not certify the Editor");
        if (terminal === "cancel") assert.equal(error, cancellation.signal.reason);
        else assert.ok("code" in error && error.code === (terminal === "timeout" ? "UNITY_VERSION_TIMEOUT" : "UNITY_VERSION_OUTPUT_LIMIT"));
        assert.equal(getEventListeners(cancellation.signal, "abort").length, 0);
        assert.equal(isProcessAlive(owned.root), false, "Owned version process survived completion");
        assert.equal(isProcessAlive(owned.descendant), false, "Owned version descendant survived completion");
        assert.ok(sentinel.pid);
        assert.equal(isProcessAlive(sentinel.pid), true, "Unrelated process was terminated");
      } finally {
        cancellation.abort(new Error("Test cleanup"));
        await observed;
        for (const pid of [owned?.root, owned?.descendant]) {
          if (pid && isProcessAlive(pid)) process.kill(pid, "SIGKILL");
        }
        await stopOwnedProcess(sentinel);
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it("accepts a complete exact version from a normally exited process", async () => {
    await assertCertifiedUnityEditor(process.execPath, undefined, { versionArguments: ["-e", "console.log('2022.3.62f1')"] });
  });

  it("preserves quoted, empty, Unicode and shell-looking version arguments as data", async () => {
    const args = ["", "spaces and tabs\t", 'embedded"quote', "trailing\\", 'slashes\\\\"quote', "é東京", "$(throw 'injected'); & echo nope", "line\nbreak"];
    await assertCertifiedUnityEditor(process.execPath, undefined, {
      versionArguments: ["-e", `require('node:assert/strict').deepEqual(process.argv.slice(1), ${JSON.stringify(args)}); console.log('2022.3.62f1')`, ...args]
    });
  });

  it("enforces byte limits at the exact boundary, including multibyte stderr", async () => {
    await assertCertifiedUnityEditor(process.execPath, undefined, {
      versionArguments: ["-e", "process.stdout.write('2022.3.62f1'.padEnd(4096)); process.stderr.write('é'.repeat(2048))"]
    });
    await assert.rejects(
      assertCertifiedUnityEditor(process.execPath, undefined, { versionArguments: ["-e", "process.stderr.write('é'.repeat(2049))"] }),
      (error: unknown) => {
        // The short-lived child may exit before tree termination starts. In
        // that race uncertainty stays visible, alongside the primary limit.
        const errors: unknown[] = error instanceof AggregateError ? error.errors : [error];
        return errors.some((item) => item instanceof Error && "code" in item && item.code === "UNITY_VERSION_OUTPUT_LIMIT");
      }
    );
  });

  it("does not launch when pre-cancelled or given an invalid timeout", async () => {
    const reason = new Error("Already cancelled");
    const signal = AbortSignal.abort(reason);
    let cleanupCalled = false;
    await assert.rejects(
      assertCertifiedUnityEditor("must-not-launch", signal, {
        stopVersion: async () => {
          cleanupCalled = true;
        }
      }),
      (error: unknown) => error === reason
    );
    assert.equal(cleanupCalled, false);
    assert.equal(getEventListeners(signal, "abort").length, 0);
    for (const timeoutMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 15001]) {
      await assert.rejects(assertCertifiedUnityEditor("must-not-launch", undefined, { timeoutMs }), /timeout must be/);
    }
  });

  it("fails closed with cleanup uncertainty when PowerShell cannot start", { skip: platform() !== "win32" }, async () => {
    const originalPath = process.env.PATH;
    let result: Promise<void>;
    try {
      process.env.PATH = join(tmpdir(), "ghost-version-no-powershell");
      result = assertCertifiedUnityEditor(process.execPath, undefined, { versionArguments: ["-e", "console.log('2022.3.62f1')"] });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof AggregateError && "code" in error && error.code === "UNITY_VERSION_CLEANUP_FAILED");
      assert.ok(error.errors.some((item: unknown) => item instanceof Error && "code" in item && item.code === "ENOENT"));
      return true;
    });
  });

  it("awaits cleanup and observes cancellation arriving during cleanup", async () => {
    let beginCleanup!: () => void;
    const enteredCleanup = new Promise<void>((resolve) => {
      beginCleanup = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cancellation = new AbortController();
    let completed = false;
    const result = assertCertifiedUnityEditor(process.execPath, cancellation.signal, {
      versionArguments: ["-e", "console.log('2022.3.62f1')"],
      stopVersion: async (child) => {
        assert.equal(child.exitCode, 0);
        beginCleanup();
        await cleanupGate;
      }
    }).then(
      () => {
        completed = true;
        return undefined;
      },
      (error: unknown) => {
        completed = true;
        return error;
      }
    );
    try {
      await enteredCleanup;
      assert.equal(completed, false);
      cancellation.abort(new Error("Cancel while awaiting cleanup"));
    } finally {
      releaseCleanup();
    }
    assert.equal(await result, cancellation.signal.reason);
    assert.equal(getEventListeners(cancellation.signal, "abort").length, 0);
  });

  it("rejects wrong versions, failed exits and spawn failures", async () => {
    await assert.rejects(assertCertifiedUnityEditor(process.execPath, undefined, { versionArguments: ["-e", "console.log('6000.3.2f1')"] }));
    await assert.rejects(assertCertifiedUnityEditor(process.execPath, undefined, { versionArguments: ["-e", "console.log('2022.3.62f1'); process.exit(2)"] }));
    await assert.rejects(assertCertifiedUnityEditor(join(tmpdir(), "ghost-version-nonexistent", "Unity.exe")));
  });

  it("retains cancellation and cleanup errors together", async () => {
    const cancellation = new AbortController();
    const primary = new Error("Cancel probe");
    const cleanup = new Error("Cannot prove descendant cleanup");
    let cleanupChild: ChildProcess | undefined;
    const result = assertCertifiedUnityEditor(process.execPath, cancellation.signal, {
      versionArguments: ["-e", "setInterval(() => {}, 1000)"],
      stopVersion: async (child) => {
        cleanupChild = child;
        await stopOwnedProcess(child);
        throw cleanup;
      }
    });
    cancellation.abort(primary);
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.includes(primary));
      assert.ok(error.errors.includes(cleanup));
      return true;
    });
    assert.ok(cleanupChild);
    assert.ok(cleanupChild.exitCode !== null || cleanupChild.signalCode !== null);
  });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
