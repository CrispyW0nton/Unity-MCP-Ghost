import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { readConfig } from "./config.js";
import { createMcpServer } from "./mcp/createServer.js";
import { UnityClient } from "./unity/UnityClient.js";
import { ScenarioJobManager } from "./scenario/ScenarioJobManager.js";
import { startStreamableHttp, type StreamableHttpService } from "./transports/streamableHttp.js";

export interface McpCliDependencies {
  process?: {
    argv: readonly string[];
    exitCode?: number | string;
    on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  };
  readConfig?: typeof readConfig;
  createUnity?: (options: ConstructorParameters<typeof UnityClient>[0]) => UnityClient;
  createScenarios?: (options: ConstructorParameters<typeof ScenarioJobManager>[0]) => ScenarioJobManager;
  createServer?: typeof createMcpServer;
  createStdioTransport?: () => Transport;
  startHttp?: typeof startStreamableHttp;
  writeError?: (message: string) => void | Promise<void>;
}

/** Actual executable coordinator. HTTP owns signal handling and waits for jobs before releasing Unity. */
export async function runMcpCli(dependencies: McpCliDependencies = {}): Promise<{ exitCode: 0 | 1; failureCodes: string[] }> {
  const cliProcess = dependencies.process ?? process;
  const failureCodes: string[] = [];
  const createServer = dependencies.createServer ?? createMcpServer;
  let unity: UnityClient | undefined;
  let scenarios: ScenarioJobManager | undefined;
  let service: StreamableHttpService | undefined;
  let stdioServer: ReturnType<typeof createMcpServer> | undefined;
  let ownsSignals = false;
  const pendingOutput = new Set<Promise<void>>();
  let completed = false;
  let requestStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const signal = () => requestStop();

  function outputFailed(): void {
    if (!failureCodes.includes("MCP_CLI_OUTPUT_FAILED")) failureCodes.push("MCP_CLI_OUTPUT_FAILED");
    cliProcess.exitCode = 1;
    requestStop();
  }
  function write(message: string): void {
    try {
      const output = dependencies.writeError
        ? dependencies.writeError(message)
        : new Promise<void>((resolve, reject) => {
            process.stderr.write(message, (error) => (error ? reject(error) : resolve()));
          });
      const pending = Promise.resolve(output).catch(outputFailed);
      pendingOutput.add(pending);
      void pending.then(() => pendingOutput.delete(pending));
    } catch {
      outputFailed();
    }
  }
  function fail(code: string): void {
    if (!failureCodes.includes(code)) {
      failureCodes.push(code);
      cliProcess.exitCode = 1;
      // Exception text and arbitrary error.code values can include authentication secrets.
      write(`${code}\n`);
    }
  }

  try {
    if (!dependencies.writeError) process.stderr.on("error", outputFailed);
    const config = (dependencies.readConfig ?? readConfig)(cliProcess.argv.slice(2));
    unity = (dependencies.createUnity ?? ((options) => new UnityClient(options)))({
      host: config.unityHost,
      port: config.unityPort,
      webSocketPort: config.unityWebSocketPort,
      queueDir: config.unityQueueDir,
      requestTimeoutMs: config.requestTimeoutMs,
      projectId: config.unityProjectId,
      editorInstanceId: config.unityEditorInstanceId,
      tokenFile: config.unityTokenFile
    });
    const context = {
      unity,
      projectPath: config.unityProjectPath,
      projectId: config.unityProjectId,
      editorInstanceId: config.unityEditorInstanceId,
      toolProfiles: config.toolProfiles
    };
    if (config.transport === "stdio") {
      stdioServer = createServer(context);
      await stdioServer.connect((dependencies.createStdioTransport ?? (() => new StdioServerTransport()))());
      // The established stdio transport owns its normal lifetime.
      if (!dependencies.writeError) process.stderr.removeListener("error", outputFailed);
      return { exitCode: 0, failureCodes };
    }
    scenarios = (dependencies.createScenarios ?? ((options) => new ScenarioJobManager(options)))(context);
    ownsSignals = true;
    cliProcess.on("SIGINT", signal);
    cliProcess.on("SIGTERM", signal);
    service = await (dependencies.startHttp ?? startStreamableHttp)({
      host: config.mcpHost,
      port: config.mcpPort,
      projectId: config.unityProjectId,
      editorInstanceId: config.unityEditorInstanceId,
      tokenFile: config.unityTokenFile,
      limits: { requestTimeoutMs: config.requestTimeoutMs },
      createServer: () => createServer({ ...context, scenarios })
    });
    void service.fatalError.then(() => {
      if (completed) return;
      fail("MCP_HTTP_LISTENER_FAILED");
      requestStop();
    });
    write(`Unity MCP Ghost listening at ${service.url} (private loopback, authenticated, project/editor pinned).\n`);
    await stopped;
  } catch {
    fail("MCP_CLI_STARTUP_FAILED");
  }

  // Keep our signal listeners installed throughout cleanup: a repeated signal must not bypass restoration.
  let drained = true;
  if (service) {
    try {
      const receipt = await service.close();
      if (receipt.outcomeUnknown)
        write(`MCP HTTP stopped with ${receipt.unfinishedRequests} unfinished request(s); reconcile durable operations before retrying mutations.\n`);
    } catch {
      fail("MCP_HTTP_CLOSE_FAILED");
    }
    try {
      await service.drain();
    } catch {
      drained = false;
      fail("MCP_HTTP_DRAIN_FAILED");
    }
  }
  if (scenarios) {
    try {
      const receipt = await scenarios.close();
      if (receipt.outcomeUnknown) fail("MCP_SCENARIO_OUTCOME_UNKNOWN");
    } catch {
      drained = false;
      fail("MCP_SCENARIO_DRAIN_FAILED");
    }
  }
  if (stdioServer) {
    try {
      await stdioServer.close();
    } catch {
      drained = false;
      fail("MCP_STDIO_CLOSE_FAILED");
    }
  }
  if (drained && unity) {
    try {
      unity.dispose();
    } catch {
      fail("MCP_UNITY_DISPOSE_FAILED");
    }
  }
  if (ownsSignals) {
    for (const name of ["SIGINT", "SIGTERM"] as const) {
      try {
        cliProcess.removeListener(name, signal);
      } catch {
        fail("MCP_CLI_SIGNAL_CLEANUP_FAILED");
      }
    }
  }
  while (pendingOutput.size) await Promise.all([...pendingOutput]);
  if (!dependencies.writeError) process.stderr.removeListener("error", outputFailed);
  completed = true;
  return { exitCode: failureCodes.length ? 1 : 0, failureCodes };
}
