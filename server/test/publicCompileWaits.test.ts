import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/mcp/createServer.js";
import { UnityCommandError, UnityRequestTimeoutError, type UnityClient, type UnityRequestOptions } from "../src/unity/UnityClient.js";
import { compileDiagnostic, compileState } from "./fixtures/compileEvidence.js";

type Obj = Record<string, unknown>;
type Request = { method: string; params: Obj; options: UnityRequestOptions };
const stamp = "2026-09-06T12:00:00.000Z";
const diagnostic = (generation = 7, file = "Assets/Fixture.cs") => ({
  ...compileDiagnostic(generation, { file, message: "; expected", column: 2 }),
  timestampUtc: stamp
});
// Deliberately match CompileDiagnosticBuffer.WaitState: the producer has generation,
// not requestedCompileGeneration. These are controlled bridge receipts, not live Unity proof.
const completed = (errors: Obj[] = []): Obj => ({
  ...compileState(7, errors.length ? "failed" : "success", errors),
  requestedAtUtc: stamp,
  observedAtUtc: stamp,
  completedAtUtc: stamp,
  sourcePath: "Assets/Fixture.cs",
  ...(errors.length ? { error: { code: "COMPILE_GENERATION_FAILED", message: "Compilation failed." } } : {})
});
const diagnosticResult = (diagnostics: Obj[] = []): Obj => ({ ok: true, source: "compilation-pipeline", generation: 7, diagnostics, truncated: false });
const start = (): Obj => ({ ok: true, path: "Assets/Fixture.cs", requestedCompileGeneration: 7 });
const normal = (request: Request): Obj =>
  request.method === "script.validate" ? start() : request.method === "compile.status_get" ? completed() : diagnosticResult();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function envelope(result: CallToolResult): Obj {
  return result.structuredContent as Obj;
}
function failure(result: CallToolResult, code?: string): Obj {
  assert.equal(result.isError, true);
  const value = envelope(result);
  assert.equal(value.ok, false);
  assert.equal(value.confidence, 0);
  if (code) assert.equal((value.error as Obj).code, code);
  return value;
}

async function fixture(t: TestContext, producer: (request: Request) => unknown | Promise<unknown>) {
  const requests: Request[] = [];
  const responses: JSONRPCMessage[] = [];
  const handled = deferred<CallToolResult>();
  const unity = {
    request: async (method: string, params: Obj, options: UnityRequestOptions = {}) => {
      const request = { method, params, options };
      requests.push(request);
      return producer(request);
    }
  } as unknown as UnityClient;
  const server = createMcpServer({ unity, projectId: "fixture-project" });
  const client = new Client({ name: "public-compile-waits", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const send = st.send.bind(st);
  st.send = async (message, options) => {
    responses.push(message);
    await send(message, options);
  };
  // Observe the actual tools/call handler's output before the SDK suppresses a
  // cancelled request's transport response. Calls still enter through the SDK.
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, (...args: unknown[]) => Promise<CallToolResult>> })._requestHandlers;
  const original = handlers.get("tools/call")!;
  handlers.set("tools/call", async (...args) => {
    const result = await original(...args);
    handled.resolve(result);
    return result;
  });
  await Promise.all([client.connect(ct), server.connect(st)]);
  responses.length = 0;
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return {
    requests,
    responses,
    handled,
    call: (name = "script_validate", args: Obj = {}, signal?: AbortSignal) =>
      client.callTool(
        {
          name,
          arguments: { ...(name === "script_validate" ? { path: "Assets/Fixture.cs" } : { requestedCompileGeneration: 7 }), timeoutMs: 2000, ...args }
        },
        undefined,
        { signal }
      ) as Promise<CallToolResult>
  };
}

