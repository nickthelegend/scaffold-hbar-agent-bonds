import { keccak256, toBytes, type Address, type Hex } from "viem";

/** HCS caps a single (unchunked) message at 1024 bytes; larger ones are split and can't be re-hashed as one. */
export const MAX_MESSAGE_BYTES = 1024;

/** What an agent publishes to its HCS topic when it delivers a job: evidence a client or arbiter can check. */
export type Receipt = {
  bonds: Address;
  paymentId: bigint;
  agent: Address;
  summary: string;
  createdAt: number;
};

/** Why a client disputes a payment. */
export type DisputeReason = {
  bonds: Address;
  paymentId: bigint;
  client: Address;
  reason: string;
  createdAt: number;
};

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** Trims `text` by code points (never mid-character) until `encode(text)` fits one HCS message. */
function fitToMessage(text: string, encode: (text: string) => string): string {
  let chars = Array.from(text);
  let message = encode(text);
  while (utf8Length(message) > MAX_MESSAGE_BYTES && chars.length > 0) {
    const excess = utf8Length(message) - MAX_MESSAGE_BYTES;
    chars = chars.slice(0, Math.max(0, chars.length - Math.max(1, Math.ceil(excess / 4))));
    message = encode(chars.join(""));
  }
  return message;
}

/**
 * Canonical receipt: fixed key order and integer strings, so the exact bytes published to HCS hash to the
 * `receiptHash` stored on-chain. Anyone can re-hash a topic message and match it to a payment.
 */
export function encodeReceipt(receipt: Receipt): string {
  return fitToMessage(receipt.summary, summary =>
    JSON.stringify({
      v: 1,
      type: "receipt",
      bonds: receipt.bonds.toLowerCase(),
      paymentId: receipt.paymentId.toString(),
      agent: receipt.agent.toLowerCase(),
      summary,
      createdAt: receipt.createdAt,
    }),
  );
}

export function encodeDisputeReason(dispute: DisputeReason): string {
  return fitToMessage(dispute.reason, reason =>
    JSON.stringify({
      v: 1,
      type: "dispute",
      bonds: dispute.bonds.toLowerCase(),
      paymentId: dispute.paymentId.toString(),
      client: dispute.client.toLowerCase(),
      reason,
      createdAt: dispute.createdAt,
    }),
  );
}

/** Canonical hash of a job description, stored with the payment so both sides agree on what was bought. */
export const hashJob = (description: string): Hex => keccak256(toBytes(description.trim()));

export const hashMessage = (message: string): Hex => keccak256(toBytes(message));

export type PublishedMessage = { topicId: string; sequenceNumber: number; transactionId: string };

export interface MessagePublisher {
  publish(topicId: string, message: string): Promise<PublishedMessage>;
}
