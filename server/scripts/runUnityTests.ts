import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { assertCertifiedUnityEditor, unityEditorPath, validateUnityTestResults } from "../src/testing/unityEditor.js";

const requestedPlatform = process.argv[2] ?? "EditMode";
if (requestedPlatform !== "EditMode" && requestedPlatform !== "PlayMode") {
  throw new Error(`Unsupported Unity test platform: ${requestedPlatform}`);
}

const editorPath = unityEditorPath();
const projectPath = resolve("test-project");
const logDirectory = resolve(projectPath, "Logs");
const normalizedPlatform = requestedPlatform.toLowerCase();
const resultPath = resolve(logDirectory, `${normalizedPlatform}-${randomUUID()}-results.xml`);
const logPath = resolve(logDirectory, `unity-${normalizedPlatform}.log`);

await mkdir(logDirectory, { recursive: true });
await assertCertifiedUnityEditor(editorPath);

const child = spawn(
  editorPath,
  ["-batchmode", "-nographics", "-projectPath", projectPath, "-runTests", "-testPlatform", requestedPlatform, "-testResults", resultPath, "-logFile", logPath],
  { stdio: "inherit", windowsHide: true }
);

const exitCode = await new Promise<number>((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolveExit(code ?? 1));
});

if (exitCode !== 0) {
  throw new Error(`Unity ${requestedPlatform} tests failed with exit code ${exitCode}. See ${logPath}`);
}

if ((await stat(resultPath)).size > 32 * 1024 * 1024) throw new Error("Unity test result exceeds the 32 MiB certification limit.");
const counts = validateUnityTestResults(await readFile(resultPath, "utf8"));
await copyFile(resultPath, resolve(logDirectory, `${normalizedPlatform}-results.xml`));
console.log(`Unity ${requestedPlatform} tests passed (${counts.passed}/${counts.total}). Fresh results: ${resultPath}`);
