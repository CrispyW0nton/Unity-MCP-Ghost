import assert from "node:assert/strict";
import test from "node:test";
import {
  BridgeStartupError,
  isExpectedEndpointConflict,
  type BridgeStartupFailure,
  type BridgeStartupIdentity,
  type BridgeTransport
} from "../src/testing/bridgeStartupEvidence.js";

function identity(transport: BridgeTransport, overrides: Partial<BridgeStartupFailure> = {}): BridgeStartupIdentity {
  return {
    running: false,
    port: 6501,
    webSocketPort: 16501,
    startupFailure: {
      code: "BRIDGE_ENDPOINT_CONFLICT",
      stage: "bind",
      transport,
      port: transport === "http" ? 6501 : 16501,
      exceptionType: "System.Net.Sockets.SocketException",
      nativeErrorCode: 10048,
      socketErrorCode: "AddressAlreadyInUse",
      ...overrides
    }
  };
}

test("a WebSocket collision rejects a loser whose distinct HTTP endpoint was occupied", () => {
  const error = new BridgeStartupError(identity("http"), "project-b");
  assert.equal(isExpectedEndpointConflict(error, "websocket", 16501), false);
});

test("running=false without a bind receipt is a generic startup failure", () => {
  const error = new BridgeStartupError({ running: false, port: 6501, webSocketPort: 16501 }, "project-b");
  assert.equal(error.code, "BRIDGE_STARTUP_FAILED");
  assert.equal(isExpectedEndpointConflict(error, "http", 6501), false);
});

test("generic and non-bind errors cannot claim an endpoint conflict", () => {
  for (const failure of [
    { code: "BRIDGE_STARTUP_FAILED" },
    { stage: "initialize" },
    { exceptionType: "System.InvalidOperationException", nativeErrorCode: null, socketErrorCode: null },
    { nativeErrorCode: 10013, socketErrorCode: "AccessDenied" },
    { exceptionType: "System.Net.HttpListenerException", nativeErrorCode: 5, socketErrorCode: null },
    { transport: "websocket" as const, port: 16501, exceptionType: "System.Net.HttpListenerException", nativeErrorCode: 183, socketErrorCode: null }
  ]) {
    const error = new BridgeStartupError(identity("http", failure), "project-b");
    assert.equal(error.code, "BRIDGE_STARTUP_FAILED");
    assert.equal(isExpectedEndpointConflict(error, "http", 6501), false);
  }
});

test("bind receipt must match both the configured port and the phase port", () => {
  for (const port of [0, 6502, 16501, null]) {
    const error = new BridgeStartupError(identity("http", { port }), "project-b");
    assert.equal(isExpectedEndpointConflict(error, "http", 6501), false);
  }
  const error = new BridgeStartupError(identity("http"), "project-b");
  assert.equal(isExpectedEndpointConflict(error, "http", 6502), false);
});

test("exact HTTP and WebSocket address-in-use receipts certify only their intended phase", () => {
  for (const transport of ["http", "websocket"] as const) {
    const failedIdentity = identity(transport);
    const error = new BridgeStartupError(failedIdentity, "project-b");
    assert.equal(error.code, "BRIDGE_ENDPOINT_CONFLICT");
    assert.equal(isExpectedEndpointConflict(error, transport, failedIdentity.startupFailure!.port!), true);
  }
  const httpUrlConflict = new BridgeStartupError(
    identity("http", { exceptionType: "System.Net.HttpListenerException", nativeErrorCode: 183, socketErrorCode: null }),
    "project-b"
  );
  assert.equal(isExpectedEndpointConflict(httpUrlConflict, "http", 6501), true);
});

test("running identities and unrelated errors cannot certify a collision", () => {
  const error = new BridgeStartupError({ ...identity("http"), running: true }, "project-b");
  assert.equal(isExpectedEndpointConflict(error, "http", 6501), false);
  assert.equal(isExpectedEndpointConflict(new Error("Address already in use"), "http", 6501), false);
});
