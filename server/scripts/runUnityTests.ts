import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";

const requestedPlatform = process.argv[2] ?? "EditMode";
if (requestedPlatform !== "EditMode" && requestedPlatform !== "PlayMode") {
  throw new Error(`Unsupported Unity test platform: ${requestedPlatform}`);
}

const editorPath =
  process.env.UNITY_EDITOR_PATH ??
  (platform() === "win32"
    ? "C:\\Program Files\\Unity\\Hub\\Editor\\2022.3.62f1\\Editor\\Unity.exe"
    : platform() === "darwin"
      ? "/Applications/Unity/Hub/Editor/2022.3.62f1/Unity.app/Contents/MacOS/Unity"
      : "/opt/unity/Editor/Unity");
const projectPath = resolve("test-project");
const logDirectory = resolve(projectPath, "Logs");
const normalizedPlatform = requestedPlatform.toLowerCase();
const resultPath = resolve(logDirectory, `${normalizedPlatform}-results.xml`);
const logPath = resolve(logDirectory, `unity-${normalizedPlatform}.log`);

await mkdir(logDirectory, { recursive: true });

const child = spawn(
  editorPath,
  ["-batchmode", "-nographics", "-projectPath", projectPath, "-runTests", "-testPlatform", requestedPlatform, "-testResults", resultPath, "-logFile", logPath],
  { stdio: "inherit" }
);

const exitCode = await new Promise<number>((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolveExit(code ?? 1));
});

if (exitCode !== 0) {
  throw new Error(`Unity ${requestedPlatform} tests failed with exit code ${exitCode}. See ${logPath}`);
}

console.log(`Unity ${requestedPlatform} tests passed. Results: ${resultPath}`);
