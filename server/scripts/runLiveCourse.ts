import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";
import { assertCertifiedUnityEditor, assertCertifiedUnityVersion, stopOwnedProcess, unityEditorPath } from "../src/testing/unityEditor.js";

const editorPath = unityEditorPath();
const projectPath = resolve("test-project");
const logDirectory = resolve(projectPath, "Logs");
const logPath = resolve(logDirectory, "unity-live-course.log");
const identityPath = resolve(projectPath, "Library", "UnityMcpGhost", "bridge-identity.json");
const npmCommand = platform() === "win32" ? "npm.cmd" : "npm";

await mkdir(logDirectory, { recursive: true });
await assertCertifiedUnityEditor(editorPath);
// Never remove another running Editor's identity to manufacture a fresh startup.
const priorIdentity = await readFile(identityPath, "utf8")
  .then((value) => JSON.parse(value) as { editorInstanceId?: string })
  .catch(() => undefined);
const unity = spawn(editorPath, ["-batchmode", "-projectPath", projectPath, "-logFile", logPath], { stdio: "ignore", windowsHide: true });
let startupError: Error | undefined;
unity.once("error", (error) => {
  startupError = error;
});
const cancellation = new AbortController();
const cancel = (): void => cancellation.abort(new Error("Live course runner cancelled."));
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);

try {
  await waitForBridge(identityPath, 420_000);
  const exitCode = await run(npmCommand, ["run", "test:course"], cancellation.signal);
  if (exitCode !== 0) throw new Error(`Live GAM 215 course smoke failed with exit code ${exitCode}. See ${logPath}`);
  process.stdout.write(`Live GAM 215 course smoke passed. Unity log: ${logPath}\n`);
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  await stopOwnedProcess(unity);
}

async function waitForBridge(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    cancellation.signal.throwIfAborted();
    if (startupError) throw startupError;
    if (unity.exitCode !== null || unity.signalCode !== null) throw new Error(`Owned Unity Editor exited before bridge startup. See ${logPath}`);
    let identity: { running?: boolean; heartbeatUtc?: string; editorInstanceId?: string; projectRoot?: string; unityVersion?: string } | undefined;
    try {
      identity = JSON.parse(await readFile(path, "utf8")) as typeof identity;
    } catch {
      // Unity may still be importing the clean test project.
    }
    const heartbeat = Date.parse(identity?.heartbeatUtc ?? "");
    if (
      identity?.running === true &&
      identity.editorInstanceId &&
      identity.editorInstanceId !== priorIdentity?.editorInstanceId &&
      Number.isFinite(heartbeat) &&
      Date.now() - heartbeat < 30_000
    ) {
      const actualRoot = resolve(identity.projectRoot ?? "");
      if ((platform() === "win32" ? actualRoot.toLowerCase() : actualRoot) !== (platform() === "win32" ? projectPath.toLowerCase() : projectPath)) {
        throw new Error("Live course bridge identity does not belong to the owned fixture project.");
      }
      assertCertifiedUnityVersion(identity.unityVersion ?? "");
      return;
    }
    await delay(500);
  }
  throw new Error(`Unity bridge did not become ready within ${timeoutMs} ms. See ${logPath}`);
}

function run(command: string, args: string[], signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const windows = platform() === "win32";
  const executable = windows ? (process.env.ComSpec ?? "cmd.exe") : command;
  const executableArgs = windows ? ["/d", "/s", "/c", command, ...args] : args;
  const child = spawn(executable, executableArgs, { stdio: "inherit", windowsHide: true });
  return new Promise<number>((resolveExit, reject) => {
    const abort = (): void => {
      void stopOwnedProcess(child).then(() => reject(signal.reason), reject);
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("exit", (code) => {
      signal.removeEventListener("abort", abort);
      resolveExit(signal.aborted ? 1 : (code ?? 1));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