describe("public exact-generation compile waits", () => {
  it("accepts producer generation without inventing evidence and forwards bounded options", async (t) => {
    const f = await fixture(t, normal);
    const result = await f.call("compile_wait");
    assert.equal(envelope(result).ok, true);
    assert.equal((envelope(result).data as Obj).requestedCompileGeneration, 7);
    assert.equal((envelope(result).data as Obj).generation, 7);
    assert.ok(f.requests[0].options.signal instanceof AbortSignal);
    assert.ok(Number(f.requests[0].options.timeoutMs) > 0 && Number(f.requests[0].options.timeoutMs) <= 2000);
  });

  const invalidStates: Array<[string, Obj]> = [
    ["wrong generation", { generation: 8 }],
    ["wrong requested token", { requestedCompileGeneration: 8 }],
    ["missing generation", { generation: undefined }],
    ["missing ok", { ok: undefined }],
    ["unobserved", { observed: false }],
    ["missing completed timestamp", { completedAtUtc: null }],
    ["invalid completed timestamp", { completedAtUtc: "invalid" }],
    ["missing observed timestamp", { observedAtUtc: null }],
    ["invalid requested timestamp", { requestedAtUtc: "invalid" }],
    ["observation before request", { observedAtUtc: "2026-09-05T12:00:00Z" }],
    ["completion before observation", { completedAtUtc: "2026-09-05T12:00:00Z" }],
    ["missing diagnostics", { diagnostics: undefined }],
    ["truncated diagnostics", { diagnosticsTruncated: true }],
    ["missing error count", { errorCount: undefined }],
    ["errors in successful result", { errorCount: 1, diagnostics: [diagnostic()] }],
    ["historical diagnostic", { diagnostics: [{ ...diagnostic(6), severity: "warning" }] }],
    ["malformed diagnostic", { diagnostics: [{ generation: 7, severity: "warning" }] }]
  ];
  for (const [label, patch] of invalidStates) {
    it(`rejects terminal compile evidence: ${label}`, async (t) => {
      const f = await fixture(t, () => ({ ...completed(), ...patch }));
      const value = failure(await f.call("compile_wait"));
      assert.match(String((value.error as Obj).code), /COMPILE_(GENERATION_MISMATCH|EVIDENCE_INVALID)/);
      assert.equal(f.requests.length, 1);
      if (patch.generation === 8) assert.equal(((value.data as Obj).observed as Obj).generation, 8);
    });
  }
  it("rejects duplicate diagnostic sequences in otherwise coherent terminal evidence", async (t) => {
    const f = await fixture(t, () => completed([diagnostic(), diagnostic()]));
    failure(await f.call("compile_wait"), "COMPILE_EVIDENCE_INVALID");
    assert.equal(f.requests.length, 1);
  });
  for (const count of [1000, 1001]) {
    it(`enforces the terminal status diagnostic cap at ${count} entries`, async (t) => {
      const diagnostics = Array.from({ length: count }, (_, index) => ({ ...diagnostic(), severity: "warning", sequence: index + 1 }));
      const f = await fixture(t, () => ({ ...completed(), diagnostics }));
      const result = await f.call("compile_wait");
      if (count === 1000) {
        assert.equal(envelope(result).ok, true);
        assert.deepEqual((envelope(result).data as Obj).diagnostics, diagnostics);
      } else {
        failure(result, "COMPILE_EVIDENCE_INVALID");
      }
      assert.equal(f.requests.length, 1);
    });
  }
  for (const tool of ["compile_wait", "script_validate"]) {
    for (const status of ["success", "failed"]) {
      it(`rejects unknown terminal compile outcomes through ${tool}: ${status}`, async (t) => {
        const receipt = { ...completed(status === "failed" ? [diagnostic()] : []), outcomeUnknown: true };
        const f = await fixture(t, (r) => {
          if (r.method === "compile.status_get") return receipt;
          if (r.method === "compile.diagnostics_get") return diagnosticResult(status === "failed" ? [diagnostic()] : []);
          return normal(r);
        });
        const value = failure(await f.call(tool), "COMPILE_EVIDENCE_INVALID");
        assert.deepEqual((value.data as Obj).observed, receipt);
        assert.deepEqual(
          f.requests.map((r) => r.method),
          tool === "compile_wait" ? ["compile.status_get"] : ["script.validate", "compile.status_get"]
        );
      });
    }
  }
  it("preserves unknown generation as a typed producer failure", async (t) => {
    const payload = {
      ok: false,
      status: "failed",
      generation: 7,
      observed: false,
      error: { code: "UNKNOWN_COMPILE_GENERATION", message: "No record." },
      requestId: "status-request",
      projectId: "project"
    };
    const f = await fixture(t, () => payload);
    const value = failure(await f.call("compile_wait"), "UNKNOWN_COMPILE_GENERATION");
    assert.equal(value.requestId, "status-request");
    assert.equal(value.projectId, "project");
    assert.deepEqual(value.data, payload);
  });
  for (const patch of [{ observed: false }, { completedAtUtc: null }, { errorCount: 0, diagnostics: [] }]) {
    it(`rejects an unproved failed compile ${JSON.stringify(patch)}`, async (t) => {
      const f = await fixture(t, () => ({ ...completed([diagnostic()]), ...patch }));
      failure(await f.call("compile_wait"), "COMPILE_EVIDENCE_INVALID");
    });
  }
  for (const code of ["UNITY_BRIDGE_AUTHENTICATION_FAILED", "PROJECT_ID_MISMATCH", "UNITY_CLIENT_DISPOSED"]) {
    it(`does not retry a terminal read error: ${code}`, async (t) => {
      const error = new UnityCommandError("Terminal failure", -32000, { code, details: "preserved" }, "read-id");
      const f = await fixture(t, () => {
        throw error;
      });
      const value = failure(await f.call("compile_wait", { timeoutMs: 10 }), code);
      assert.equal(value.requestId, "read-id");
      assert.deepEqual((value.error as Obj).data, { code, details: "preserved" });
      assert.equal(f.requests.length, 1);
    });
  }
  it("does not retry arbitrary transport exceptions", async (t) => {
    const f = await fixture(t, () => {
      throw new Error("unclassified transport failure");
    });
    failure(await f.call("compile_wait", { timeoutMs: 10 }), "UNITY_REQUEST_FAILED");
    assert.equal(f.requests.length, 1);
  });
  it("waits for observed completion after a not-yet-started generation", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const entered = deferred<void>();
    let reads = 0;
    const f = await fixture(t, () => {
      if (++reads === 1) {
        entered.resolve();
        return { ...completed(), status: "waiting", observed: false, observedAtUtc: null, completedAtUtc: null };
      }
      return completed();
    });
    const pending = f.call("compile_wait");
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 1);
    assert.equal(f.responses.length, 0);
    t.mock.timers.tick(250);
    assert.equal(envelope(await pending).ok, true);
    assert.equal(reads, 2);
  });
  it("retries a proven transient read timeout within the same deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const entered = deferred<void>();
    let reads = 0;
    const f = await fixture(t, () => {
      if (++reads === 1) {
        entered.resolve();
        throw new UnityRequestTimeoutError("read expired", "read-id", false, "UNITY_REQUEST_TIMEOUT");
      }
      return completed();
    });
    const pending = f.call("compile_wait");
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1000);
    assert.equal(envelope(await pending).ok, true);
    assert.equal(reads, 2);
  });
  const transientReads: Obj[] = [
    { code: "EXECUTING" },
    { code: "OUTCOME_UNKNOWN" },
    { code: "REQUEST_EXECUTION_IN_PROGRESS" },
    { code: "EXPIRED", status: "expired", outcomeUnknown: false }
  ];
  for (const data of transientReads) {
    it(`retries a typed transient read: ${data.code}`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const entered = deferred<void>();
      let reads = 0;
      const f = await fixture(t, () => {
        if (++reads === 1) {
          entered.resolve();
          throw new UnityCommandError("Read is transiently unavailable.", -32004, data, "transient-read-id");
        }
        return completed();
      });
      const pending = f.call("compile_wait");
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(reads, 1);
      assert.equal(f.responses.length, 0);
      t.mock.timers.tick(1000);
      assert.equal(envelope(await pending).ok, true);
      assert.equal(reads, 2);
      assert.ok(f.requests.every((r) => r.method === "compile.status_get" && r.params.requestedCompileGeneration === 7));
    });
  }
  for (const [label, patch] of [
    ["wrong status", { status: "executing" }],
    ["unknown execution", { outcomeUnknown: true }]
  ] as const) {
    it(`does not retry an EXPIRED read with ${label}`, async (t) => {
      const data = { code: "EXPIRED", status: "expired", outcomeUnknown: false, ...patch };
      const f = await fixture(t, () => {
        throw new UnityCommandError("Read expiration is not known to be unexecuted.", -32004, data, "expired-read-id");
      });
      const value = failure(await f.call("compile_wait"), "EXPIRED");
      assert.equal(value.requestId, "expired-read-id");
      assert.deepEqual((value.error as Obj).data, data);
      assert.equal(f.requests.length, 1);
    });
  }
});

