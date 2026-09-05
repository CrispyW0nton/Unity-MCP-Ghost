import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMcpCli, type McpCliDependencies } from "../src/mcpCli.js";
import type { ScenarioJobManager } from "../src/scenario/ScenarioJobManager.js";
import type { StreamableHttpService } from "../src/transports/streamableHttp.js";
import type { UnityClient } from "../src/unity/UnityClient.js";

let directory: string;
let tokenFile: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "ghost-mcp-cli-"));
  tokenFile = join(directory, "token.txt");
  await writeFile(tokenFile, "a".repeat(64));
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("MCP executable lifecycle", () => {
  it("selects stdio by default through the real config parser", async () => {
    const fixture = makeFixture([]);
    assert.deepEqual(await runMcpCli(fixture.dependencies), { exitCode: 0, failureCodes: [] });
    assert.deepEqual(fixture.events, ["connect-stdio"]);
    assert.deepEqual(fixture.logs, []);
    assert.equal(fixture.signals.listenerCount("SIGINT"), 0);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`selects HTTP explicitly and drains in order on repeated ${signal}, preserving unrelated listeners`, async () => {
      const fixture = makeFixture();
      const handlers = deferred();
      const jobs = deferred();
      let unrelated = 0;
      const other = () => {
        unrelated++;
      };
      fixture.signals.on(signal, other);
      fixture.service.drain = async () => {
        fixture.events.push("drain-http");
        await handlers.promise;
      };
      fixture.manager.close = async () => {
        fixture.events.push("drain-jobs");
        await jobs.promise;
        return { outcomeUnknown: false };
      };
      const running = runMcpCli(fixture.dependencies);
      await fixture.ready.promise;
      fixture.signals.emit(signal);
      fixture.signals.emit(signal);
      await tick();
      assert.deepEqual(fixture.events, ["start-http", "close-http", "drain-http"]);
      handlers.resolve();
      await tick();
      assert.deepEqual(fixture.events, ["start-http", "close-http", "drain-http", "drain-jobs"]);
      fixture.signals.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
      await tick();
      assert.deepEqual(fixture.events, ["start-http", "close-http", "drain-http", "drain-jobs"]);
      jobs.resolve();
      assert.deepEqual(await running, { exitCode: 0, failureCodes: [] });
      assert.deepEqual(fixture.events, ["start-http", "close-http", "drain-http", "drain-jobs", "dispose"]);
      assert.equal(unrelated, 2);
      assert.deepEqual(fixture.signals.listeners(signal), [other]);
      assert.equal(fixture.signals.listenerCount(signal === "SIGINT" ? "SIGTERM" : "SIGINT"), 0);
    });
  }

  it("warns about detached mutations without claiming their outcome or cancelling them", async () => {
    const fixture = makeFixture();
    fixture.service.close = async () => ({ unfinishedRequests: 2, outcomeUnknown: true });
    const running = runMcpCli(fixture.dependencies);
    await fixture.ready.promise;
    fixture.signals.emit("SIGTERM");
    assert.equal((await running).exitCode, 0);
    assert.match(fixture.logs.join(""), /2 unfinished request\(s\).*reconcile durable operations/);
    assert.equal(fixture.events.filter((event) => event === "dispose").length, 1);
  });

  it("uses the same drain path for a fatal service failure and logs only a stable code", async () => {
    const fixture = makeFixture();
    const failure = new Error("Authorization: Bearer secret-token-value");
    const running = runMcpCli(fixture.dependencies);
    await fixture.ready.promise;
    fixture.fatal.resolve(failure);
    assert.deepEqual(await running, { exitCode: 1, failureCodes: ["MCP_HTTP_LISTENER_FAILED"] });
    assert.equal(fixture.signals.exitCode, 1);
    assert.deepEqual(fixture.events, ["start-http", "close-http", "drain-http", "drain-jobs", "dispose"]);
    assert.match(fixture.logs.join(""), /MCP_HTTP_LISTENER_FAILED/);
    assert.doesNotMatch(fixture.logs.join(""), /secret-token-value|Authorization/);
  });

  for (const broken of ["SIGINT", "SIGTERM", "start", "output"] as const) {
    it(`cleans up after ${broken} failure, including partial signal registration`, async () => {
      const fixture = makeFixture();
      const existing = () => {};
      fixture.signals.on("SIGINT", existing);
      if (broken === "SIGINT" || broken === "SIGTERM") {
        const on = fixture.signals.on.bind(fixture.signals);
        fixture.signals.on = (event, listener) => {
          on(event, listener);
          if (event === broken) throw new Error("secret registration error");
          return fixture.signals;
        };
      } else if (broken === "start") {
        fixture.dependencies.startHttp = async () => {
          throw new Error("secret startup error");
        };
      } else {
        fixture.dependencies.writeError = () => {
          throw new Error("secret output error");
        };
      }
      const result = await runMcpCli(fixture.dependencies);
      assert.equal(result.exitCode, 1);
      assert.equal(fixture.events.filter((event) => event === "dispose").length, 1);
      assert.ok(fixture.events.indexOf("drain-jobs") < fixture.events.indexOf("dispose"));
      if (broken === "output") assert.deepEqual(fixture.events, ["start-http", "close-http", "drain-http", "drain-jobs", "dispose"]);
      assert.deepEqual(fixture.signals.listeners("SIGINT"), [existing]);
      assert.equal(fixture.signals.listenerCount("SIGTERM"), 0);
      assert.doesNotMatch(fixture.logs.join(""), /secret/);
    });
  }

  for (const broken of ["close", "http-drain", "jobs-drain", "unknown-jobs", "dispose"] as const) {
    it(`reports ${broken} failure without abandoning the remaining drains`, async () => {
      const fixture = makeFixture();
      if (broken === "close")
        fixture.service.close = async () => {
          throw new Error("secret close error");
        };
      if (broken === "http-drain")
        fixture.service.drain = async () => {
          throw new Error("secret drain error");
        };
      if (broken === "jobs-drain")
        fixture.manager.close = async () => {
          throw new Error("secret jobs error");
        };
      if (broken === "unknown-jobs") fixture.manager.close = async () => ({ outcomeUnknown: true });
      if (broken === "dispose")
        fixture.unity.dispose = () => {
          fixture.events.push("dispose");
          throw new Error("secret dispose error");
        };
      const running = runMcpCli(fixture.dependencies);
      await fixture.ready.promise;
      fixture.signals.emit("SIGINT");
      assert.equal((await running).exitCode, 1);
      assert.equal(fixture.events.filter((event) => event === "dispose").length, broken === "http-drain" || broken === "jobs-drain" ? 0 : 1);
      if (broken === "http-drain" || broken === "close") assert.ok(fixture.events.includes("drain-jobs"));
      assert.doesNotMatch(fixture.logs.join(""), /secret/);
    });
  }

  it("honors a signal received while the HTTP listener is starting", async () => {
    const fixture = makeFixture();
    const starting = deferred();
    const finishStartup = deferred();
    fixture.dependencies.startHttp = async () => {
      starting.resolve();
      await finishStartup.promise;
      return fixture.service;
    };
    const running = runMcpCli(fixture.dependencies);
    await starting.promise;
    fixture.signals.emit("SIGINT");
    finishStartup.resolve();
    assert.equal((await running).exitCode, 0);
    assert.deepEqual(fixture.events, ["close-http", "drain-http", "drain-jobs", "dispose"]);
  });

  it("disposes the client after a stdio connection failure", async () => {
    const fixture = makeFixture([]);
    fixture.dependencies.createServer = () =>
      ({
        connect: async () => {
          throw new Error("secret stdio error");
        },
        close: async () => {
          fixture.events.push("close-stdio");
        }
      }) as unknown as McpServer;
    assert.equal((await runMcpCli(fixture.dependencies)).exitCode, 1);
    assert.deepEqual(fixture.events, ["close-stdio", "dispose"]);
  });

  it("awaits asynchronous output failure and completes cleanup without an unhandled rejection", async () => {
    const fixture = makeFixture();
    fixture.dependencies.writeError = async () => {
      fixture.ready.resolve();
      throw new Error("secret asynchronous output failure");
    };
    const running = runMcpCli(fixture.dependencies);
    await fixture.ready.promise;
    fixture.signals.emit("SIGINT");
    assert.deepEqual(await running, { exitCode: 1, failureCodes: ["MCP_CLI_OUTPUT_FAILED"] });
    assert.deepEqual(fixture.events, ["start-http", "close-http", "drain-http", "drain-jobs", "dispose"]);
  });

  it("continues draining when writing the unknown-work warning fails", async () => {
    const fixture = makeFixture();
    const write = fixture.dependencies.writeError!;
    fixture.dependencies.writeError = (message) => {
      if (message.includes("unfinished")) throw new Error("warning output failed");
      return write(message);
    };
    fixture.service.close = async () => ({ unfinishedRequests: 1, outcomeUnknown: true });
    const running = runMcpCli(fixture.dependencies);
    await fixture.ready.promise;
    fixture.signals.emit("SIGTERM");
    assert.deepEqual(await running, { exitCode: 1, failureCodes: ["MCP_CLI_OUTPUT_FAILED"] });
    assert.deepEqual(fixture.events, ["start-http", "drain-http", "drain-jobs", "dispose"]);
  });

  it("attempts both signal removals when one removal fails", async () => {
    const fixture = makeFixture();
    const remove = fixture.signals.removeListener.bind(fixture.signals);
    fixture.signals.removeListener = (name, listener) => {
      remove(name, listener);
      if (name === "SIGINT") throw new Error("signal cleanup failure");
      return fixture.signals;
    };
    const running = runMcpCli(fixture.dependencies);
    await fixture.ready.promise;
    fixture.signals.emit("SIGTERM");
    assert.deepEqual(await running, { exitCode: 1, failureCodes: ["MCP_CLI_SIGNAL_CLEANUP_FAILED"] });
    assert.equal(fixture.signals.listenerCount("SIGINT") + fixture.signals.listenerCount("SIGTERM"), 0);
  });
});

