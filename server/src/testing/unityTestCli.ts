import { resolve } from "node:path";
import { unityEditorPath } from "./unityEditor.js";
import { runUnityTestSuite, unityTestTimeoutMs } from "./unityTestRunner.js";

export interface UnityTestCliDependencies {
  process?: {
    argv: readonly string[];
    env: { UNITY_TEST_TIMEOUT_MS?: string };
    on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
    removeListener: (signal: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
  };
  editorPath?: () => string;
  runSuite?: typeof runUnityTestSuite;
  log?: (message: string) => void;
}

/** CLI lifecycle, kept injectable so signal wiring can be verified without launching Unity. */
export async function runUnityTestCli(dependencies: UnityTestCliDependencies = {}): Promise<void> {
  const cliProcess = dependencies.process ?? process;
  const requestedPlatform = cliProcess.argv[2] ?? "EditMode";
  if (requestedPlatform !== "EditMode" && requestedPlatform !== "PlayMode") {
    throw new Error(`Unsupported Unity test platform: ${requestedPlatform}`);
  }

  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error("Unity test CLI interrupted."));
  try {
    cliProcess.on("SIGINT", cancel);
    cliProcess.on("SIGTERM", cancel);
    const { counts, resultPath, logPath } = await (dependencies.runSuite ?? runUnityTestSuite)({
      editorPath: (dependencies.editorPath ?? unityEditorPath)(),
      projectPath: resolve("test-project"),
      platform: requestedPlatform,
      timeoutMs: unityTestTimeoutMs(cliProcess.env.UNITY_TEST_TIMEOUT_MS),
      signal: cancellation.signal
    });
    (dependencies.log ?? console.log)(
      `Unity ${requestedPlatform} tests passed (${counts.passed}/${counts.total}). Fresh results: ${resultPath}. Log: ${logPath}`
    );
  } finally {
    cliProcess.removeListener("SIGINT", cancel);
    cliProcess.removeListener("SIGTERM", cancel);
  }
}
