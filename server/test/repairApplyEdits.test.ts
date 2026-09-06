import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/createServer.js";
import { listOperationCatalog } from "../src/mcp/operationCatalog.js";
import { UnityRequestTimeoutError, type UnityClient, type UnityRequestOptions } from "../src/unity/UnityClient.js";
import { compileState } from "./fixtures/compileEvidence.js";

type Backup = { backupPath: string; backupMetaPath: string };
type Request = { method: string; params: Record<string, unknown>; options: UnityRequestOptions };
type ReadFault = "soft-failure" | "missing-content" | "missing-hash" | "hash-mismatch";
type Options = {
  dryRun?: boolean;
  rollbackOnFailure?: boolean;
  emptyOriginal?: boolean;
  noOp?: boolean;
  sourceOnlyBackup?: boolean;
  malformedReceipt?: "missing-before" | "invalid-before" | "wrong-before" | "missing-after" | "invalid-after" | "missing-source-backup";
  concurrentAt?: "before-apply" | "before-rollback-read" | "before-restore";
  wrongGeneration?: "compile" | "validation" | "diagnostics";
  initialRead?: Exclude<ReadFault, "hash-mismatch">;
  previewFailure?: boolean;
  apply?: "soft-failure" | "response-lost" | "response-lost-without-id" | "partial-failure" | "partial-unknown" | "partial-no-backup-path";
  repair?: "compile-failed" | "compiler-error" | "validation-throw" | "validation-soft" | "diagnostics-soft";
  staleConsoleError?: boolean;
  finalRead?: Exclude<ReadFault, "missing-content">;
  tests?:
    | "success"
    | "failed"
    | "cancelled"
    | "timeout"
    | "aborted"
    | "missing-ok"
    | "start-throw"
    | "start-timeout"
    | "start-not-executed"
    | "start-generic-known-flag"
    | "poll-throw";
  restore?:
    | "soft-failure"
    | "soft-failure-after-backup"
    | "throw"
    | "compile-failed"
    | "compile-timeout"
    | "missing-generation"
    | "hash-mismatch"
    | "readback-throw"
    | "readback-soft"
    | "readback-missing-hash"
    | "validation-soft"
    | "diagnostics-soft"
    | "compiler-error";
  cleanup?: "soft-failure" | "throw" | "response-lost";
  cleanupFailAt?: number;
};
type Envelope = {
  ok: boolean;
  requestId?: string;
  error?: { code: string; message: string };
  warnings?: string[];
  data: {
    resultContractVersion?: number;
    consoleDiagnosticsChecked?: boolean;
    consoleErrorCount?: number | null;
    mode?: string;
    editCount?: number;
    originalSha256?: string;
    currentSha256?: string | null;
    finalSha256?: string | null;
    repairVerified?: boolean;
    rollback?: { ok?: boolean; byteIdentical?: boolean } | null;
    restored?: { ok?: boolean; byteIdentical?: boolean } | null;
    retainedBackups?: Backup[];
    transactionCleanup?: Array<Backup & { ok: boolean; outcomeUnknown?: boolean }>;
    recoveryPathsUnverified?: boolean;
    recoveryHint?: string | null;
    unconfirmedApply?: { requestId: string; outcomeUnknown: boolean } | null;
    unconfirmedTests?: unknown;
    testsFailed?: boolean;
    applyResult?: { beforeSha256?: string; afterSha256?: string; error?: { restorationStatus?: string; recoveryFiles?: string[] } };
  };
};
type Fixture = {
  client: Client;
  server: ReturnType<typeof createMcpServer>;
  result: Awaited<ReturnType<Client["callTool"]>>;
  envelope: Envelope;
  sourcePath: string;
  originalBytes: Buffer;
  originalMeta: Buffer;
  concurrentBytes: Buffer;
  concurrentMeta: Buffer;
  appliedBytes: Buffer;
  backups: Backup[];
  requests: Request[];
  applies: Request[];
  restores: Request[];
  cleanups: Request[];
};
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
// ScriptFileTransaction.Read strips the encoding preamble from content, while
// sha256 covers the complete bytes. Re-hashing returned text would lose the BOM.
const sourceText = (bytes: Buffer) => bytes.toString("utf8").replace(/^\uFEFF/, "");
const softFailure = (code: string) => ({ ok: false, error: { code, message: `Fixture producer rejected ${code}.` } });

