import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failureResponse, successResponse } from "../src/mcp/toolResponse.js";
import { UnityRequestTimeoutError } from "../src/unity/UnityClient.js";

function structured(result: ReturnType<typeof successResponse>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("tool response envelope", () => {
  it("adds correlation fields to successful responses", () => {
    const result = successResponse(
      "completed",
      {
        ok: true,
        projectId: "project-1",
        operationId: "operation-1"
      },
      Date.now()
    );

    assert.equal(result.isError, undefined);
    assert.equal(structured(result).ok, true);
    assert.equal(structured(result).error, null);
    assert.equal(structured(result).projectId, "project-1");
    assert.equal(structured(result).operationId, "operation-1");
    assert.equal(typeof structured(result).requestId, "string");
    assert.deepEqual(structured(result).warnings, []);
  });

  it("promotes a bridge ok:false payload to an MCP error", () => {
    const result = successResponse(
      "completed",
      {
        ok: false,
        error: {
          code: "SCENE_SAVE_FAILED",
          message: "Scene could not be saved."
        }
      },
      Date.now()
    );

    assert.equal(result.isError, true);
    assert.equal(structured(result).ok, false);
    assert.deepEqual(structured(result).error, {
      code: "SCENE_SAVE_FAILED",
      message: "Scene could not be saved."
    });
  });

  it("promotes failed nested operations and nonzero failed tests", () => {
    const failedOperation = successResponse(
      "operation read",
      {
        ok: true,
        state: {
          status: "failed",
          error: "Compilation failed."
        }
      },
      Date.now()
    );
    const failedTests = successResponse(
      "tests completed",
      {
        ok: true,
        state: {
          status: "success",
          failed: 2
        }
      },
      Date.now()
    );

    assert.equal(failedOperation.isError, true);
    assert.equal((structured(failedOperation).error as { code: string }).code, "UNITY_OPERATION_FAILED");
    assert.equal(failedTests.isError, true);
    assert.equal((structured(failedTests).error as { code: string }).code, "UNITY_TESTS_FAILED");
  });

  it("uses stable error fields for thrown failures", () => {
    const result = failureResponse("request failed", new Error("socket closed"), Date.now(), [], {
      code: "UNITY_CONNECTION_CLOSED",
      requestId: "request-1",
      projectId: "project-1"
    });

    assert.equal(result.isError, true);
    assert.equal(structured(result).requestId, "request-1");
    assert.equal(structured(result).projectId, "project-1");
    assert.deepEqual(structured(result).error, {
      code: "UNITY_CONNECTION_CLOSED",
      message: "socket closed"
    });
  });

  it("preserves the request id and warns when a timed-out mutation has an unknown outcome", () => {
    const result = failureResponse(
      "request failed",
      new UnityRequestTimeoutError("timed out", "mutation-1", true),
      Date.now()
    );

    assert.equal(structured(result).requestId, "mutation-1");
    assert.equal((structured(result).error as { code: string }).code, "UNITY_REQUEST_TIMEOUT_OUTCOME_UNKNOWN");
    assert.equal((structured(result).warnings as string[]).length, 1);
  });
});
