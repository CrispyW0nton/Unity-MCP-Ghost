#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../src/config.js";

const config = readConfig(process.argv.slice(2));
if (!config.unityProjectPath) {
  throw new Error("Client configuration generation requires --unity-project-path.");
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const clientConfig = {
  mcpServers: {
    "unity-mcp-ghost": {
      command: "node",
      args: [
        resolve(repositoryRoot, "dist/index.js"),
        "--transport",
        "stdio",
        "--tool-profile",
        config.toolProfiles.join(","),
        "--unity-project-path",
        config.unityProjectPath
      ]
    }
  }
};

process.stdout.write(`${JSON.stringify(clientConfig, null, 2)}\n`);
