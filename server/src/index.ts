#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readConfig } from "./config.js";
import { createMcpServer } from "./mcp/createServer.js";
import { UnityClient } from "./unity/UnityClient.js";

async function main(): Promise<void> {
  const config = readConfig(process.argv.slice(2));
  const unity = new UnityClient({
    host: config.unityHost,
    port: config.unityPort,
    queueDir: config.unityQueueDir,
    requestTimeoutMs: config.requestTimeoutMs
  });

  const server = createMcpServer({ unity });

  if (config.transport === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
