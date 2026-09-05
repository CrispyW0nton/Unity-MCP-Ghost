import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { projectIdForPath, readConfig } from "../src/config.js";

describe("secure Unity project configuration", () => {
  it("loads a generated identity and pins its project, editor, token, and port", async () => {
    const project = await createProjectIdentity();
    try {
      const config = readConfig(["--unity-project-path", project.path]);

      assert.equal(config.unityProjectId, project.projectId);
      assert.equal(config.unityEditorInstanceId, "editor-fixture");
      assert.equal(config.unityTokenFile, project.tokenFile);
      assert.equal(config.unityPort, 7123);
      assert.equal(config.unityWebSocketPort, 17123);
      assert.equal(config.unityQueueDir, join(project.path, "Library/UnityMcpGhost/queue"));
      assert.deepEqual(config.toolProfiles, ["core"]);
    } finally {
      await rm(project.path, { recursive: true, force: true });
    }
  });

  it("refuses identity files belonging to another project", async () => {
    const project = await createProjectIdentity("unity-project-000000000000000000000000");
    try {
      assert.throws(() => readConfig(["--unity-project-path", project.path]), /project mismatch/i);
    } finally {
      await rm(project.path, { recursive: true, force: true });
    }
  });

  it("rejects non-loopback bridge hosts", () => {
    assert.throws(() => readConfig(["--unity-host", "192.0.2.10"]), /Remote Unity bridge hosts are disabled/);
  });

  it("parses explicit opt-in operation profiles and rejects unknown profiles", async () => {
    const project = await createProjectIdentity();
    try {
      assert.deepEqual(readConfig(["--unity-project-path", project.path, "--tool-profile", "runtime,validation"]).toolProfiles, ["runtime", "validation"]);
      assert.deepEqual(readConfig(["--unity-project-path", project.path, "--tool-profile", "all,core"]).toolProfiles, ["all"]);
      assert.throws(() => readConfig(["--unity-project-path", project.path, "--tool-profile", "unsafe"]), /unsupported values/i);
    } finally {
      await rm(project.path, { recursive: true, force: true });
    }
  });
});

async function createProjectIdentity(projectIdOverride?: string): Promise<{ path: string; projectId: string; tokenFile: string }> {
  const path = await mkdtemp(join(tmpdir(), "unity-mcp-config-"));
  const stateRoot = join(path, "Library", "UnityMcpGhost");
  await mkdir(stateRoot, { recursive: true });
  const tokenFile = join(stateRoot, "bridge-token.txt");
  await writeFile(tokenFile, "b".repeat(64), "utf8");
  const projectId = projectIdForPath(path);
  await writeFile(
    join(stateRoot, "bridge-identity.json"),
    JSON.stringify({ projectId: projectIdOverride ?? projectId, editorInstanceId: "editor-fixture", port: 7123, webSocketPort: 17123, tokenFile }),
    "utf8"
  );
  return { path, projectId, tokenFile };
}
