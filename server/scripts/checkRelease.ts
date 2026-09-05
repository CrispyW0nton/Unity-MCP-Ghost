#!/usr/bin/env node
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { certifiedUnityVersion } from "../src/testing/unityEditor.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = resolve(root, "Packages/com.crispywonton.unity-mcp-ghost");
const requiredFiles = [
  "dist/index.js",
  "dist/index.d.ts",
  "LICENSE",
  "SECURITY.md",
  "CHANGELOG.md",
  "README.md",
  "docs/generated/operation-catalog.json",
  "Packages/com.crispywonton.unity-mcp-ghost/LICENSE.md",
  "Packages/com.crispywonton.unity-mcp-ghost/CHANGELOG.md",
  "Packages/com.crispywonton.unity-mcp-ghost/README.md"
];
await Promise.all(requiredFiles.map((path) => access(resolve(root, path))));

const rootPackage = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { version: string; bin?: Record<string, string> };
const upmPackage = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
  version: string;
  unity: string;
  unityRelease?: string;
  dependencies?: Record<string, string>;
};
const configSource = await readFile(resolve(packageRoot, "Editor/Bridge/UnityMcpGhostConfig.cs"), "utf8");
const serverVersionSource = await readFile(resolve(root, "server/src/version.ts"), "utf8");
const projectVersion = await readFile(resolve(root, "test-project/ProjectSettings/ProjectVersion.txt"), "utf8");
const testManifest = JSON.parse(await readFile(resolve(root, "test-project/Packages/manifest.json"), "utf8")) as { dependencies?: Record<string, string> };
const catalog = JSON.parse(await readFile(resolve(root, "docs/generated/operation-catalog.json"), "utf8")) as {
  catalogVersion: number;
  operations: Array<{ inputSchema?: unknown; outputSchema?: unknown; examples?: unknown[] }>;
};

assertEqual(rootPackage.bin?.["unity-mcp-ghost"], "dist/index.js", "npm binary path");
assertEqual(upmPackage.version, rootPackage.version, "UPM/npm versions");
assertEqual(readQuotedConstant(configSource, "Version"), rootPackage.version, "Unity bridge/npm versions");
assertEqual(readQuotedConstant(serverVersionSource, "PackageVersion"), rootPackage.version, "TypeScript/npm versions");
const certifiedVersion = /^(\d+\.\d+)\.(\d+[abfp]\d+)$/.exec(certifiedUnityVersion);
if (!certifiedVersion) throw new Error(`Certified Unity version is malformed: ${certifiedUnityVersion}.`);
assertEqual(upmPackage.unity, certifiedVersion[1], "advertised Unity line");
assertEqual(upmPackage.unityRelease, certifiedVersion[2], "advertised Unity release");
if (!projectVersion.includes(certifiedUnityVersion)) throw new Error(`The repository test project must pin Unity ${certifiedUnityVersion}.`);
assertEqual(
  testManifest.dependencies?.["com.crispywonton.unity-mcp-ghost"],
  "file:../../Packages/com.crispywonton.unity-mcp-ghost",
  "package-installed fixture path"
);
assertEqual(upmPackage.dependencies?.["com.unity.nuget.newtonsoft-json"], "3.2.1", "Newtonsoft package pin");
if (catalog.catalogVersion !== 1 || catalog.operations.length < 90) throw new Error("Generated operation catalog is incomplete.");
for (const [index, operation] of catalog.operations.entries()) {
  if (!operation.inputSchema || !operation.outputSchema || !operation.examples?.length) {
    throw new Error(`Generated operation ${index} is missing schemas or examples.`);
  }
}

const packageFiles = await readdir(packageRoot, { recursive: true });
const forbidden = packageFiles.filter((path) => /(^|[\\/])(Library|Logs|Temp|UserSettings)([\\/]|$)/i.test(path));
if (forbidden.length > 0) throw new Error(`UPM package contains generated Unity state: ${forbidden.join(", ")}`);

process.stdout.write(
  `Release layout is valid for ${rootPackage.version}: Unity ${certifiedUnityVersion} fixture, ${catalog.operations.length} catalog operations, pinned Newtonsoft 3.2.1.\n`
);

function readQuotedConstant(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`));
  if (!match) throw new Error(`Could not read ${name} from version source.`);
  return match[1];
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${String(expected)}, found ${String(actual)}.`);
}