function makeFixture(transportArgs = ["--transport", "streamable-http"]) {
  const signals = new EventEmitter() as EventEmitter & { argv: string[]; exitCode?: number | string };
  signals.argv = [
    "node",
    "index.ts",
    ...transportArgs,
    "--unity-project-id",
    "unity-project-aaaaaaaaaaaaaaaaaaaaaaaa",
    "--unity-editor-id",
    "editor-cli",
    "--unity-token-file",
    tokenFile
  ];
  const events: string[] = [];
  const logs: string[] = [];
  const ready = deferred();
  const fatal = deferred<unknown>();
  const unity = {
    dispose: () => {
      events.push("dispose");
    }
  } as unknown as UnityClient;
  const manager = {
    close: async () => {
      events.push("drain-jobs");
      return { outcomeUnknown: false };
    }
  } as unknown as ScenarioJobManager;
  const service: StreamableHttpService = {
    url: "http://127.0.0.1:8080/mcp",
    stats: () => ({ connections: 0, activeRequests: 0, closing: false }),
    close: async () => {
      events.push("close-http");
      return { unfinishedRequests: 0, outcomeUnknown: false };
    },
    drain: async () => {
      events.push("drain-http");
    },
    fatalError: fatal.promise
  };
  const transport = {} as Transport;
  const dependencies: McpCliDependencies = {
    process: signals,
    createUnity: () => unity,
    createScenarios: () => manager,
    createStdioTransport: () => transport,
    createServer: () =>
      ({
        connect: async (received: Transport) => {
          assert.equal(received, transport);
          events.push("connect-stdio");
        }
      }) as unknown as McpServer,
    startHttp: async (options) => {
      assert.equal(options.projectId, "unity-project-aaaaaaaaaaaaaaaaaaaaaaaa");
      assert.equal(options.editorInstanceId, "editor-cli");
      assert.equal(options.tokenFile, tokenFile);
      events.push("start-http");
      return service;
    },
    writeError: (message) => {
      logs.push(message);
      if (message.includes("listening at")) ready.resolve();
    }
  };
  return { dependencies, signals, unity, manager, service, events, logs, ready, fatal };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
