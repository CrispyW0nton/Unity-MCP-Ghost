import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/createServer.js";
import { UnityRequestTimeoutError, type UnityClient, type UnityRequestOptions } from "../src/unity/UnityClient.js";

type RepairBackup = { backupPath: string; backupMetaPath: string };
type RepairFixtureOptions = {
  repair?: "failed" | "green" | "initially-green" | "validation-throw";
  applyTimeoutAt?: number;
  omitApplyErrorRequestId?: boolean;
  restore?: "success" | "soft-failure" | "throw" | "timeout" | "hash-mismatch" | "missing-generation" | "readback-throw";
  cleanup?: "success" | "soft-failure" | "throw" | "throw-after-delete";
  cleanupFailAt?: number;
  maxIterations?: number;
  emptyOriginal?: boolean;
  requiredTestStatus?: "failed" | "cancelled" | "timeout" | "aborted";
  initialReadFault?: "soft-failure" | "missing-content";
  finalReadFault?: "soft-failure" | "missing-hash";
};

// Exercise the real MCP route with disk-backed mutations. Only the Unity bridge
// boundary is controlled here; compilation results are not live Unity evidence.
async function withRepairFiles(
  options: RepairFixtureOptions,
  verify: (fixture: {
    result: Awaited<ReturnType<Client["callTool"]>>;
    sourcePath: string;
    originalBytes: Buffer;
    backups: RepairBackup[];
    requests: Array<{ method: string; params: Record<string, unknown>; options: UnityRequestOptions }>;
    appliedBytes: Buffer[];
    restoreRequests: Record<string, unknown>[];
    cleanupRequests: Record<string, unknown>[];
  }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "ghost-repair-retention-"));
  const sourcePath = path.join(directory, "Broken.cs");
  const originalBytes = Buffer.from(options.emptyOriginal ? "" : "\uFEFFpublic class Broken { void Run() { int score = 1 } }\r\n", "utf8");
  const backups: RepairBackup[] = [];
  const requests: Array<{ method: string; params: Record<string, unknown>; options: UnityRequestOptions }> = [];
  const appliedBytes: Buffer[] = [];
  const restoreRequests: Record<string, unknown>[] = [];
  const cleanupRequests: Record<string, unknown>[] = [];
  let activeGeneration = 1;
  let restoring = false;
  let initialReadObserved = false;
  let finalReadFaultObserved = false;
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const retainCurrent = async () => {
    const backup = {
      backupPath: path.join(directory, `backup-${backups.length + 1}.cs`),
      backupMetaPath: path.join(directory, `backup-${backups.length + 1}.cs.meta`)
    };
    await copyFile(sourcePath, backup.backupPath);
    await copyFile(`${sourcePath}.meta`, backup.backupMetaPath);
    backups.push(backup);
    return backup;
  };
  const unity = {
    request: async (method: string, params: Record<string, unknown>, requestOptions: UnityRequestOptions = {}) => {
      requests.push({ method, params, options: requestOptions });
      if (method === "script.read") {
        const isInitialRead = !initialReadObserved;
        if (isInitialRead) {
          initialReadObserved = true;
          if (options.initialReadFault === "soft-failure") {
            return { ok: false, error: { code: "SCRIPT_READ_FAILED", message: "Initial source read failed." } };
          }
          if (options.initialReadFault === "missing-content") {
            return { ok: true, sha256: hash(await readFile(sourcePath)) };
          }
        }
        if (
          !isInitialRead &&
          (activeGeneration > 1 || options.repair === "initially-green") &&
          !restoring &&
          !finalReadFaultObserved &&
          options.finalReadFault
        ) {
          finalReadFaultObserved = true;
          return options.finalReadFault === "soft-failure"
            ? { ok: false, error: { code: "SCRIPT_READ_FAILED", message: "Final source read failed." } }
            : { ok: true, content: (await readFile(sourcePath)).toString("utf8") };
        }
        if (restoring && options.restore === "readback-throw") {
          throw new Error("Read-back unavailable after restoration.");
        }
        const bytes = await readFile(sourcePath);
        return { ok: true, content: bytes.toString("utf8"), sha256: hash(bytes) };
      }
      if (method === "script.validate") {
        if (activeGeneration > 1 && !restoring && options.repair === "validation-throw") {
          throw new Error("Validation transport failed after applying the edit.");
        }
        return { ok: true, requestedCompileGeneration: params.requestedCompileGeneration ?? activeGeneration };
      }
      if (method === "compile.status_get") {
        const generation = Number(params.requestedCompileGeneration);
        const status =
          restoring && options.restore === "timeout"
            ? "waiting"
            : restoring || options.repair === "initially-green" || (generation > 1 && options.repair === "green")
              ? "success"
              : "failed";
        return { ok: status !== "failed", status, generation, observed: status !== "waiting" };
      }
      if (method === "compile.diagnostics_get") {
        return {
          ok: true,
          diagnostics:
            options.repair === "initially-green" || (Number(params.generation) > 1 && options.repair === "green")
              ? []
              : [
                  {
                    generation: params.generation,
                    severity: "error",
                    code: "CS1002",
                    message: "error CS1002: ; expected",
                    line: 1,
                    column: 48
                  }
                ]
        };
      }
      if (method === "tests.run") {
        return { ok: false, state: { status: options.requiredTestStatus, failed: options.requiredTestStatus === "failed" ? 1 : 0 } };
      }
      if (method === "script.apply_edits") {
        const before = await readFile(sourcePath);
        assert.equal(params.expectedSha256, hash(before));
        if (params.dryRun === true) {
          return { ok: true, dryRun: true };
        }
        const backup = await retainCurrent();
        const lines = before.toString("utf8").split("\r\n");
        for (const edit of params.edits as Array<{ startLine: number; startColumn: number; text: string }>) {
          const line = lines[edit.startLine]!;
          lines[edit.startLine] = line.slice(0, edit.startColumn) + edit.text + line.slice(edit.startColumn);
        }
        await writeFile(sourcePath, lines.join("\r\n"));
        appliedBytes.push(await readFile(sourcePath));
        activeGeneration++;
        if (appliedBytes.length === options.applyTimeoutAt) {
          const error = new UnityRequestTimeoutError(
            "Apply response was lost after changing source bytes.",
            requestOptions.requestId ?? "fixture-unidentified-apply",
            true
          );
          if (options.omitApplyErrorRequestId) {
            Reflect.deleteProperty(error, "requestId");
          }
          throw error;
        }
        return { ok: true, ...backup, requestedCompileGeneration: activeGeneration };
      }
      if (method === "script.restore") {
        restoreRequests.push(params);
        assert.equal(params.backupPath, backups[0]?.backupPath, "restore must use the first, original-source backup");
        assert.equal(params.expectedSha256, hash(await readFile(sourcePath)));
        if (options.restore === "soft-failure") {
          return { ok: false, error: { code: "SCRIPT_RESTORE_FAILED", message: "Restore was rejected." } };
        }
        if (options.restore === "throw") {
          throw new Error("Restore request timed out; outcome unknown.");
        }
        const backup = await retainCurrent();
        await copyFile(String(params.backupPath), sourcePath);
        if (options.restore === "hash-mismatch") {
          await writeFile(sourcePath, "unexpected source bytes\r\n");
        }
        restoring = true;
        activeGeneration++;
        return { ok: true, ...backup, requestedCompileGeneration: options.restore === "missing-generation" ? undefined : activeGeneration };
      }
      if (method === "script.transaction_complete") {
        cleanupRequests.push(params);
        if (cleanupRequests.length === (options.cleanupFailAt ?? 1) && options.cleanup === "soft-failure") {
          return { ok: false, error: { code: "SCRIPT_BACKUP_DELETE_FAILED", message: "Backup remains locked." } };
        }
        if (cleanupRequests.length === (options.cleanupFailAt ?? 1) && options.cleanup === "throw") {
          throw new Error("Cleanup transport failed; deletion was not confirmed.");
        }
        await rm(String(params.backupPath));
        await rm(String(params.backupMetaPath));
        if (cleanupRequests.length === (options.cleanupFailAt ?? 1) && options.cleanup === "throw-after-delete") {
          throw new Error("Cleanup response was lost after deleting its files.");
        }
        return { ok: true, discarded: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  } as unknown as UnityClient;
  const server = createMcpServer({ unity });
  const client = new Client({ name: "ghost-repair-retention-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await writeFile(sourcePath, originalBytes);
    await writeFile(`${sourcePath}.meta`, "guid: repair-original\r\n");
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = await client.callTool({
      name: "repair_loop_run",
      arguments: {
        objective: "verify repair backup retention",
        scriptPath: "Assets/Broken.cs",
        maxIterations: options.maxIterations ?? 1,
        compileTimeoutMs: 25,
        runTests: options.requiredTestStatus !== undefined
      }
    });
    await verify({ result, sourcePath, originalBytes, backups, requests, appliedBytes, restoreRequests, cleanupRequests });
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("repair_loop_run backup retention", () => {
  for (const applyTimeoutAt of [1, 2]) {
    for (const omitApplyErrorRequestId of [false, true]) {
      it(`retains an unknown apply outcome without replay after iteration ${applyTimeoutAt}, transport request ID omitted: ${omitApplyErrorRequestId}`, async () => {
        await withRepairFiles(
          { applyTimeoutAt, omitApplyErrorRequestId, maxIterations: 3 },
          async ({ result, sourcePath, originalBytes, backups, requests, appliedBytes, restoreRequests, cleanupRequests }) => {
            assert.equal(result.isError, true);
            const envelope = result.structuredContent as {
              requestId: string;
              warnings: string[];
              data: {
                currentSha256: string | null;
                restored: unknown;
                transactionCleanup: unknown[];
                retainedBackups: RepairBackup[];
                recoveryPathsUnverified: boolean;
                recoveryHint: string;
                unconfirmedApply: { requestId: string; iteration: number; outcomeUnknown: boolean };
                iterations: Array<{ applyRequestId: string }>;
              };
            };
            assert.equal(envelope.data.currentSha256, null, "a dispatched apply invalidates the hash even when its response is lost");
            assert.equal(restoreRequests.length, 0, "an earlier confirmed edit must not authorize restoration after an unknown apply");
            assert.equal(cleanupRequests.length, 0, "unknown apply outcomes must preserve all recovery files");
            const applies = requests.filter((request) => request.method === "script.apply_edits" && request.params.dryRun === false);
            assert.equal(applies.length, applyTimeoutAt, "the unknown apply must not be replayed or followed by another iteration");
            assert.equal(requests.at(-1), applies.at(-1), "no read-back or other request can resolve a potentially late write implicitly");
            assert.ok(applies.every((request) => typeof request.options.requestId === "string" && request.options.requestId.length > 0));
            assert.equal(new Set(applies.map((request) => request.options.requestId)).size, applyTimeoutAt);
            const requestId = applies.at(-1)!.options.requestId!;
            assert.equal(envelope.requestId, requestId, "retain the pre-dispatch ID even when the transport error omits it");
            assert.deepEqual(envelope.data.unconfirmedApply, { requestId, iteration: applyTimeoutAt, outcomeUnknown: true });
            assert.equal(envelope.data.iterations.length, applyTimeoutAt);
            assert.equal(envelope.data.iterations.at(-1)?.applyRequestId, requestId);
            assert.equal(envelope.data.restored, null);
            assert.deepEqual(envelope.data.transactionCleanup, []);
            assert.deepEqual(envelope.data.retainedBackups, backups.slice(0, applyTimeoutAt - 1), "only received backup paths can be advertised");
            assert.equal(envelope.data.recoveryPathsUnverified, false, "no cleanup was attempted on known backup paths");
            assert.match(envelope.data.recoveryHint, /apply.*outcome.*unknown/i);
            assert.ok(envelope.data.recoveryHint.includes(requestId));
            assert.match(envelope.data.recoveryHint, /reconcile/i);
            assert.match(envelope.data.recoveryHint, /apply, restore, or cleanup/i);
            assert.match(envelope.warnings.join(" "), /unknown/i);
            assert.equal(backups.length, applyTimeoutAt);
            assert.equal(appliedBytes.length, applyTimeoutAt);
            assert.notDeepEqual(appliedBytes.at(-1), originalBytes);
            assert.deepEqual(await readFile(sourcePath), appliedBytes.at(-1), "changed source bytes must remain as the lost apply left them");
            assert.deepEqual(await readFile(backups[0]!.backupPath), originalBytes, "the original BOM and CRLF bytes must remain recoverable");
            for (let index = 0; index < backups.length; index++) {
              assert.deepEqual(await readFile(backups[index]!.backupPath), index === 0 ? originalBytes : appliedBytes[index - 1]);
              assert.equal(await readFile(backups[index]!.backupMetaPath, "utf8"), "guid: repair-original\r\n");
            }
          }
        );
      });
    }
  }

  for (const finalReadFault of [undefined, "soft-failure", "missing-hash"] as const) {
    it(`verifies an initially green source without mutations: ${finalReadFault ?? "success"}`, async () => {
      await withRepairFiles(
        { repair: "initially-green", finalReadFault },
        async ({ result, sourcePath, originalBytes, backups, requests, restoreRequests, cleanupRequests }) => {
          assert.equal(result.isError, finalReadFault ? true : undefined);
          assert.equal(backups.length, 0);
          assert.equal(restoreRequests.length, 0);
          assert.equal(cleanupRequests.length, 0);
          assert.equal(requests.filter((request) => request.method === "script.apply_edits").length, 0);
          assert.deepEqual(await readFile(sourcePath), originalBytes);
          const data = (
            result.structuredContent as {
              data: {
                currentSha256: string | null;
                restored: unknown;
                retainedBackups: RepairBackup[];
                recoveryPathsUnverified: boolean;
                recoveryHint: string | null;
              };
            }
          ).data;
          assert.equal(data.currentSha256, finalReadFault ? null : createHash("sha256").update(originalBytes).digest("hex"));
          assert.equal(data.restored, null);
          assert.deepEqual(data.retainedBackups, []);
          assert.equal(data.recoveryPathsUnverified, false);
          assert.equal(data.recoveryHint, null);
        }
      );
    });
  }

  it("marks backup paths unverified when cleanup delivery is lost after deletion", async () => {
    await withRepairFiles({ repair: "green", cleanup: "throw-after-delete" }, async ({ result, backups, restoreRequests, cleanupRequests }) => {
      assert.equal(result.isError, true);
      assert.equal(restoreRequests.length, 0);
      assert.equal(cleanupRequests.length, 1);
      await assert.rejects(stat(backups[0]!.backupPath), { code: "ENOENT" });
      const data = (
        result.structuredContent as {
          data: { recoveryPathsUnverified: boolean; transactionCleanup: Array<{ outcomeUnknown: boolean }>; recoveryHint: string };
        }
      ).data;
      assert.equal(data.recoveryPathsUnverified, true);
      assert.equal(data.transactionCleanup[0]?.outcomeUnknown, true);
      assert.match(data.recoveryHint, /existence.*unverified/i);
    });
  });

  for (const initialReadFault of ["soft-failure", "missing-content"] as const) {
    it(`does not mutate without a verified original source: ${initialReadFault}`, async () => {
      await withRepairFiles({ initialReadFault }, async ({ result, sourcePath, originalBytes, backups, restoreRequests, cleanupRequests }) => {
        assert.equal(result.isError, true);
        assert.equal(backups.length, 0, "initial read failure must stop before any write");
        assert.equal(restoreRequests.length, 0);
        assert.equal(cleanupRequests.length, 0);
        assert.deepEqual(await readFile(sourcePath), originalBytes);
      });
    });
  }

  for (const finalReadFault of ["soft-failure", "missing-hash"] as const) {
    it(`restores before releasing backups when final source verification fails: ${finalReadFault}`, async () => {
      await withRepairFiles({ repair: "green", finalReadFault }, async ({ result, sourcePath, originalBytes, backups, restoreRequests, cleanupRequests }) => {
        assert.equal(result.isError, true, "an unverified final source must not be called a green repair");
        assert.equal(restoreRequests.length, 1);
        assert.deepEqual(await readFile(sourcePath), originalBytes);
        assert.equal(cleanupRequests.length, backups.length);
        const envelope = result.structuredContent as { data: { restored: { ok: boolean }; retainedBackups: RepairBackup[] } };
        assert.equal(envelope.data.restored.ok, true);
        assert.deepEqual(envelope.data.retainedBackups, []);
      });
    });
  }

  for (const options of [
    { restore: "soft-failure" },
    { repair: "validation-throw", restore: "soft-failure" },
    { restore: "throw" },
    { repair: "validation-throw", restore: "throw" },
    { restore: "timeout" },
    { restore: "hash-mismatch" },
    { restore: "missing-generation" },
    { restore: "readback-throw" },
    { restore: "soft-failure", maxIterations: 3 }
  ] satisfies RepairFixtureOptions[]) {
    it(`retains recovery files without replaying restoration: ${JSON.stringify(options)}`, async () => {
      await withRepairFiles(options, async ({ result, sourcePath, originalBytes, backups, restoreRequests, cleanupRequests }) => {
        assert.equal(result.isError, true);
        assert.equal(restoreRequests.length, 1, "unverified restoration must never be replayed implicitly");
        assert.equal(cleanupRequests.length, 0, "unverified restoration must never discard backups");
        assert.deepEqual(await readFile(backups[0]!.backupPath), originalBytes, "original bytes including BOM and CRLF must survive");
        for (const backup of backups) {
          assert.ok((await stat(backup.backupPath)).isFile());
          assert.equal(await readFile(backup.backupMetaPath, "utf8"), "guid: repair-original\r\n");
        }
        const envelope = result.structuredContent as {
          ok: boolean;
          error: { code: string };
          data: {
            originalSha256: string;
            currentSha256: string | null;
            retainedBackups: RepairBackup[];
            restored: { ok: boolean };
            transactionCleanup: unknown[];
            recoveryPathsUnverified: boolean;
            recoveryHint: string;
          };
        };
        assert.equal(envelope.ok, false);
        assert.equal(envelope.error.code, "REPAIR_ROLLBACK_FAILED");
        assert.equal(envelope.data.restored.ok, false);
        assert.deepEqual(envelope.data.transactionCleanup, []);
        assert.deepEqual(envelope.data.retainedBackups, backups, "receipt must identify every retained source and metadata backup");
        assert.equal(envelope.data.originalSha256, createHash("sha256").update(originalBytes).digest("hex"));
        assert.equal(
          envelope.data.currentSha256,
          options.restore === "readback-throw"
            ? null
            : createHash("sha256")
                .update(await readFile(sourcePath))
                .digest("hex")
        );
        assert.match(envelope.data.recoveryHint, /backup|recover/i);
        assert.equal(envelope.data.recoveryPathsUnverified, false);
        assert.match(envelope.data.recoveryHint, /backups.*retained/i);
        assert.match(envelope.data.recoveryHint, /cleanup was not attempted/i);
        assert.doesNotMatch(envelope.data.recoveryHint, /existence.*unverified|failed cleanup/i);
        if (options.maxIterations === 3) {
          assert.equal(backups.length, 3);
          assert.notDeepEqual(await readFile(backups[1]!.backupPath), originalBytes);
        }
      });
    });
  }

  for (const repair of ["failed", "validation-throw", "green"] as const) {
    it(`cleans all intended backups after verified ${repair === "green" ? "repair" : `restoration (${repair})`}`, async () => {
      await withRepairFiles({ repair }, async ({ result, sourcePath, originalBytes, backups, restoreRequests, cleanupRequests }) => {
        assert.equal(result.isError, repair === "green" ? undefined : true);
        assert.equal(restoreRequests.length, repair === "green" ? 0 : 1);
        assert.equal(cleanupRequests.length, backups.length);
        for (const backup of backups) {
          await assert.rejects(stat(backup.backupPath), { code: "ENOENT" });
          await assert.rejects(stat(backup.backupMetaPath), { code: "ENOENT" });
        }
        const data = (result.structuredContent as { data: { retainedBackups: RepairBackup[]; recoveryPathsUnverified: boolean; recoveryHint: string | null } })
          .data;
        assert.deepEqual(data.retainedBackups, []);
        assert.equal(data.recoveryPathsUnverified, false);
        assert.equal(data.recoveryHint, null);
        if (repair !== "green") {
          assert.deepEqual(await readFile(sourcePath), originalBytes);
        }
      });
    });
  }

  it("restores an empty original source after a validation exception", async () => {
    await withRepairFiles(
      { repair: "validation-throw", emptyOriginal: true },
      async ({ result, sourcePath, originalBytes, backups, restoreRequests, cleanupRequests }) => {
        assert.equal(result.isError, true);
        assert.equal(restoreRequests.length, 1);
        assert.deepEqual(await readFile(sourcePath), originalBytes);
        assert.equal(cleanupRequests.length, backups.length);
      }
    );
  });

  for (const requiredTestStatus of ["failed", "cancelled", "timeout", "aborted"] as const) {
    it(`restores original bytes before cleanup when required tests are ${requiredTestStatus}`, async () => {
      await withRepairFiles(
        { repair: "green", requiredTestStatus },
        async ({ result, sourcePath, originalBytes, backups, restoreRequests, cleanupRequests }) => {
          assert.equal(result.isError, true);
          assert.equal(restoreRequests.length, 1);
          assert.deepEqual(await readFile(sourcePath), originalBytes);
          assert.equal(cleanupRequests.length, backups.length);
          const envelope = result.structuredContent as { error: { code: string }; data: { restored: { ok: boolean } } };
          assert.equal(envelope.error.code, "REPAIR_EXHAUSTED");
          assert.equal(envelope.data.restored.ok, true);
        }
      );
    });
  }

  for (const cleanup of ["soft-failure", "throw"] as const) {
    it(`keeps remaining backup receipts when cleanup partially completes then returns ${cleanup}`, async () => {
      await withRepairFiles({ cleanup, cleanupFailAt: 2 }, async ({ result, sourcePath, originalBytes, backups, restoreRequests, cleanupRequests }) => {
        assert.equal(result.isError, true);
        assert.equal(restoreRequests.length, 1, "partial cleanup must not restore from an already deleted original backup");
        assert.equal(cleanupRequests.length, 2, "partial cleanup must not replay any discard");
        await assert.rejects(stat(backups[0]!.backupPath), { code: "ENOENT" });
        assert.ok((await stat(backups[1]!.backupPath)).isFile());
        assert.deepEqual(await readFile(sourcePath), originalBytes);
        const data = (
          result.structuredContent as {
            data: { retainedBackups: RepairBackup[]; transactionCleanup: Array<{ ok: boolean }> };
          }
        ).data;
        assert.deepEqual(data.retainedBackups, backups.slice(1));
        assert.deepEqual(
          data.transactionCleanup.map((receipt) => receipt.ok),
          [true, false]
        );
      });
    });

    for (const repair of ["green", "failed", "validation-throw"] as const) {
      it(`reports ${cleanup} cleanup after ${repair} without replaying mutation or cleanup`, async () => {
        await withRepairFiles({ repair, cleanup }, async ({ result, sourcePath, originalBytes, backups, restoreRequests, cleanupRequests }) => {
          assert.equal(result.isError, true, "cleanup failure must not report top-level success");
          assert.equal(restoreRequests.length, repair === "green" ? 0 : 1, "cleanup failure must not trigger restoration");
          assert.equal(cleanupRequests.length, 1, "stop cleanup after the first failure without retrying it");
          for (const backup of backups) {
            assert.ok((await stat(backup.backupPath)).isFile());
          }
          const envelope = result.structuredContent as {
            error: { code: string };
            data: {
              repairVerified?: boolean;
              retainedBackups: RepairBackup[];
              transactionCleanup: Array<RepairBackup & { ok: boolean; error: { message: string } }>;
              recoveryPathsUnverified: boolean;
              recoveryHint: string;
            };
          };
          assert.equal(envelope.error.code, repair === "green" ? "REPAIR_CLEANUP_FAILED" : repair === "failed" ? "REPAIR_EXHAUSTED" : "REPAIR_LOOP_FAILED");
          assert.deepEqual(envelope.data.retainedBackups, backups);
          assert.equal(envelope.data.transactionCleanup[0]?.ok, false);
          assert.equal(envelope.data.transactionCleanup[0]?.backupPath, backups[0]?.backupPath);
          assert.match(envelope.data.transactionCleanup[0]!.error.message, /locked|transport/);
          assert.equal(envelope.data.recoveryPathsUnverified, true);
          assert.match(envelope.data.recoveryHint, /failed cleanup.*existence.*unverified/i);
          assert.doesNotMatch(envelope.data.recoveryHint, /cleanup was not attempted/i);
          if (repair === "green") {
            assert.equal(envelope.data.repairVerified, true);
            assert.notDeepEqual(await readFile(sourcePath), originalBytes);
          } else {
            assert.deepEqual(await readFile(sourcePath), originalBytes);
          }
        });
      });
    }
  }
});

describe("MCP result adaptation", () => {
  it("reports a Unity bridge soft failure as an MCP tool error", async () => {
    const fakeUnity = {
      request: async () => ({
        ok: false,
        error: {
          code: "UNITY_CONSOLE_READ_FAILED",
          message: "The Unity bridge rejected the request."
        }
      })
    } as unknown as UnityClient;
    const server = createMcpServer({ unity: fakeUnity });
    const client = new Client({ name: "unity-mcp-ghost-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      const result = await client.callTool({
        name: "console_read",
        arguments: { severity: "all", limit: 10 }
      });

      assert.equal(result.isError, true);
      assert.deepEqual((result.structuredContent as Record<string, unknown>).error, {
        code: "UNITY_CONSOLE_READ_FAILED",
        message: "The Unity bridge rejected the request."
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("waits for the exact compile generation instead of idle editor state", async () => {
    const observedRequests: Array<{ method: string; params: unknown }> = [];
    let reads = 0;
    const fakeUnity = {
      request: async (method: string, params: unknown) => {
        observedRequests.push({ method, params });
        reads++;
        return reads === 1
          ? { ok: true, status: "waiting", generation: 7, observed: false, diagnostics: [] }
          : { ok: true, status: "success", generation: 7, observed: true, diagnostics: [] };
      }
    } as unknown as UnityClient;
    const server = createMcpServer({ unity: fakeUnity });
    const client = new Client({ name: "unity-mcp-ghost-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: "compile_wait",
        arguments: { requestedCompileGeneration: 7, timeoutMs: 2000 }
      });

      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as Record<string, unknown>).ok, true);
      assert.ok(observedRequests.length >= 2);
      assert.ok(observedRequests.every((request) => request.method === "compile.status_get"));
      assert.ok(observedRequests.every((request) => (request.params as { requestedCompileGeneration?: number }).requestedCompileGeneration === 7));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports compiler diagnostics from only the validation generation", async () => {
    const fakeUnity = {
      request: async (method: string, params: unknown) => {
        if (method === "script.validate") {
          return { ok: true, path: "Assets/Broken.cs", requestedCompileGeneration: 12 };
        }
        if (method === "compile.status_get") {
          return { ok: false, status: "failed", generation: 12, observed: true, diagnostics: [] };
        }
        if (method === "compile.diagnostics_get") {
          assert.equal((params as { generation?: number }).generation, 12);
          return {
            ok: true,
            generation: 12,
            diagnostics: [{ generation: 12, severity: "error", code: "CS1002", message: "; expected" }]
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      }
    } as unknown as UnityClient;
    const server = createMcpServer({ unity: fakeUnity });
    const client = new Client({ name: "unity-mcp-ghost-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: "script_validate",
        arguments: { path: "Assets/Broken.cs", timeoutMs: 2000 }
      });

      assert.equal(result.isError, true);
      const envelope = result.structuredContent as Record<string, unknown>;
      assert.equal((envelope.error as { code: string }).code, "SCRIPT_COMPILER_ERRORS");
      assert.equal(((envelope.data as { diagnostics: unknown[] }).diagnostics as unknown[]).length, 1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("runs a bounded repair proposal through apply, compile, and verification", async () => {
    let activeGeneration = 1;
    let changed = false;
    const applyModes: boolean[] = [];
    const fakeUnity = {
      request: async (method: string, params: unknown) => {
        const request = params as Record<string, unknown>;
        if (method === "script.read") {
          return {
            ok: true,
            content: "public class Broken { void Run() { int score = 1 } }",
            sha256: changed ? "changed-hash" : "original-hash"
          };
        }
        if (method === "script.validate") {
          return { ok: true, requestedCompileGeneration: request.requestedCompileGeneration ?? activeGeneration };
        }
        if (method === "compile.status_get") {
          const generation = Number(request.requestedCompileGeneration);
          return { ok: generation === 2, status: generation === 2 ? "success" : "failed", generation, observed: true };
        }
        if (method === "compile.diagnostics_get") {
          return Number(request.generation) === 1
            ? { ok: true, diagnostics: [{ generation: 1, severity: "error", code: "CS1002", message: "error CS1002: ; expected", line: 1, column: 50 }] }
            : { ok: true, diagnostics: [] };
        }
        if (method === "script.apply_edits") {
          applyModes.push(request.dryRun === true);
          if (request.dryRun !== true) {
            changed = true;
            activeGeneration = 2;
          }
          return { ok: true, dryRun: request.dryRun, requestedCompileGeneration: request.dryRun ? undefined : 2 };
        }
        throw new Error(`Unexpected method: ${method}`);
      }
    } as unknown as UnityClient;
    const server = createMcpServer({ unity: fakeUnity });
    const client = new Client({ name: "unity-mcp-ghost-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: "repair_loop_run",
        arguments: { objective: "repair missing semicolon", scriptPath: "Assets/Broken.cs", maxIterations: 1, compileTimeoutMs: 2000 }
      });

      assert.equal(result.isError, undefined);
      assert.deepEqual(applyModes, [true, false]);
      const data = (result.structuredContent as { data: Record<string, unknown> }).data;
      assert.equal(data.ok, true);
      assert.equal(data.iterationCount, 1);
      assert.equal(data.finalSha256, "changed-hash");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("restores the original hash when every repair iteration fails", async () => {
    let activeGeneration = 1;
    let sourceChanged = false;
    let restoreWrites = 0;
    const fakeUnity = {
      request: async (method: string, params: unknown) => {
        const request = params as Record<string, unknown>;
        if (method === "script.read") {
          return {
            ok: true,
            content: "public class Broken { void Run() { int score = 1 } }",
            sha256: sourceChanged ? "changed-hash" : "original-hash"
          };
        }
        if (method === "script.validate") {
          return { ok: true, requestedCompileGeneration: request.requestedCompileGeneration ?? activeGeneration };
        }
        if (method === "compile.status_get") {
          const generation = Number(request.requestedCompileGeneration);
          return { ok: generation === 3, status: generation === 3 ? "success" : "failed", generation, observed: true };
        }
        if (method === "compile.diagnostics_get") {
          return {
            ok: true,
            diagnostics: [{ generation: request.generation, severity: "error", code: "CS1002", message: "error CS1002: ; expected", line: 1, column: 50 }]
          };
        }
        if (method === "script.apply_edits") {
          if (request.dryRun !== true) {
            sourceChanged = true;
            activeGeneration = 2;
          }
          return { ok: true, requestedCompileGeneration: request.dryRun ? undefined : 2 };
        }
        if (method === "script.write") {
          restoreWrites++;
          sourceChanged = false;
          activeGeneration = 3;
          return { ok: true, requestedCompileGeneration: 3 };
        }
        throw new Error(`Unexpected method: ${method}`);
      }
    } as unknown as UnityClient;
    const server = createMcpServer({ unity: fakeUnity });
    const client = new Client({ name: "unity-mcp-ghost-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: "repair_loop_run",
        arguments: { objective: "repair then restore", scriptPath: "Assets/Broken.cs", maxIterations: 1, compileTimeoutMs: 2000 }
      });

      assert.equal(result.isError, true);
      assert.equal(restoreWrites, 1);
      const envelope = result.structuredContent as { error: { code: string }; data: { restored: { ok: boolean; restoredSha256: string } } };
      assert.equal(envelope.error.code, "REPAIR_EXHAUSTED");
      assert.equal(envelope.data.restored.ok, true);
      assert.equal(envelope.data.restored.restoredSha256, "original-hash");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("waits for the requested normal Play mode generation to settle", async () => {
    let reads = 0;
    const fakeUnity = {
      request: async (method: string) => {
        if (method === "play_mode.set") {
          return { ok: true, requestedState: "playing", state: "enteringPlay", transitionGeneration: 9 };
        }
        if (method === "play_mode.get") {
          reads++;
          return { ok: true, state: reads < 2 ? "enteringPlay" : "playing", transitionGeneration: 9, frameCount: 1 };
        }
        throw new Error(`Unexpected method: ${method}`);
      }
    } as unknown as UnityClient;
    const server = createMcpServer({ unity: fakeUnity });
    const client = new Client({ name: "unity-mcp-ghost-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: "play_mode_set",
        arguments: { state: "playing", waitForSettled: true, timeoutMs: 2000, saveModifiedScenes: false }
      });

      assert.equal(result.isError, undefined);
      assert.ok(reads >= 2);
      const data = (result.structuredContent as { data: { settledState: { state: string; settled: boolean } } }).data;
      assert.equal(data.settledState.state, "playing");
      assert.equal(data.settledState.settled, true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("waits from an exact Console boundary until the filter matches", async () => {
    let reads = 0;
    const fakeUnity = {
      request: async (method: string, params: unknown) => {
        assert.equal(method, "console.query");
        assert.equal((params as { boundary: string }).boundary, "mark-1");
        reads++;
        return { ok: true, matched: reads > 1, count: reads > 1 ? 1 : 0, entries: [], unexpectedErrors: [] };
      }
    } as unknown as UnityClient;
    const server = createMcpServer({ unity: fakeUnity });
    const client = new Client({ name: "unity-mcp-ghost-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: "console_wait",
        arguments: { boundary: "mark-1", exact: "Hello", count: 1, timeoutMs: 1000, pollIntervalMs: 25 }
      });

      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as { data: { matched: boolean } }).data.matched, true);
      assert.ok(reads >= 2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports unsupported input backends as typed MCP errors", async () => {
    const fakeUnity = {
      request: async () => ({
        ok: false,
        status: "failed",
        error: { code: "UNSUPPORTED_INPUT_BACKEND", message: "No verified input backend accepted PageUp." }
      })
    } as unknown as UnityClient;
    const server = createMcpServer({ unity: fakeUnity });
    const client = new Client({ name: "unity-mcp-ghost-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const result = await client.callTool({
        name: "input_simulate",
        arguments: { device: "keyboard", action: "tap", key: "PageUp" }
      });

      assert.equal(result.isError, true);
      assert.equal((result.structuredContent as { error: { code: string } }).error.code, "UNSUPPORTED_INPUT_BACKEND");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