describe("public script validation", () => {
  const invalidStarts: Array<[string, Obj, string]> = [
    ["soft failure", { ok: false, error: { code: "VALIDATION_REJECTED", message: "Rejected." } }, "VALIDATION_REJECTED"],
    ["missing ok", { ok: undefined }, "SCRIPT_VALIDATE_FAILED"],
    ["contradictory error", { error: { code: "START_REJECTED", message: "Rejected despite ok." } }, "START_REJECTED"],
    ["unknown outcome", { outcomeUnknown: true }, "OUTCOME_UNKNOWN"],
    ["missing generation", { requestedCompileGeneration: undefined }, "MISSING_COMPILE_GENERATION"],
    ["fractional generation", { requestedCompileGeneration: 7.5 }, "MISSING_COMPILE_GENERATION"],
    ["mismatched generation", { requestedCompileGeneration: 8 }, "COMPILE_GENERATION_MISMATCH"]
  ];
  for (const [label, patch, code] of invalidStarts) {
    it(`does no follow-up work after invalid start: ${label}`, async (t) => {
      const f = await fixture(t, (r) => (r.method === "script.validate" ? { ...start(), ...patch, requestId: "start-id", projectId: "project" } : normal(r)));
      const value = failure(await f.call("script_validate", { requestedCompileGeneration: 7 }), code);
      assert.equal(value.requestId, "start-id");
      assert.equal(value.projectId, "project");
      assert.deepEqual(
        f.requests.map((r) => r.method),
        ["script.validate"]
      );
    });
  }
  it("preserves a lost start receipt and never starts validation twice", async (t) => {
    const f = await fixture(t, () => {
      throw new UnityRequestTimeoutError("start may have run", "start-id", true);
    });
    const value = failure(await f.call(), "UNITY_REQUEST_TIMEOUT_OUTCOME_UNKNOWN");
    assert.equal(value.requestId, "start-id");
    assert.equal((value.data as Obj).outcomeUnknown, true);
    assert.equal(f.requests.length, 1);
  });
  for (const [rpcCode, data] of [
    [-32010, { code: "PROJECT_ID_MISMATCH", outcomeUnknown: false }],
    [-32010, { code: "EDITOR_INSTANCE_ID_REQUIRED", outcomeUnknown: false }],
    [-32012, { code: "PATH_OUTSIDE_ASSETS", outcomeUnknown: false }],
    [-32004, { code: "EXPIRED", status: "expired", outcomeUnknown: false }]
  ] as const) {
    it(`preserves a typed known-unexecuted validation start: ${data.code}`, async (t) => {
      const f = await fixture(t, () => {
        throw new UnityCommandError("Request rejected before execution.", rpcCode, data, "rejected-start-id");
      });
      const value = failure(await f.call(), data.code);
      assert.equal(value.requestId, "rejected-start-id");
      assert.equal((value.data as Obj).outcomeUnknown, false);
      assert.deepEqual((value.error as Obj).data, data);
      assert.doesNotMatch(String(value.warnings), /Reconcile the dispatched request/);
      assert.equal(f.requests.length, 1);
    });
  }
  it("keeps unclassified start exceptions conservative despite untrusted non-execution flags", async (t) => {
    const f = await fixture(t, () => {
      throw Object.assign(new Error("Unclassified start failure."), { data: { outcomeUnknown: false } });
    });
    const value = failure(await f.call(), "UNITY_REQUEST_FAILED");
    assert.equal((value.data as Obj).outcomeUnknown, true);
    assert.match(String(value.warnings), /Reconcile the dispatched request/);
    assert.equal(f.requests.length, 1);
  });
  it("retains dry-run behavior without polling or diagnostics", async (t) => {
    const f = await fixture(t, () => ({ ok: true, dryRun: true, planned: { path: "Assets/Fixture.cs" } }));
    assert.equal(envelope(await f.call("script_validate", { dryRun: true })).ok, true);
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ["script.validate"]
    );
  });
  it("rejects a contradictory soft compile response without diagnostics", async (t) => {
    const f = await fixture(t, (r) =>
      r.method === "compile.status_get" ? { ...completed(), ok: false, error: { code: "STATUS_REJECTED", message: "Rejected." } } : normal(r)
    );
    failure(await f.call(), "STATUS_REJECTED");
    assert.equal(f.requests.length, 2);
  });
  it("returns clean evidence after older errors without consulting history", async (t) => {
    const f = await fixture(t, (r) => {
      if (r.method === "compile.diagnostics_get") {
        assert.deepEqual(r.params, { severity: "error", pathFilter: "Assets/Fixture.cs", generation: 7, limit: 100 });
        return diagnosticResult();
      }
      return normal(r);
    });
    const value = envelope(await f.call());
    assert.equal(value.ok, true);
    assert.equal((value.data as Obj).scopedErrorCount, 0);
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ["script.validate", "compile.status_get", "compile.diagnostics_get"]
    );
  });
  it("reports whole-generation errors when the requested file has none", async (t) => {
    const f = await fixture(t, (r) => (r.method === "compile.status_get" ? completed([diagnostic(7, "Assets/Other.cs")]) : normal(r)));
    const value = failure(await f.call(), "SCRIPT_COMPILER_ERRORS");
    assert.equal((value.data as Obj).compilerErrorCount, 1);
    assert.equal((value.data as Obj).scopedErrorCount, 0);
    assert.match(String((value.error as Obj).message), /1.*0/);
  });
  const invalidDiagnostics: Array<[string, Obj]> = [
    ["missing ok", { ok: undefined }],
    ["soft failure", { ok: false, error: { code: "DIAGNOSTICS_UNAVAILABLE", message: "Rejected." } }],
    ["contradictory error", { error: { code: "DIAGNOSTICS_UNAVAILABLE", message: "Read failed despite ok." } }],
    ["missing generation", { generation: undefined }],
    ["wrong generation", { generation: 6 }],
    ["missing array", { diagnostics: undefined }],
    ["missing truncation", { truncated: undefined }],
    ["truncated", { truncated: true }],
    ["malformed entry", { diagnostics: [null] }],
    ["historical entry", { diagnostics: [diagnostic(6)] }],
    ["wrong severity", { diagnostics: [{ ...diagnostic(), severity: "warning" }] }],
    ["wrong file", { diagnostics: [diagnostic(7, "Assets/Other.cs")] }],
    ["inconsistent error count", { diagnostics: [diagnostic()] }],
    ["exceeded requested limit", { diagnostics: [diagnostic(), { ...diagnostic(), sequence: 2 }] }]
  ];
  for (const [label, patch] of invalidDiagnostics) {
    it(`never certifies malformed diagnostics: ${label}`, async (t) => {
      const f = await fixture(t, (r) => (r.method === "compile.diagnostics_get" ? { ...diagnosticResult(), ...patch } : normal(r)));
      failure(
        await f.call("script_validate", { limit: 1 }),
        label === "soft failure" || label === "contradictory error" ? "DIAGNOSTICS_UNAVAILABLE" : "COMPILE_DIAGNOSTICS_INVALID"
      );
      assert.equal(f.requests.length, 3);
    });
  }
  it("requires scoped diagnostics to contain all matching terminal errors", async (t) => {
    const f = await fixture(t, (r) => (r.method === "compile.status_get" ? completed([diagnostic()]) : normal(r)));
    failure(await f.call(), "COMPILE_DIAGNOSTICS_INVALID");
  });
  it("rejects duplicate scoped diagnostic sequences despite a matching count", async (t) => {
    const first = diagnostic();
    const second = { ...diagnostic(), sequence: 2 };
    const f = await fixture(t, (r) => {
      if (r.method === "compile.status_get") return completed([first, second]);
      if (r.method === "compile.diagnostics_get") return diagnosticResult([first, first]);
      return normal(r);
    });
    failure(await f.call(), "COMPILE_DIAGNOSTICS_INVALID");
    assert.equal(f.requests.length, 3);
  });
  for (const phase of ["script.validate", "compile.status_get", "compile.diagnostics_get"]) {
    it(`rejects a response at the total monotonic deadline: ${phase}`, async (t) => {
      let now = 100;
      t.mock.method(performance, "now", () => now);
      const f = await fixture(t, (r) => {
        if (r.method === phase) now += 2000;
        return normal(r);
      });
      failure(await f.call(), "COMPILE_GENERATION_TIMEOUT");
      assert.equal(f.requests.at(-1)?.method, phase);
      assert.ok(f.requests.every((r) => Number(r.options.timeoutMs) > 0 && Number(r.options.timeoutMs) <= 2000));
    });
    it(`forwards SDK cancellation to producer and rejects late work: ${phase}`, async (t) => {
      const entered = deferred<void>();
      const late = deferred<Obj>();
      const f = await fixture(t, (r) => {
        if (r.method === phase) {
          entered.resolve();
          return late.promise;
        }
        return normal(r);
      });
      const controller = new AbortController();
      const pending = f.call("script_validate", {}, controller.signal).catch((error: unknown) => error);
      await entered.promise;
      const request = f.requests.at(-1)!;
      let settled: CallToolResult | undefined;
      void f.handled.promise.then((result) => {
        settled = result;
      });
      controller.abort(new Error("SDK caller cancelled"));
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.ok(request.options.signal instanceof AbortSignal, "the producer must receive the real handler cancellation");
        assert.equal(request.options.signal.aborted, true);
        assert.ok(settled, "the public handler must settle even while the producer ignores abort");
        failure(settled, "OPERATION_CANCELLED");
      } finally {
        late.resolve(normal(request));
      }
      await pending;
      const result = await f.handled.promise;
      failure(result, "OPERATION_CANCELLED");
      assert.equal(f.requests.at(-1)?.method, phase);
      assert.equal(f.responses.filter((r) => "result" in r).length, 0, "SDK suppresses cancelled responses; handler evidence above must also fail");
    });
  }
  it("subtracts start and status time from the final diagnostics request budget", async (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    const f = await fixture(t, (r) => {
      now += 600;
      return normal(r);
    });
    assert.equal(envelope(await f.call()).ok, true);
    assert.deepEqual(
      f.requests.map((r) => r.options.timeoutMs),
      [2000, 1400, 800]
    );
  });
  for (const phase of ["script.validate", "compile.status_get", "compile.diagnostics_get"]) {
    it(`actively ends a hung producer before releasing its response: ${phase}`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let now = 0;
      t.mock.method(performance, "now", () => now);
      const entered = deferred<void>();
      const late = deferred<Obj>();
      const f = await fixture(t, (r) => {
        if (r.method === phase) {
          entered.resolve();
          return late.promise;
        }
        return normal(r);
      });
      const pending = f.call();
      await entered.promise;
      let settled: CallToolResult | undefined;
      void f.handled.promise.then((result) => {
        settled = result;
      });
      now = 2000;
      t.mock.timers.tick(2000);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.ok(settled, "handler must settle before the hung producer is released");
        failure(settled, "COMPILE_GENERATION_TIMEOUT");
      } finally {
        late.resolve(normal(f.requests.at(-1)!));
      }
      const value = failure(await pending, "COMPILE_GENERATION_TIMEOUT");
      if (phase === "script.validate") {
        assert.equal((value.data as Obj).outcomeUnknown, true);
        assert.equal(value.requestId, f.requests[0].options.requestId);
      }
      assert.ok(f.requests[0].options.signal?.aborted);
      assert.equal(f.requests.at(-1)?.method, phase);
    });
  }
  it("cancels public compile_wait during an unresolved status read", async (t) => {
    const entered = deferred<void>();
    const late = deferred<Obj>();
    const f = await fixture(t, () => {
      entered.resolve();
      return late.promise;
    });
    const controller = new AbortController();
    const pending = f.call("compile_wait", {}, controller.signal).catch((error: unknown) => error);
    await entered.promise;
    let settled: CallToolResult | undefined;
    void f.handled.promise.then((result) => {
      settled = result;
    });
    controller.abort();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(f.requests[0].options.signal?.aborted);
      assert.ok(settled);
      failure(settled, "OPERATION_CANCELLED");
    } finally {
      late.resolve(completed());
    }
    await pending;
    assert.equal(f.requests.length, 1);
  });
  it("cancels during polling sleep without another status request", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const entered = deferred<void>();
    const f = await fixture(t, () => {
      entered.resolve();
      return { ...completed(), status: "waiting", observed: false, observedAtUtc: null, completedAtUtc: null };
    });
    const controller = new AbortController();
    const pending = f.call("compile_wait", {}, controller.signal).catch((error: unknown) => error);
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    failure(await f.handled.promise, "OPERATION_CANCELLED");
    t.mock.timers.tick(2000);
    await pending;
    assert.equal(f.requests.length, 1);
  });
});
