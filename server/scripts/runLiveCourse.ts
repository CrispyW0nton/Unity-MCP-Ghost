import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";

const editorPath =
  process.env.UNITY_EDITOR_PATH ??
  (platform() === "win32"
    ? "C:\\Program Files\\Unity\\Hub\\Editor\\2022.3.62f1\\Editor\\Unity.exe"
    : platform() === "darwin"
      ? "/Applications/Unity/Hub/Editor/2022.3.62f1/Unity.app/Contents/MacOS/Unity"
      : "/opt/unity/Editor/Unity");
const projectPath = resolve("test-project");
const logDirectory = resolve(projectPath, "Logs");
const logPath = resolve(logDirectory, "unity-live-course.log");
const identityPath = resolve(projectPath, "Library", "UnityMcpGhost", "bridge-identity.json");
const npmCommand = platform() === "win32" ? "npm.cmd" : "npm";

await mkdir(logDirectory, { recursive: true });
await rm(identityPath, { force: true });
const unity = spawn(editorPath, ["-projectPath", projectPath, "-logFile", logPath], { stdio: "ignore" });

try {
  await waitForBridge(identityPath, 180_000);
  const exitCode = await run(npmCommand, ["run", "test:course"]);
  if (exitCode !== 0) throw new Error(`Live GAM 215 course smoke failed with exit code ${exitCode}. See ${logPath}`);
  process.stdout.write(`Live GAM 215 course smoke passed. Unity log: ${logPath}\n`);
} finally {
  unity.kill();
  await Promise.race([new Promise<void>((resolveExit) => unity.once("exit", () => resolveExit())), delay(10_000)]);
  if (unity.exitCode === null) unity.kill("SIGKILL");
}

async function waitForBridge(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const identity = JSON.parse(await readFile(path, "utf8")) as { running?: boolean; heartbeatUtc?: string };
      const heartbeat = Date.parse(identity.heartbeatUtc ?? "");
      if (identity.running === true && Number.isFinite(heartbeat) && Date.now() - heartbeat < 30_000) return;
    } catch {
      // Unity may still be importing the clean test project.
    }
    await delay(500);
  }
  throw new Error(`Unity bridge did not become ready within ${timeoutMs} ms. See ${logPath}`);
}

function run(command: string, args: string[]): Promise<number> {
  const windows = platform() === "win32";
  const executable = windows ? (process.env.ComSpec ?? "cmd.exe") : command;
  const executableArgs = windows ? ["/d", "/s", "/c", command, ...args] : args;
  const child = spawn(executable, executableArgs, { stdio: "inherit" });
  return new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