// The MCP route and temporary source/meta/backup files are real. Unity responses
// are controlled at the bridge boundary; these are not live compiler or runner evidence.
async function withExplicitRepair(options: Options, verify: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "ghost-explicit-repair-"));
  const sourcePath = path.join(directory, "Broken.cs");
  // Valid C# with a semantic value to repair; compiler outcomes remain controlled.
  const originalBytes = Buffer.from(options.emptyOriginal ? "" : "\uFEFFpublic class Broken { public int Score = 1; }\r\n", "utf8");
  const originalMeta = Buffer.from("fileFormatVersion: 2\r\nguid: explicit-repair-original\r\n");
  const concurrentBytes = Buffer.from("\uFEFFpublic class Broken { public int Score = 99; }\r\n");
  const concurrentMeta = Buffer.from("fileFormatVersion: 2\r\nguid: concurrent-editor\r\n");
  const backups: Backup[] = [];
  const requests: Request[] = [];
  let appliedBytes = Buffer.alloc(0);
  let generation = 1;
  let restoring = false;
  let reads = 0;
  let finalReadFaultUsed = false;
  let cleanupCount = 0;
  const writeConcurrent = async () => {
    await writeFile(sourcePath, concurrentBytes);
    await writeFile(`${sourcePath}.meta`, concurrentMeta);
  };
  const conflict = (bytes: Buffer) => ({ ...softFailure("SCRIPT_HASH_MISMATCH"), beforeSha256: sha256(bytes), afterSha256: sha256(bytes) });
  const retainCurrent = async () => {
    const backup = {
      backupPath: path.join(directory, `backup-${backups.length + 1}.cs`),
      backupMetaPath: options.sourceOnlyBackup ? "" : path.join(directory, `backup-${backups.length + 1}.cs.meta`)
    };
    await copyFile(sourcePath, backup.backupPath);
    if (backup.backupMetaPath) await copyFile(`${sourcePath}.meta`, backup.backupMetaPath);
    backups.push(backup);
    return backup;
  };
  const unity = {
    request: async (method: string, params: Record<string, unknown> = {}, requestOptions: UnityRequestOptions = {}) => {
      requests.push({ method, params, options: requestOptions });
      if (method === "script.read") {
        const initial = reads++ === 0;
        if (!initial && !restoring && options.concurrentAt === "before-rollback-read") await writeConcurrent();
        const bytes = await readFile(sourcePath);
        let fault: ReadFault | undefined = initial ? options.initialRead : undefined;
        if (!initial && generation > 1 && !restoring && !finalReadFaultUsed && options.finalRead) {
          finalReadFaultUsed = true;
          fault = options.finalRead;
        }
        if (restoring && options.restore === "readback-throw") throw new Error("Restored source read-back failed.");
        if (restoring && options.restore === "readback-soft") fault = "soft-failure";
        if (restoring && options.restore === "readback-missing-hash") fault = "missing-hash";
        if (fault === "soft-failure") return softFailure("SCRIPT_READ_FAILED");
        return {
          ok: true,
          ...(fault === "missing-content" ? {} : { content: sourceText(bytes) }),
          ...(fault === "missing-hash" ? {} : { sha256: fault === "hash-mismatch" ? "0".repeat(64) : sha256(bytes) })
        };
      }
      if (method === "script.apply_edits") {
        if (params.dryRun !== true && options.concurrentAt === "before-apply") await writeConcurrent();
        const before = await readFile(sourcePath);
        if (params.expectedSha256 !== sha256(before)) return conflict(before);
        if (params.dryRun === true) return options.previewFailure ? softFailure("SCRIPT_EDIT_RANGE_INVALID") : { ok: true, dryRun: true };
        if (options.apply === "soft-failure") return softFailure("SCRIPT_HASH_MISMATCH");
        const backup = await retainCurrent();
        const edit = (params.edits as Array<{ startColumn: number; endColumn: number; text: string }>)[0]!;
        const text = sourceText(before);
        const preamble = before.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? "\uFEFF" : "";
        appliedBytes = Buffer.from(preamble + text.slice(0, edit.startColumn) + edit.text + text.slice(edit.endColumn));
        await writeFile(sourcePath, appliedBytes);
        generation++;
        if (options.apply?.startsWith("partial-")) {
          return {
            ok: false,
            ...(options.apply === "partial-no-backup-path" ? {} : backup),
            afterSha256: options.apply === "partial-unknown" ? null : sha256(appliedBytes),
            error: {
              code: "SCRIPT_ATOMIC_REPLACE_FAILED",
              message: "Transaction failed and its recovery is incomplete.",
              restorationStatus: options.apply === "partial-unknown" ? "unknown" : "incomplete",
              recoveryFiles: [backup.backupPath, backup.backupMetaPath],
              recoveryDirectory: directory
            }
          };
        }
        if (options.apply?.startsWith("response-lost")) {
          const error = new UnityRequestTimeoutError("Apply response lost after source mutation.", requestOptions.requestId ?? "unassigned-apply", true);
          if (options.apply === "response-lost-without-id") Reflect.deleteProperty(error, "requestId");
          throw error;
        }
        const receipt: Record<string, unknown> = {
          ok: true,
          ...backup,
          beforeSha256: sha256(before),
          afterSha256: sha256(appliedBytes),
          requestedCompileGeneration: generation
        };
        if (options.malformedReceipt === "missing-before") delete receipt.beforeSha256;
        if (options.malformedReceipt === "invalid-before") receipt.beforeSha256 = "not-a-hash";
        if (options.malformedReceipt === "wrong-before") receipt.beforeSha256 = "a".repeat(64);
        if (options.malformedReceipt === "missing-after") delete receipt.afterSha256;
        if (options.malformedReceipt === "invalid-after") receipt.afterSha256 = "not-a-hash";
        if (options.malformedReceipt === "missing-source-backup") delete receipt.backupPath;
        return receipt;
      }
      if (method === "compile.status_get") {
        const failed = restoring ? options.restore === "compile-failed" : options.repair === "compile-failed";
        const status = restoring && options.restore === "compile-timeout" ? "waiting" : failed ? "failed" : "success";
        return compileState(Number(!restoring && options.wrongGeneration === "compile" ? 999 : params.requestedCompileGeneration), status);
      }
      if (method === "script.validate") {
        if (!restoring && options.repair === "validation-throw") throw new Error("Validation transport failed after confirmed apply.");
        if (restoring ? options.restore === "validation-soft" : options.repair === "validation-soft") return softFailure("SCRIPT_VALIDATE_FAILED");
        return {
          ok: true,
          requestedCompileGeneration: !restoring && options.wrongGeneration === "validation" ? 999 : (params.requestedCompileGeneration ?? generation),
          diagnostics: []
        };
      }
      if (method === "compile.diagnostics_get") {
        if (restoring ? options.restore === "diagnostics-soft" : options.repair === "diagnostics-soft") return softFailure("COMPILE_DIAGNOSTICS_FAILED");
        const hasError = restoring ? options.restore === "compiler-error" : options.repair === "compiler-error";
        return {
          ok: true,
          generation: !restoring && options.wrongGeneration === "diagnostics" ? 999 : params.generation,
          diagnostics: hasError ? [{ generation: params.generation, severity: "error", code: "CS1002", file: "Assets/Broken.cs", message: "; expected" }] : []
        };
      }
      if (method === "console.diagnostics_get") {
        return {
          ok: true,
          diagnostics: options.staleConsoleError
            ? [{ generation: 1, severity: "error", code: "CS1002", file: "Assets/Broken.cs", message: "Old compiler error: ; expected" }]
            : []
        };
      }
      if (method === "tests.run") {
        if (options.tests === "start-not-executed")
          throw new UnityRequestTimeoutError(
            "Queued test request was removed before execution.",
            requestOptions.requestId ?? "tests-start",
            false,
            "UNITY_REQUEST_TIMEOUT"
          );
        if (options.tests === "start-generic-known-flag")
          throw Object.assign(new Error("Generic failure with an untrusted outcome flag."), { outcomeUnknown: false });
        if (options.tests === "start-throw") throw new Error("Test start transport failed after apply.");
        if (options.tests === "start-timeout")
          throw new UnityRequestTimeoutError("Test start outcome unknown.", requestOptions.requestId ?? "tests-start", true);
        if (options.tests === "poll-throw") return { ok: true, operationId: "still-running-tests", state: { status: "running" } };
        // These are already terminal receipts. A local polling deadline does not
        // turn a running Test Runner into any of these terminal states.
        return {
          ...(options.tests === "missing-ok" ? {} : { ok: options.tests === "success" }),
          state: { status: options.tests === "missing-ok" ? "success" : options.tests, failed: options.tests === "failed" ? 1 : 0 }
        };
      }
      if (method === "operation.get") throw new Error("Test operation transport lost; runner remains running.");
      if (method === "script.restore") {
        assert.equal(params.backupPath, backups[0]?.backupPath, "restore must use the original source backup");
        assert.equal(params.backupMetaPath, backups[0]?.backupMetaPath);
        if (options.concurrentAt === "before-restore") await writeConcurrent();
        const currentBytes = await readFile(sourcePath);
        if (params.expectedSha256 !== sha256(currentBytes)) return conflict(currentBytes);
        if (options.restore === "soft-failure") return softFailure("SCRIPT_RESTORE_FAILED");
        if (options.restore === "throw") throw new UnityRequestTimeoutError("Restore outcome unknown.", requestOptions.requestId ?? "restore", true);
        const backup = await retainCurrent();
        if (options.restore === "soft-failure-after-backup") return { ...softFailure("SCRIPT_RESTORE_FAILED"), ...backup };
        await copyFile(String(params.backupPath), sourcePath);
        if (params.backupMetaPath) await copyFile(String(params.backupMetaPath), `${sourcePath}.meta`);
        if (options.restore === "hash-mismatch") await writeFile(sourcePath, "unexpected rollback bytes\r\n");
        restoring = true;
        generation++;
        return {
          ok: true,
          ...backup,
          afterSha256: sha256(await readFile(sourcePath)),
          requestedCompileGeneration: options.restore === "missing-generation" ? undefined : generation
        };
      }
      if (method === "script.transaction_complete") {
        cleanupCount++;
        const failNow = cleanupCount === (options.cleanupFailAt ?? 1);
        if (failNow && options.cleanup === "soft-failure") return softFailure("SCRIPT_BACKUP_DELETE_FAILED");
        if (failNow && options.cleanup === "throw") throw new Error("Cleanup transport failed.");
        await rm(String(params.backupPath));
        if (params.backupMetaPath) await rm(String(params.backupMetaPath));
        if (failNow && options.cleanup === "response-lost") throw new Error("Cleanup response lost after deletion.");
        return { ok: true, discarded: true };
      }
      throw new Error(`Unexpected bridge request: ${method}`);
    }
  } as unknown as UnityClient;
  const server = createMcpServer({ unity });
  const client = new Client({ name: "ghost-explicit-repair-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await writeFile(sourcePath, originalBytes);
    await writeFile(`${sourcePath}.meta`, originalMeta);
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = await client.callTool({
      name: "repair_apply_edits",
      arguments: {
        scriptPath: "Assets/Broken.cs",
        edits: [
          {
            startLine: 0,
            startColumn: 0,
            endLine: 0,
            endColumn: sourceText(originalBytes).split("\r\n")[0]!.length,
            text: options.noOp ? sourceText(originalBytes).split("\r\n")[0]! : "public class Broken { public int Score = 2; }"
          }
        ],
        dryRun: options.dryRun ?? false,
        rollbackOnFailure: options.rollbackOnFailure ?? true,
        compileTimeoutMs: 25,
        runTests: options.tests !== undefined
      }
    });
    await verify({
      client,
      server,
      result,
      envelope: result.structuredContent as Envelope,
      sourcePath,
      originalBytes,
      originalMeta,
      concurrentBytes,
      concurrentMeta,
      appliedBytes,
      backups,
      requests,
      applies: requests.filter((request) => request.method === "script.apply_edits" && request.params.dryRun === false),
      restores: requests.filter((request) => request.method === "script.restore"),
      cleanups: requests.filter((request) => request.method === "script.transaction_complete")
    });
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertOriginal(fixture: Fixture) {
  assert.deepEqual(await readFile(fixture.sourcePath), fixture.originalBytes);
  assert.deepEqual(await readFile(`${fixture.sourcePath}.meta`), fixture.originalMeta);
}

async function assertRetained(fixture: Fixture) {
  assert.ok(fixture.envelope.data, "return recovery evidence after a failed request");
  assert.deepEqual(fixture.envelope.data.retainedBackups, fixture.backups, "return every known source/meta backup receipt");
  for (const [index, backup] of fixture.backups.entries()) {
    assert.deepEqual(await readFile(backup.backupPath), index === 0 ? fixture.originalBytes : fixture.appliedBytes);
    assert.deepEqual(await readFile(backup.backupMetaPath), fixture.originalMeta);
  }
}

describe("repair_apply_edits recovery contract", () => {
  for (const malformedReceipt of ["missing-before", "invalid-before", "wrong-before", "missing-after", "invalid-after", "missing-source-backup"] as const) {
    it(`review: stops immediately at an incomplete positive apply receipt: ${malformedReceipt}`, async () => {
      await withExplicitRepair({ malformedReceipt, tests: "success" }, async (fixture) => {
        assert.equal(fixture.result.isError, true);
        assert.equal(fixture.envelope.error?.code, "REPAIR_APPLY_RECEIPT_INVALID");
        assert.equal(fixture.envelope.data.mode, "recovery-required");
        assert.equal(fixture.requests.at(-1), fixture.applies[0], "do not compile, test, restore, read, or clean up after an incomplete apply receipt");
        assert.equal(fixture.restores.length, 0);
        assert.equal(fixture.cleanups.length, 0);
        assert.equal(fixture.envelope.data.currentSha256, ["missing-after", "invalid-after"].includes(malformedReceipt) ? null : sha256(fixture.appliedBytes));
        assert.deepEqual(
          fixture.envelope.data.retainedBackups,
          fixture.backups.map((backup) => ({ ...backup, backupPath: malformedReceipt === "missing-source-backup" ? "" : backup.backupPath }))
        );
        assert.match(fixture.envelope.data.recoveryHint ?? "", /reconcile/i);
        assert.deepEqual(await readFile(fixture.sourcePath), fixture.appliedBytes);
        for (const backup of fixture.backups) {
          assert.deepEqual(await readFile(backup.backupPath), fixture.originalBytes);
          assert.deepEqual(await readFile(backup.backupMetaPath), fixture.originalMeta);
        }
      });
    });
  }

  for (const noOp of [false, true]) {
    it(`review: accepts producer source-only backup receipts, byte-identical edit=${noOp}`, async () => {
      await withExplicitRepair({ noOp, sourceOnlyBackup: true }, async (fixture) => {
        assert.notEqual(fixture.result.isError, true);
        assert.equal(fixture.envelope.data.repairVerified, true);
        assert.equal(fixture.envelope.data.applyResult?.beforeSha256, sha256(fixture.originalBytes));
        assert.equal(fixture.envelope.data.applyResult?.afterSha256, sha256(fixture.appliedBytes));
        assert.equal(fixture.backups[0]!.backupMetaPath, "", "source-only writes do not require a metadata backup");
        assert.equal(fixture.cleanups.length, 1);
        assert.deepEqual(await readFile(`${fixture.sourcePath}.meta`), fixture.originalMeta);
        if (noOp) await assertOriginal(fixture);
      });
    });
  }

  for (const concurrentAt of ["before-apply", "before-rollback-read", "before-restore"] as const) {
    it(`review: preserves actual concurrent source and metadata writes: ${concurrentAt}`, async () => {
      await withExplicitRepair({ concurrentAt, repair: "compile-failed" }, async (fixture) => {
        assert.equal(fixture.result.isError, true);
        assert.equal(fixture.envelope.error?.code, concurrentAt === "before-apply" ? "SCRIPT_HASH_MISMATCH" : "REPAIR_ROLLBACK_FAILED");
        assert.deepEqual(await readFile(fixture.sourcePath), fixture.concurrentBytes);
        assert.deepEqual(await readFile(`${fixture.sourcePath}.meta`), fixture.concurrentMeta);
        assert.equal(fixture.applies.length, 1);
        assert.equal(fixture.restores.length, concurrentAt === "before-restore" ? 1 : 0);
        assert.equal(fixture.cleanups.length, 0);
        assert.equal(fixture.backups.length, concurrentAt === "before-apply" ? 0 : 1);
        if (concurrentAt !== "before-apply") {
          assert.equal(fixture.envelope.data.rollback?.ok, false);
          await assertRetained(fixture);
        }
      });
    });
  }

  for (const wrongGeneration of ["compile", "validation", "diagnostics"] as const) {
    it(`review: rejects mismatched ${wrongGeneration} generation and restores`, async () => {
      await withExplicitRepair({ wrongGeneration }, async (fixture) => {
        assert.equal(fixture.result.isError, true);
        assert.equal(fixture.envelope.error?.code, "COMPILE_GENERATION_MISMATCH");
        assert.equal(fixture.restores.length, 1);
        assert.equal(fixture.envelope.data.rollback?.ok, true);
        await assertOriginal(fixture);
        assert.equal(fixture.cleanups.length, 2);
      });
    });
  }

  for (const restore of [undefined, "soft-failure"] as const) {
    it(`review: restores after typed proof that test start did not execute; restore=${restore ?? "success"}`, async () => {
      await withExplicitRepair({ tests: "start-not-executed", restore }, async (fixture) => {
        assert.equal(fixture.result.isError, true);
        assert.equal(fixture.envelope.error?.code, restore ? "REPAIR_ROLLBACK_FAILED" : "UNITY_REQUEST_TIMEOUT");
        assert.equal(fixture.envelope.data.unconfirmedTests, null);
        assert.equal(fixture.envelope.data.testsFailed, true);
        assert.equal(fixture.restores.length, 1);
        if (restore) {
          assert.equal(fixture.cleanups.length, 0);
          await assertRetained(fixture);
        } else {
          await assertOriginal(fixture);
          assert.equal(fixture.envelope.data.rollback?.ok, true);
          assert.equal(fixture.cleanups.length, 2);
        }
      });
    });
  }

  for (const options of [
    {},
    { dryRun: true },
    { dryRun: true, rollbackOnFailure: false },
    { rollbackOnFailure: false },
    { initialRead: "soft-failure" },
    { previewFailure: true },
    { repair: "compile-failed" },
    { cleanup: "soft-failure" },
    { apply: "response-lost" },
    { tests: "start-timeout" }
  ] satisfies Options[]) {
    it(`review: returns explicit result contract 2 on every handler outcome: ${JSON.stringify(options)}`, async () => {
      await withExplicitRepair(options, async (fixture) => {
        assert.equal(fixture.envelope.data.resultContractVersion, 2);
        assert.equal(fixture.envelope.data.consoleDiagnosticsChecked, false);
        assert.equal(fixture.envelope.data.consoleErrorCount, null);
        assert.equal(
          fixture.requests.some((request) => request.method === "console.diagnostics_get"),
          false
        );
        if (options.rollbackOnFailure === false && !options.dryRun) {
          assert.equal(fixture.envelope.error?.code, "REPAIR_ROLLBACK_REQUIRED");
          assert.deepEqual(fixture.requests, []);
        }
      });
    });
  }

  it("review: publishes the result contract and rollback constraint through tools/list and the operation catalog", async () => {
    await withExplicitRepair({ dryRun: true }, async ({ client, server }) => {
      type Schema = { type?: string; const?: unknown; description?: string; required?: string[]; properties?: Record<string, Schema>; anyOf?: Schema[] };
      const listed = await client.listTools();
      const repair = listed.tools.find((tool) => tool.name === "repair_apply_edits")!;
      const schema = repair.outputSchema as Schema;
      const data = schema.properties!.data!;
      const variants = data.anyOf ?? [data];
      const fields = variants.find((variant) => variant.type === "object")!;
      assert.ok(fields, "output data must publish its explicit fields");
      assert.equal(fields.properties?.resultContractVersion?.const, 2);
      assert.equal(fields.properties?.consoleDiagnosticsChecked?.const, false);
      assert.equal(fields.properties?.consoleErrorCount?.type, "null");
      for (const field of ["resultContractVersion", "consoleDiagnosticsChecked", "consoleErrorCount"]) assert.ok(fields.required?.includes(field));
      assert.ok(
        variants.some((variant) => variant.type === "null"),
        "infrastructure error envelopes may have null data"
      );
      assert.match((repair.inputSchema as Schema).properties?.rollbackOnFailure?.description ?? "", /false.*only.*dry.run/i);
      assert.match(repair.description ?? "", /requires.*rollback/i);
      const catalog = listOperationCatalog(server).find((entry) => entry.name === repair.name)!;
      assert.deepEqual((catalog.outputSchema as Schema).properties?.data, data, "catalog and SDK must publish the same output contract");
      const ping = listed.tools.find((tool) => tool.name === "ping")!;
      assert.doesNotMatch(JSON.stringify(ping.outputSchema), /resultContractVersion/, "other tools keep the shared default output schema");
    });
  });

  for (const initialRead of ["soft-failure", "missing-content", "missing-hash"] as const) {
    it(`rejects an unverified original before preview or mutation: ${initialRead}`, async () => {
      await withExplicitRepair({ initialRead }, async (fixture) => {
        assert.equal(fixture.result.isError, true);
        assert.deepEqual(
          fixture.requests.map((request) => request.method),
          ["script.read"]
        );
        assert.equal(fixture.backups.length, 0);
        if (initialRead === "soft-failure") assert.equal(fixture.envelope.error?.code, "SCRIPT_READ_FAILED");
        await assertOriginal(fixture);
      });
    });
  }

  for (const dryRun of [true, false]) {
    it(`propagates preview producer failure with dryRun=${dryRun}`, async () => {
      await withExplicitRepair({ dryRun, previewFailure: true }, async (fixture) => {
        assert.equal(fixture.result.isError, true);
        assert.equal(fixture.envelope.error?.code, "SCRIPT_EDIT_RANGE_INVALID");
        assert.equal(fixture.applies.length, 0);
        assert.equal(fixture.restores.length, 0);
        assert.equal(fixture.cleanups.length, 0);
        await assertOriginal(fixture);
      });
    });
  }

  it("propagates a rejected apply without inventing a mutation or restoration", async () => {
    await withExplicitRepair({ apply: "soft-failure" }, async (fixture) => {
      assert.equal(fixture.result.isError, true);
      assert.equal(fixture.envelope.error?.code, "SCRIPT_HASH_MISMATCH");
      assert.equal(fixture.restores.length, 0);
      assert.equal(fixture.cleanups.length, 0);
      await assertOriginal(fixture);
    });
  });

  for (const apply of ["partial-failure", "partial-unknown", "partial-no-backup-path"] as const) {
    it(`preserves a failed producer transaction requiring recovery: ${apply}`, async () => {
      await withExplicitRepair({ apply }, async (fixture) => {
        assert.equal(fixture.result.isError, true);
        assert.equal(fixture.envelope.error?.code, "SCRIPT_ATOMIC_REPLACE_FAILED");
        assert.equal(fixture.requests.at(-1), fixture.applies[0], "a partial producer transaction requires explicit reconciliation");
        assert.equal(fixture.restores.length, 0);
        assert.equal(fixture.cleanups.length, 0);
        assert.equal(fixture.envelope.data.currentSha256, apply === "partial-unknown" ? null : sha256(fixture.appliedBytes));
        assert.deepEqual(fixture.envelope.data.applyResult?.error?.recoveryFiles, [fixture.backups[0]!.backupPath, fixture.backups[0]!.backupMetaPath]);
        assert.equal(fixture.envelope.data.applyResult?.error?.restorationStatus, apply === "partial-unknown" ? "unknown" : "incomplete");
        assert.match(fixture.envelope.data.recoveryHint ?? "", /reconcile/i);
        assert.deepEqual(await readFile(fixture.backups[0]!.backupPath), fixture.originalBytes);
        assert.deepEqual(await readFile(fixture.backups[0]!.backupMetaPath), fixture.originalMeta);
      });
    });
  }

  it("keeps the explicit dry-run contract without mutating source", async () => {
    await withExplicitRepair({ dryRun: true }, async (fixture) => {
      assert.notEqual(fixture.result.isError, true);
      assert.equal(fixture.envelope.data.mode, "dry-run");
      assert.equal(fixture.envelope.data.editCount, 1);
      assert.equal(fixture.applies.length, 0);
      assert.equal(fixture.cleanups.length, 0);
      await assertOriginal(fixture);
    });
  });

  for (const staleConsoleError of [false, true]) {
    it(`verifies final hash and exact-generation compiler before cleanup; historical Console error=${staleConsoleError}`, async () => {
      await withExplicitRepair({ staleConsoleError, tests: "success" }, async (fixture) => {
        assert.notEqual(fixture.result.isError, true);
        assert.equal(fixture.envelope.ok, true);
        assert.equal(fixture.envelope.data.repairVerified, true);
        assert.equal(fixture.envelope.data.currentSha256, sha256(fixture.appliedBytes));
        assert.deepEqual(await readFile(fixture.sourcePath), fixture.appliedBytes);
        assert.equal(fixture.restores.length, 0);
        const cleanupIndex = fixture.requests.findIndex((request) => request.method === "script.transaction_complete");
        assert.ok(
          fixture.requests.slice(1, cleanupIndex).some((request) => request.method === "script.read"),
          "read final source before deleting the backup"
        );
        const compiler = fixture.requests.find((request) => request.method === "compile.diagnostics_get");
        assert.deepEqual(compiler?.params, { severity: "error", pathFilter: "Assets/Broken.cs", generation: 2, limit: 100 });
        assert.equal(fixture.applies[0]?.params.expectedSha256, sha256(fixture.originalBytes));
        assert.equal(fixture.cleanups.length, 1);
        await assert.rejects(stat(fixture.backups[0]!.backupPath), { code: "ENOENT" });
      });
    });
  }

  for (const finalRead of ["soft-failure", "missing-hash", "hash-mismatch"] as const) {
    it(`does not release an unverified repaired source: ${finalRead}`, async () => {
      await withExplicitRepair({ finalRead }, async (fixture) => {
        assert.equal(fixture.result.isError, true);
        assert.equal(fixture.restores.length, 1);
        await assertOriginal(fixture);
        assert.equal((fixture.envelope.data.rollback ?? fixture.envelope.data.restored)?.ok, true);
        assert.equal(fixture.cleanups.length, 2);
      });
    });
  }

  for (const repair of ["compile-failed", "compiler-error", "validation-throw", "validation-soft", "diagnostics-soft"] as const) {
    it(`restores after confirmed apply when required checks fail: ${repair}`, async () => {
      await withExplicitRepair({ repair }, async (fixture) => {
        assert.equal(fixture.result.isError, true);
        assert.equal(fixture.restores.length, 1);
        await assertOriginal(fixture);
        assert.equal((fixture.envelope.data.rollback ?? fixture.envelope.data.restored)?.ok, true);
        assert.equal(fixture.cleanups.length, 2);
        if (repair === "validation-soft") assert.equal(fixture.envelope.error?.code, "SCRIPT_VALIDATE_FAILED");
        if (repair === "diagnostics-soft") assert.equal(fixture.envelope.error?.code, "COMPILE_DIAGNOSTICS_FAILED");
      });
    });
  }

  for (const emptyOriginal of [false, true]) {
    it(`restores source and metadata byte-identically after an exception, empty source=${emptyOriginal}`, async () => {
      await withExplicitRepair({ repair: "validation-throw", emptyOriginal }, async (fixture) => {
        assert.equal(fixture.result.isError, true);
        assert.equal(fixture.restores.length, 1);
        await assertOriginal(fixture);
        assert.equal((fixture.envelope.data.rollback ?? fixture.envelope.data.restored)?.ok, true);
      });
    });
  }

  for (const tests of ["failed", "cancelled", "timeout", "aborted", "missing-ok"] as const) {
    for (const rollbackOnFailure of [true, false]) {
      it(`never retains a non-green required-test repair: terminal ${tests}, rollbackOnFailure=${rollbackOnFailure}`, async () => {
        await withExplicitRepair({ tests, rollbackOnFailure }, async (fixture) => {
          assert.equal(fixture.result.isError, true);
          await assertOriginal(fixture);
          if (fixture.applies.length > 0) {
            assert.equal(fixture.restores.length, 1);
            assert.equal((fixture.envelope.data.rollback ?? fixture.envelope.data.restored)?.ok, true);
            assert.equal(fixture.cleanups.length, 2);
          } else {
            assert.equal(rollbackOnFailure, false, "only the unsafe option may be rejected before applying");
            assert.equal(fixture.cleanups.length, 0);
          }
        });
      });
    }
  }

  for (const tests of ["start-throw", "start-timeout", "start-generic-known-flag", "poll-throw"] as const) {
    it(`preserves recovery when required test execution is unsettled: ${tests}`, async () => {
      await withExplicitRepair({ tests }, async (fixture) => {
        assert.equal(fixture.result.isError, true);
        assert.equal(fixture.restores.length, 0, "a potentially running Test Runner must be reconciled before source restoration");
        assert.equal(fixture.cleanups.length, 0);
        await assertRetained(fixture);
        assert.match(fixture.envelope.data.recoveryHint ?? "", /test.*unknown|test.*unsettled|reconcile/i);
      });
    });
  }

  for (const restore of [
    "soft-failure",
    "soft-failure-after-backup",
    "throw",
    "compile-failed",
    "compile-timeout",
    "missing-generation",
    "hash-mismatch",
    "readback-throw",
    "readback-soft",
    "readback-missing-hash",
    "validation-soft",
    "diagnostics-soft",
    "compiler-error"
  ] as const) {
    it(`keeps every recovery backup and never claims verified restoration: ${restore}`, async () => {
      await withExplicitRepair({ repair: "compile-failed", restore }, async (fixture) => {
        assert.equal(fixture.result.isError, true);
        assert.equal(fixture.restores.length, 1);
        assert.equal(fixture.cleanups.length, 0, "unverified restoration cannot release any recovery files");
        assert.equal((fixture.envelope.data.rollback ?? fixture.envelope.data.restored)?.ok, false);
        assert.equal(fixture.envelope.data.originalSha256, sha256(fixture.originalBytes));
        assert.deepEqual(fixture.envelope.data.transactionCleanup, []);
        await assertRetained(fixture);
        if (!["soft-failure", "throw"].includes(restore)) assert.equal(fixture.backups.length, 2, "retain original and pre-rollback bytes");
      });
    });
  }

  for (const cleanup of ["soft-failure", "throw", "response-lost"] as const) {
    for (const repair of [undefined, "compile-failed", "validation-throw"] as const) {
      it(`reports cleanup ${cleanup} after ${repair ?? "green repair"} without replay`, async () => {
        await withExplicitRepair({ cleanup, repair }, async (fixture) => {
          assert.equal(fixture.result.isError, true);
          assert.equal(fixture.restores.length, repair ? 1 : 0);
          assert.equal(fixture.cleanups.length, 1, "stop after first cleanup failure");
          assert.ok(fixture.envelope.data, "cleanup errors must retain recovery evidence");
          assert.equal(fixture.envelope.data.transactionCleanup?.[0]?.ok, false);
          assert.equal(fixture.envelope.data.recoveryPathsUnverified, true);
          assert.deepEqual(fixture.envelope.data.retainedBackups, fixture.backups);
          assert.match(fixture.envelope.data.recoveryHint ?? "", /existence.*unverified/i);
          if (repair) await assertOriginal(fixture);
          else assert.equal(fixture.envelope.data.repairVerified, true);
          if (cleanup === "response-lost") {
            assert.equal(fixture.envelope.data.transactionCleanup?.[0]?.outcomeUnknown, true);
            await assert.rejects(stat(fixture.backups[0]!.backupPath), { code: "ENOENT" });
          } else {
            await assertRetained(fixture);
          }
        });
      });
    }
  }

  it("retains the rollback backup after original-backup cleanup succeeded and second cleanup failed", async () => {
    await withExplicitRepair({ repair: "compile-failed", cleanup: "soft-failure", cleanupFailAt: 2 }, async (fixture) => {
      assert.equal(fixture.result.isError, true);
      assert.equal(fixture.restores.length, 1);
      assert.equal(fixture.cleanups.length, 2);
      await assertOriginal(fixture);
      await assert.rejects(stat(fixture.backups[0]!.backupPath), { code: "ENOENT" });
      assert.ok((await stat(fixture.backups[1]!.backupPath)).isFile());
      assert.deepEqual(fixture.envelope.data.retainedBackups, fixture.backups.slice(1));
      assert.deepEqual(
        fixture.envelope.data.transactionCleanup?.map((receipt) => receipt.ok),
        [true, false]
      );
    });
  });

  for (const apply of ["response-lost", "response-lost-without-id"] as const) {
    it(`records the apply ID before dispatch and stops with an unknown mutation: ${apply}`, async () => {
      await withExplicitRepair({ apply }, async (fixture) => {
        assert.equal(fixture.result.isError, true);
        assert.equal(fixture.applies.length, 1);
        assert.equal(fixture.requests.at(-1), fixture.applies[0], "no read or mutation can silently settle a potentially late apply");
        assert.equal(fixture.restores.length, 0);
        assert.equal(fixture.cleanups.length, 0);
        const requestId = fixture.applies[0]!.options.requestId;
        assert.ok(requestId, "assign a correlation ID before dispatch");
        assert.equal(fixture.envelope.requestId, requestId);
        assert.equal(fixture.envelope.data.unconfirmedApply?.requestId, requestId);
        assert.equal(fixture.envelope.data.unconfirmedApply?.outcomeUnknown, true);
        assert.equal(fixture.envelope.data.currentSha256, null);
        assert.deepEqual(fixture.envelope.data.retainedBackups, [], "do not advertise backup paths whose receipt was lost");
        assert.match(fixture.envelope.data.recoveryHint ?? "", /reconcile/i);
        assert.deepEqual(await readFile(fixture.sourcePath), fixture.appliedBytes);
        assert.deepEqual(await readFile(fixture.backups[0]!.backupPath), fixture.originalBytes);
        assert.deepEqual(await readFile(fixture.backups[0]!.backupMetaPath), fixture.originalMeta);
      });
    });
  }
});
