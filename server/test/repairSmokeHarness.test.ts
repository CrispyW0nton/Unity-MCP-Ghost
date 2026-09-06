import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callTool, record, runMutationRollbackSmoke, type SmokeStep } from "../src/phase3RepairSmoke.js";
import { createMcpServer } from "../src/mcp/createServer.js";
import type { UnityClient } from "../src/unity/UnityClient.js";
import { assertSmokeValidation, restoreSmokeEditor, smokeErrorEvidence } from "../src/testing/repairSmokeHarness.js";

it("characterizes the real MCP success envelope without starting the CLI on import", async () => {
  const server = new McpServer({ name: "smoke-characterization", version: "1" });
  server.registerTool("probe", {}, async () => ({
    content: [],
    structuredContent: { ok: true, data: { value: 7 } }
  }));
  const client = new Client({ name: "smoke-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(ct), server.connect(st)]);
    const result = await callTool(client, "probe", {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { value: 7 });
  } finally {
    await client.close();
    await server.close();
  }
});

type Options = {
  collision?: "folder" | "script" | "meta";
  destructive?: false | "missing";
  fault?:
    | "green"
    | "wrong-create"
    | "baseline"
    | "stale-baseline"
    | "stale-cleanup"
    | "readback"
    | "meta-write"
    | "sibling"
    | "late-write"
    | "delete-soft"
    | "delete-unknown"
    | "cleanup-soft"
    | "cleanup-unknown"
    | "unrelated"
    | "unknown-apply"
    | "unknown-tests"
    | "unknown-restore";
  createLost?: boolean;
  wrongRollbackHash?: boolean;
  revokedAfterStartup?: boolean;
  identityMismatch?: "project" | "editor";
  healthMismatch?: "project" | "editor" | "unauthenticated";
  badDiagnostic?: "generation" | "file" | "code";
};
type Obj = Record<string, unknown>;
type BridgeParams = {
  path: string;
  content: string;
  overwrite: boolean;
  dryRun: boolean;
  expectedSha256: string;
  backupPath: string;
  backupMetaPath: string;
  requestedCompileGeneration: number;
  generation: number;
  edits: { startLine: number; endLine: number; startColumn: number; endColumn: number; text: string }[];
};
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const fixtureProjectId = "repair-smoke-project";
const fixtureEditorId = "repair-smoke-editor";

// Real public MCP handlers run against a disk-backed bridge fixture. Compiler
// records are controlled here; this is not evidence of live Unity compilation.
async function fixture(
  options: Options,
  verify: (f: {
    steps: SmokeStep[];
    calls: { name: string; arguments: Obj }[];
    root: string;
    scriptPath: string;
    folderPath: string;
    run: () => Promise<void>;
    client: Client;
  }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ghost-repair-smoke-"));
  await mkdir(join(root, "Assets"));
  await mkdir(join(root, "Library/UnityMcpGhost"), { recursive: true });
  await writeFile(
    join(root, "Library/UnityMcpGhost/bridge-identity.json"),
    JSON.stringify({
      running: true,
      projectRoot: root,
      projectId: fixtureProjectId,
      editorInstanceId: fixtureEditorId,
      capabilities: options.destructive === "missing" ? {} : { destructive: options.destructive !== false }
    })
  );
  const calls: { name: string; arguments: Obj }[] = [];
  let scriptPath = "";
  let folderPath = "";
  let generation = 0;
  let broken = false;
  let backupCount = 0;
  const bytes = (): Promise<Buffer> => readFile(join(root, scriptPath));
  let activeDestructive = options.destructive !== false;
  const unity = {
    async isConnected(): Promise<boolean> {
      return true;
    },
    async request(method: string, p: BridgeParams): Promise<Obj> {
      if (method === "health")
        return {
          ok: true,
          authenticated: options.healthMismatch !== "unauthenticated",
          projectPath: root,
          projectId: options.healthMismatch === "project" ? "another-project" : fixtureProjectId,
          editorInstanceId: options.healthMismatch === "editor" ? "another-editor" : fixtureEditorId,
          capabilities: options.destructive === "missing" ? {} : { destructive: activeDestructive }
        };
      if (method === "script.create") {
        scriptPath = p.path;
        folderPath = p.path.slice(0, p.path.lastIndexOf("/"));
        await writeFile(join(root, scriptPath), p.content, { flag: p.overwrite ? "w" : "wx" });
        await writeFile(join(root, `${scriptPath}.meta`), "guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n");
        generation++;
        if (options.createLost) throw new Error("fetch failed");
        return {
          ok: true,
          path: p.path,
          created: options.fault !== "wrong-create",
          dryRun: false,
          beforeSha256: hash(Buffer.alloc(0)),
          afterSha256: hash(await bytes()),
          requestedCompileGeneration: generation
        };
      }
      if (method === "script.read") {
        const source = await bytes();
        return { ok: true, path: p.path, content: source.toString(), sha256: hash(source) };
      }
      if (method === "script.validate") return { ok: true, path: p.path, requestedCompileGeneration: p.requestedCompileGeneration ?? ++generation };
      if (method === "compile.status_get") {
        const failed = broken || (options.fault === "baseline" && backupCount === 0);
        const stale =
          (options.fault === "stale-baseline" && backupCount === 0) || (options.fault === "stale-cleanup" && calls.some((c) => c.name === "script_delete"));
        return {
          ok: !failed,
          status: failed ? "failed" : "success",
          generation: p.requestedCompileGeneration,
          observed: !stale,
          completedAtUtc: stale ? null : "2026-09-06T12:00:01Z",
          observedAtUtc: stale ? null : "2026-09-06T12:00:00Z",
          diagnostics: failed
            ? [{ generation: p.requestedCompileGeneration, severity: "error", code: "CS1525", file: scriptPath, message: "Invalid expression term ';'" }]
            : [],
          errorCount: failed ? 1 : 0,
          error: failed ? { code: "COMPILE_GENERATION_FAILED", message: "Compiler errors" } : null
        };
      }
      if (method === "compile.diagnostics_get") return { ok: true, generation: p.generation, diagnostics: [] };
      if (method === "script.apply_edits") {
        if (p.dryRun) return { ok: true, dryRun: true };
        const before = await bytes();
        assert.equal(p.expectedSha256, hash(before));
        const backupPath = join(root, `backup-${++backupCount}.cs`);
        const backupMetaPath = `${backupPath}.meta`;
        await copyFile(join(root, scriptPath), backupPath);
        await copyFile(join(root, `${scriptPath}.meta`), backupMetaPath);
        const lines = before.toString().split("\n");
        for (const edit of p.edits)
          lines[edit.startLine] = lines[edit.startLine].slice(0, edit.startColumn) + edit.text + lines[edit.endLine].slice(edit.endColumn);
        await writeFile(join(root, scriptPath), lines.join("\n"));
        broken = true;
        return {
          ok: true,
          path: scriptPath,
          beforeSha256: hash(before),
          afterSha256: hash(await bytes()),
          backupPath,
          backupMetaPath,
          requestedCompileGeneration: ++generation
        };
      }
      if (method === "script.restore") {
        assert.equal(p.expectedSha256, hash(await bytes()));
        await copyFile(p.backupPath, join(root, scriptPath));
        await copyFile(p.backupMetaPath, join(root, `${scriptPath}.meta`));
        broken = false;
        return { ok: true, path: scriptPath, restored: true, afterSha256: hash(await bytes()), requestedCompileGeneration: ++generation };
      }
      if (method === "script.transaction_complete") {
        if (options.fault === "cleanup-soft") return { ok: false, error: { code: "SCRIPT_BACKUP_DELETE_FAILED", message: "retained" } };
        if (options.fault === "cleanup-unknown") throw new Error("fetch failed");
        await rm(p.backupPath);
        await rm(p.backupMetaPath);
        return { ok: true, discarded: true };
      }
      if (method === "script.delete") {
        if (!activeDestructive) return { ok: false, error: { code: "DESTRUCTIVE_DISABLED", message: "revoked after startup" } };
        if (options.fault === "delete-soft") return { ok: false, error: { code: "DESTRUCTIVE_DISABLED", message: "denied" } };
        if (options.fault === "delete-unknown") throw new Error("fetch failed");
        if (options.fault === "late-write") await writeFile(join(root, scriptPath), "external late edit");
        const before = await bytes();
        if (p.expectedSha256 && p.expectedSha256 !== hash(before)) return { ok: false, error: { code: "SCRIPT_HASH_MISMATCH", message: "changed" } };
        await rm(join(root, scriptPath));
        await rm(join(root, `${scriptPath}.meta`));
        return { ok: true, path: scriptPath, deleted: true, beforeSha256: hash(before), afterSha256: "", requestedCompileGeneration: ++generation };
      }
      throw new Error(`Unexpected bridge method ${method}`);
    }
  } as unknown as UnityClient;
  const server = createMcpServer({ unity });
  const rawClient = new Client({ name: "repair-smoke-disk", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = {
    async callTool(request: { name: string; arguments: Obj }) {
      calls.push(request);
      const result = await rawClient.callTool(request);
      const envelope = result.structuredContent as Obj;
      if (request.name === "repair_apply_edits") {
        if (options.fault === "green") {
          result.isError = false;
          envelope.ok = true;
        }
        if (options.fault === "unrelated") envelope.error = { code: "AUTHENTICATION_FAILED", message: "unrelated" };
        if (options.wrongRollbackHash) ((envelope.data as Obj).rollback as Obj).restoredSha256 = "0".repeat(64);
        if (options.badDiagnostic) {
          const compile = ((envelope.data as Obj).steps as Obj[]).find((step) => step.name === "compile_wait")!.data as Obj;
          const diagnostic = (compile.diagnostics as Obj[])[0];
          diagnostic[options.badDiagnostic] = options.badDiagnostic === "generation" ? 999 : options.badDiagnostic === "file" ? "Assets/Other.cs" : "CS1002";
        }
        if (options.fault === "unknown-apply" || options.fault === "unknown-tests" || options.fault === "unknown-restore") {
          const key = { "unknown-apply": "unconfirmedApply", "unknown-tests": "unconfirmedTests", "unknown-restore": "unconfirmedRestore" }[options.fault]!;
          (envelope.data as Obj)[key] = { requestId: "unknown-request", operationId: "unknown-operation", outcomeUnknown: true };
        }
        if (options.fault === "readback") await writeFile(join(root, scriptPath), "external source edit");
        if (options.fault === "meta-write") await writeFile(join(root, `${scriptPath}.meta`), "external meta edit");
        if (options.fault === "sibling") await writeFile(join(root, folderPath, "external.txt"), "external sibling");
      }
      return result;
    }
  } as Client;
  const steps: SmokeStep[] = [];
  const runId = "fixture";
  if (options.collision) {
    const target = join(root, "Assets/GhostRepairScratch_fixture.cs");
    if (options.collision === "folder") await mkdir(target);
    if (options.collision === "script") await writeFile(target, "existing source");
    await writeFile(`${target}.meta`, "existing source meta");
  }
  try {
    await Promise.all([rawClient.connect(ct), server.connect(st)]);
    if (options.revokedAfterStartup) activeDestructive = false;
    const run = async () => {
      await runMutationRollbackSmoke(client, steps, 100, {
        projectPath: root,
        projectId: options.identityMismatch === "project" ? "different-project" : fixtureProjectId,
        editorInstanceId: options.identityMismatch === "editor" ? "different-editor" : fixtureEditorId,
        ...(options.collision ? { runId } : {})
      });
    };
    await run();
    await verify({ steps, calls, root, scriptPath, folderPath, run, client });
  } finally {
    await rawClient.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe("repair smoke safety through the public MCP server", () => {
  it("accepts expected compiler red only with verified rollback and independent disk/source evidence", async () => {
    await fixture({}, async (f) => {
      assert.ok(f.steps.length > 0);
      assert.ok(
        f.steps.every((step) => step.ok),
        JSON.stringify(f.steps)
      );
      assert.equal(f.calls.filter((c) => c.name === "repair_apply_edits").length, 1);
      assert.equal(f.calls.find((c) => c.name === "script_create")?.arguments.overwrite, false);
      assert.ok(f.calls.filter((c) => c.name === "script_read").length >= 2);
      assert.ok(f.calls.find((c) => c.name === "script_delete")?.arguments.expectedSha256);
      assert.ok(!f.calls.some((c) => c.name === "asset_delete"));
    });
  });
  for (const collision of ["folder", "script", "meta"] as const)
    it(`preserves preexisting ${collision} bytes`, async () => {
      await fixture({ collision }, async (f) => {
        assert.equal(f.calls.length, 0);
        assert.ok(f.steps.some((s) => !s.ok));
        assert.equal(await readFile(join(f.root, "Assets/GhostRepairScratch_fixture.cs.meta"), "utf8"), "existing source meta");
        if (collision === "script") assert.equal(await readFile(join(f.root, "Assets/GhostRepairScratch_fixture.cs"), "utf8"), "existing source");
      });
    });
  for (const destructive of [false, "missing"] as const)
    it(`refuses scratch mutation when destructive capability is ${destructive}`, async () => {
      await fixture({ destructive }, async (f) => {
        assert.deepEqual(
          f.calls.map((c) => c.name),
          ["health"]
        );
        assert.ok(f.steps.some((s) => !s.ok && JSON.stringify(s).includes("DESTRUCTIVE")));
      });
    });
  for (const fault of ["wrong-create", "baseline", "stale-baseline"] as const)
    it(`stops before repair after ${fault}`, async () => {
      await fixture({ fault }, async (f) => {
        assert.ok(f.steps.some((s) => !s.ok));
        assert.ok(!f.calls.some((c) => c.name === "repair_apply_edits"));
        if (fault === "baseline") assert.equal(f.calls.filter((c) => c.name === "script_delete").length, 1, "verified early failure still cleans owned bytes");
        if (fault.startsWith("wrong-")) assert.ok(!f.calls.some((c) => c.name === "script_delete" || c.name === "asset_delete"));
      });
    });
  for (const fault of [
    "green",
    "unrelated",
    "readback",
    "meta-write",
    "unknown-apply",
    "unknown-tests",
    "unknown-restore",
    "cleanup-soft",
    "cleanup-unknown"
  ] as const)
    it(`rejects ${fault} and preserves recovery`, async () => {
      await fixture({ fault }, async (f) => {
        assert.ok(
          f.steps.some((s) => !s.ok),
          JSON.stringify(f.steps)
        );
        assert.ok(!f.calls.some((c) => c.name === "script_delete" || c.name === "asset_delete"));
        assert.ok(f.steps.some((s) => JSON.stringify(s).includes("recovery")));
        if (fault === "readback") assert.equal(await readFile(join(f.root, f.scriptPath), "utf8"), "external source edit");
        if (fault === "meta-write") assert.equal(await readFile(join(f.root, `${f.scriptPath}.meta`), "utf8"), "external meta edit");
      });
    });
  it("keeps an unexpected sibling and never recursively deletes its folder", async () => {
    await fixture({ fault: "sibling" }, async (f) => {
      assert.equal(await readFile(join(f.root, f.folderPath, "external.txt"), "utf8"), "external sibling");
      assert.ok(!f.calls.some((c) => c.name === "asset_delete"));
    });
  });
  for (const fault of ["delete-soft", "delete-unknown", "stale-cleanup", "late-write"] as const)
    it(`reports ${fault} without destructive followup`, async () => {
      await fixture({ fault }, async (f) => {
        assert.ok(f.steps.some((s) => !s.ok));
        assert.equal(f.calls.filter((c) => c.name === "script_delete").length, 1);
        assert.ok(!f.calls.some((c) => c.name === "asset_delete"));
        assert.ok(f.steps.some((s) => JSON.stringify(s).includes("recovery")));
        if (fault === "late-write") assert.equal(await readFile(join(f.root, f.scriptPath), "utf8"), "external late edit");
      });
    });
  it("uses a fresh owned path and fresh mutation IDs on each run", async () => {
    await fixture({}, async (f) => {
      await f.run();
      const creates = f.calls.filter((c) => c.name === "script_create");
      assert.equal(new Set(creates.map((c) => c.arguments.path)).size, 2);
      assert.equal(new Set(creates.map((c) => c.arguments.requestId)).size, 2);
      assert.ok(creates.every((c) => typeof c.arguments.requestId === "string"));
    });
  });
  it("retains an unknown create without reading, replaying, or deleting it", async () => {
    await fixture({ createLost: true }, async (f) => {
      assert.deepEqual(
        f.calls.map((c) => c.name),
        ["health", "script_create"]
      );
      assert.ok(f.steps.some((s) => s.name === "retain scratch recovery" && !s.ok));
      assert.ok((await readFile(join(f.root, f.scriptPath))).length > 0);
    });
  });
  it("rejects a wrong rollback receipt even when original source bytes are present", async () => {
    await fixture({ wrongRollbackHash: true }, async (f) => {
      assert.ok(f.steps.some((s) => !s.ok));
      assert.ok(!f.calls.some((c) => c.name === "script_delete"));
    });
  });
  it("does not restore scenes or Play while mutation recovery remains unresolved", async () => {
    await fixture({ fault: "unknown-tests" }, async (f) => {
      let restored = false;
      const original = { sceneSetup: [{ path: "Assets/Original.unity" }] };
      await assert.rejects(
        restoreSmokeEditor(
          f.steps,
          async () => {
            restored = true;
            return { restored: true };
          },
          original
        ),
        (error) => {
          assert.deepEqual((error as Obj).originalSnapshot, original);
          return true;
        }
      );
      assert.equal(restored, false);
    });
  });
  it("checks the active capability after revocation instead of trusting startup identity", async () => {
    await fixture({ revokedAfterStartup: true }, async (f) => {
      assert.deepEqual(
        f.calls.map((c) => c.name),
        ["health"]
      );
      assert.ok(f.steps.some((s) => !s.ok && JSON.stringify(s).includes("DESTRUCTIVE")));
      assert.equal(f.scriptPath, "");
    });
  });
  for (const identityMismatch of ["project", "editor"] as const)
    it(`refuses mismatched local ${identityMismatch} identity before mutations`, async () => {
      await fixture({ identityMismatch }, async (f) => {
        assert.equal(f.calls.length, 0);
        assert.ok(f.steps.some((s) => !s.ok && JSON.stringify(s).includes("IDENTITY_MISMATCH")));
      });
    });
  for (const healthMismatch of ["project", "editor", "unauthenticated"] as const)
    it(`refuses ${healthMismatch} health evidence before mutations`, async () => {
      await fixture({ healthMismatch }, async (f) => {
        assert.deepEqual(
          f.calls.map((c) => c.name),
          ["health"]
        );
        assert.ok(f.steps.some((s) => !s.ok));
      });
    });
  for (const badDiagnostic of ["generation", "file", "code"] as const)
    it(`cannot accept a malformed compiler diagnostic ${badDiagnostic}`, async () => {
      await fixture({ badDiagnostic }, async (f) => {
        assert.ok(f.steps.some((s) => !s.ok));
        assert.ok(!f.calls.some((c) => c.name === "script_delete"));
      });
    });
});

it("never retries a lost mutation message, and preserves typed IDs and unknown outcome", async () => {
  await Promise.all(
    ["scene_open", "script_create", "repair_apply_edits", "script_delete", "asset_delete", "screenshot_capture"].map(async (name) => {
      let calls = 0;
      const failure = Object.assign(new Error("fetch failed"), {
        code: "UNITY_REQUEST_TIMEOUT_OUTCOME_UNKNOWN",
        requestId: "lost-request",
        operationId: "lost-operation",
        outcomeUnknown: true
      });
      const client = {
        async callTool() {
          calls++;
          throw failure;
        }
      } as unknown as Client;
      await assert.rejects(callTool(client, name, {}), (error) => {
        assert.equal((error as Obj).requestId, "lost-request");
        assert.equal((error as Obj).operationId, "lost-operation");
        assert.equal((error as Obj).outcomeUnknown, true);
        return true;
      });
      assert.equal(calls, 1, `${name} cannot replay`);
    })
  );
});

it("a recorded validation failure stops the CLI sequence before subsequent repairs", async () => {
  const steps: SmokeStep[] = [];
  let continued = false;
  await assert.rejects(async () => {
    await record(steps, "target script validation", async () => ({ ok: false, error: { code: "SCRIPT_COMPILER_ERRORS" } }));
    continued = true;
  });
  assert.equal(continued, false);
  assert.equal(steps[0].ok, false);
});

it("preserves existing editor restoration after a settled preflight failure", async () => {
  await fixture({ destructive: false }, async (f) => {
    let restored = false;
    const receipt = await restoreSmokeEditor(f.steps, async () => {
      restored = true;
      return { restored: true };
    });
    assert.equal(restored, true);
    assert.equal(receipt?.restored, true);
  });
});

for (const outcome of [
  "lost-scene",
  "compile-timeout",
  "unobserved-generation",
  "unknown-generation",
  "failed-unobserved",
  "settled-compiler-failure"
] as const) {
  it(`composes the main error path and editor restoration safely for ${outcome}`, async () => {
    const unity = {
      async request(method: string): Promise<Obj> {
        if (method === "scene.open")
          throw Object.assign(new Error("fetch failed"), {
            code: "UNITY_REQUEST_TIMEOUT_OUTCOME_UNKNOWN",
            requestId: "scene-request",
            data: { outcomeUnknown: true, operationId: "scene-operation" }
          });
        if (method === "script.validate") return { ok: true, requestedCompileGeneration: 7 };
        if (method === "compile.status_get" && (outcome === "unknown-generation" || outcome === "failed-unobserved"))
          return {
            ok: false,
            status: "failed",
            generation: 7,
            observed: false,
            error: { code: outcome === "unknown-generation" ? "UNKNOWN_COMPILE_GENERATION" : "COMPILE_GENERATION_FAILED" }
          };
        if (method === "compile.status_get")
          return {
            ok: outcome !== "settled-compiler-failure",
            status: outcome === "compile-timeout" ? "waiting" : outcome === "settled-compiler-failure" ? "failed" : "success",
            generation: 7,
            observed: outcome === "settled-compiler-failure",
            observedAtUtc: outcome === "settled-compiler-failure" ? "2026-09-06T12:00:00Z" : null,
            completedAtUtc: outcome === "settled-compiler-failure" ? "2026-09-06T12:00:01Z" : null
          };
        if (method === "compile.diagnostics_get") return { ok: true, generation: 7, diagnostics: [] };
        throw new Error(`Unexpected request ${method}`);
      }
    } as unknown as UnityClient;
    const server = createMcpServer({ unity });
    const client = new Client({ name: "repair-smoke-composition", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const steps: SmokeStep[] = [];
    const original = { sceneSetup: [{ path: "Assets/Original.unity" }], selectionGlobalObjectIds: ["original-object"] };
    let restoreCalls = 0;
    try {
      await Promise.all([client.connect(ct), server.connect(st)]);
      try {
        if (outcome === "lost-scene")
          await callTool(client, "scene_open", { path: "Assets/Fixture.unity", mode: "single", dryRun: false, requestId: "scene-request" });
        else
          await record(
            steps,
            "target script validation",
            () => callTool(client, "script_validate", { path: "Assets/Fixture.cs", timeoutMs: 1 }),
            (result) => {
              assertSmokeValidation(result);
              return { ok: true, checks: { compileVerified: true } };
            }
          );
        assert.fail("The failed smoke prerequisite cannot continue.");
      } catch (error) {
        // Same structured receipt preservation as main's catch.
        steps.push({ name: "phase3 repair smoke", ok: false, summary: smokeErrorEvidence(error) });
      }
      const restore = () =>
        restoreSmokeEditor(
          steps,
          async () => {
            restoreCalls++;
            return { restored: true };
          },
          original
        );
      if (outcome === "settled-compiler-failure") {
        assert.equal((await restore())?.restored, true);
        assert.equal(restoreCalls, 1);
      } else {
        await assert.rejects(restore(), (error) => {
          assert.deepEqual((error as Obj).originalSnapshot, original);
          assert.ok((error as Obj).recovery);
          return true;
        });
        assert.equal(restoreCalls, 0);
      }
      if (outcome === "lost-scene") assert.ok(JSON.stringify(steps).includes("scene-request"));
      else assert.ok(JSON.stringify(steps).includes("requestedCompileGeneration"));
    } finally {
      await client.close();
      await server.close();
    }
  });
}
