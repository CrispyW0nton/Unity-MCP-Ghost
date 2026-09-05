import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { assertCertifiedUnityEditor, stopOwnedProcess, validateUnityTestResults } from "./unityEditor.js";

export const defaultUnityTestTimeoutMs = 20 * 60 * 1000;

export function unityTestTimeoutMs(value: string | number | undefined): number {
  const timeoutMs = value === undefined ? defaultUnityTestTimeoutMs : typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60 * 60 * 1000) {
    throw new Error("UNITY_TEST_TIMEOUT_INVALID: UNITY_TEST_TIMEOUT_MS must be a positive integer at most 3600000.");
  }
  return timeoutMs;
}

export interface UnityTestOptions {
  editorPath: string;
  projectPath: string;
  platform: "EditMode" | "PlayMode";
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface UnityTestDependencies {
  verifyEditor?: (path: string, signal?: AbortSignal) => Promise<void>;
  launchEditor?: (path: string, args: string[]) => ChildProcess;
  stopEditor?: (child: ChildProcess) => Promise<void>;
  makeLogDirectory?: (path: string) => Promise<void>;
  statResult?: (path: string) => Promise<{ size: number }>;
  readResult?: (path: string, signal: AbortSignal) => Promise<string>;
}

/** Run an owned Editor and accept only this invocation's fresh, completely green NUnit result. */
export async function runUnityTestSuite(options: UnityTestOptions, dependencies: UnityTestDependencies = {}) {
  const timeoutMs = unityTestTimeoutMs(options.timeoutMs);
  const logDirectory = resolve(options.projectPath, "Logs");
  const normalizedPlatform = options.platform.toLowerCase();
  const runId = randomUUID();
  const resultPath = resolve(logDirectory, `${normalizedPlatform}-${runId}-results.xml`);
  const logPath = resolve(logDirectory, `unity-${normalizedPlatform}-${runId}.log`);
  const cancellation = new AbortController();
  const cancel = () =>
    cancellation.abort(
      Object.assign(new Error("UNITY_TEST_CANCELLED: Unity test runner cancelled.", { cause: options.signal?.reason }), { code: "UNITY_TEST_CANCELLED" })
    );
  const timer = setTimeout(
    () =>
      cancellation.abort(Object.assign(new Error(`UNITY_TEST_TIMEOUT: Unity ${options.platform} exceeded ${timeoutMs} ms.`), { code: "UNITY_TEST_TIMEOUT" })),
    timeoutMs
  );
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const signal = cancellation.signal;
  let child: ChildProcess | undefined;
  let failure: unknown;
  let result: { counts: ReturnType<typeof validateUnityTestResults>; resultPath: string; logPath: string } | undefined;
  // Keep spawn errors handled even if cancellation wins the exit wait.
  const onError = () => {};
  try {
    try {
      await observeUntilCancelled(async () => {
        if (dependencies.makeLogDirectory) await dependencies.makeLogDirectory(logDirectory);
        else await mkdir(logDirectory, { recursive: true });
      }, signal);
      signal.throwIfAborted();
      await (dependencies.verifyEditor ?? assertCertifiedUnityEditor)(options.editorPath, signal);
      signal.throwIfAborted();
      child = (dependencies.launchEditor ?? ((path, args) => spawn(path, args, { stdio: "inherit", windowsHide: true })))(options.editorPath, [
        "-batchmode",
        "-nographics",
        "-projectPath",
        options.projectPath,
        "-runTests",
        "-testPlatform",
        options.platform,
        "-testResults",
        resultPath,
        "-logFile",
        logPath
      ]);
      child.on("error", onError);
      const exitCode = await waitForEditorExit(child, signal);
      signal.throwIfAborted();
      if (exitCode !== 0) throw new Error(`Unity ${options.platform} tests failed with exit code ${exitCode}.`);
      const resultStat = await observeUntilCancelled(() => (dependencies.statResult ?? stat)(resultPath), signal);
      if (resultStat.size > 32 * 1024 * 1024) throw new Error("Unity test result exceeds the 32 MiB certification limit.");
      const xml = await observeUntilCancelled(
        () => (dependencies.readResult ? dependencies.readResult(resultPath, signal) : readFile(resultPath, { encoding: "utf8", signal })),
        signal
      );
      const counts = validateUnityTestResults(xml);
      signal.throwIfAborted();
      result = { counts, resultPath, logPath };
    } catch (error) {
      failure = signal.aborted ? signal.reason : error;
    }
    // Cleanup must finish even after cancellation. Keep cancellation and the
    // deadline active until cleanup completes, then accept this unique result.
    try {
      if (child) await (dependencies.stopEditor ?? stopOwnedProcess)(child);
    } catch (cleanupError) {
      const failures = result === undefined ? [failure] : [];
      if (signal.aborted && signal.reason !== failure) failures.push(signal.reason);
      throw Object.assign(new AggregateError([...failures, cleanupError], "UNITY_TEST_CLEANUP_FAILED: Owned Editor cleanup was not verified."), {
        code: "UNITY_TEST_CLEANUP_FAILED"
      });
    }
    signal.throwIfAborted();
    if (!result) throw failure;
    return result;
  } catch (error) {
    const message = `${error instanceof Error ? error.message : String(error)}\nResult: ${resultPath}\nLog: ${logPath}`;
    const enriched = error instanceof AggregateError ? new AggregateError(error.errors, message, { cause: error }) : new Error(message, { cause: error });
    throw Object.assign(enriched, { resultPath, logPath }, error && typeof error === "object" && "code" in error ? { code: error.code } : {});
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    child?.removeListener("error", onError);
  }
}

/** Abandon only observation waits: late I/O cannot advance the run or publish evidence. */
async function observeUntilCancelled<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation();
      }),
      cancelled
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function waitForEditorExit(child: ChildProcess, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode ?? 1;
  const [code] = await once(child, "exit", { signal });
  return (code as number | null) ?? 1;
}
