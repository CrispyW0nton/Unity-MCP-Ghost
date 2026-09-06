import { createHmac } from "node:crypto";

export const MAX_QUEUE_REQUEST_BYTES = 1024 * 1024;
export const MAX_QUEUE_ENVELOPE_BYTES = 6 * MAX_QUEUE_REQUEST_BYTES + 1024;
const QUEUE_PROOF_DOMAIN = "UnityMcpGhost.Queue.v2\0";

export class QueueRequestEnvelopeError extends Error {
  public constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "QueueRequestEnvelopeError";
  }
}

/** Sign exact inner JSON text. Never reconstruct parameters independently at the receiver. */
export function encodeQueueRequest(requestJson: string, token: string): string {
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new QueueRequestEnvelopeError("AUTHENTICATION_FAILED", "The durable queue signing token is missing or invalid.");
  }
  if (Buffer.byteLength(requestJson, "utf8") > MAX_QUEUE_REQUEST_BYTES) {
    throw new QueueRequestEnvelopeError("REQUEST_TOO_LARGE", "The durable queue request exceeds its UTF-8 byte limit.");
  }
  const requestBytes = Buffer.from(requestJson, "utf8");
  if (requestBytes.toString("utf8") !== requestJson) {
    throw new QueueRequestEnvelopeError("INVALID_UTF8", "The durable queue request contains invalid Unicode.");
  }
  const authProof = createHmac("sha256", token).update(QUEUE_PROOF_DOMAIN, "utf8").update(requestBytes).digest("hex");
  const envelope = JSON.stringify({ authProofVersion: 2, requestJson, authProof });
  if (Buffer.byteLength(envelope, "utf8") > MAX_QUEUE_ENVELOPE_BYTES) {
    throw new QueueRequestEnvelopeError("QUEUE_ENVELOPE_TOO_LARGE", "The durable queue envelope exceeds its UTF-8 byte limit.");
  }
  return envelope;
}
