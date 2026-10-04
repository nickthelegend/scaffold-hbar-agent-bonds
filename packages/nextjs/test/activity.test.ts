import { agentBondsAbi } from "@sh/agent/abi";
import { encodeReceipt, hashMessage } from "@sh/agent/messages";
import { type Hex, encodeAbiParameters, encodeEventTopics, getAbiItem } from "viem";
import { describe, expect, it } from "vitest";
import { type MirrorLog, buildPayments, decodeBondsLogs, indexReceipts, paymentOutcome } from "~~/utils/bonds/activity";
import { entityIdFromAddress, formatDuration, formatHbar, formatUsd } from "~~/utils/bonds/format";

const BONDS = "0x000000000000000000000000000000000000b0d5";
const AGENT = "0x00000000000000000000000000000000000a9e17";
const CLIENT = "0x0000000000000000000000000000000000c11e47";
const SCHEDULE = "0x0000000000000000000000000000000000a1b2c3";
const JOB = `0x${"11".repeat(32)}` as Hex;

/** Encodes an AgentBonds event exactly as the mirror node serves it. */
function log(eventName: string, args: Record<string, unknown>, timestamp: number, tx = "aa", index = 0): MirrorLog {
  const event = getAbiItem({ abi: agentBondsAbi, name: eventName as never }) as {
    inputs: { name: string; type: string; indexed?: boolean }[];
  };
  const topics = encodeEventTopics({ abi: agentBondsAbi, eventName: eventName as never, args: args as never });
  const dataInputs = event.inputs.filter(input => !input.indexed);
  return {
    topics: topics as Hex[],
    data: encodeAbiParameters(dataInputs, dataInputs.map(input => args[input.name]) as never),
    transaction_hash: `0x${tx.repeat(32)}` as Hex,
    timestamp: `${timestamp}.000000001`,
    index,
  };
}

const paid = (id: bigint, timestamp: number, amount = 1_000_000_000n) => [
  log(
    "Paid",
    {
      id,
      client: CLIENT,
      agent: AGENT,
      amount,
      usdValue: 1_000_000n,
      jobHash: JOB,
      disputeUntil: BigInt(timestamp + 180),
    },
    timestamp,
    "aa",
    0,
  ),
  log("ReleaseScheduled", { id, schedule: SCHEDULE, at: BigInt(timestamp + 180) }, timestamp, "aa", 1),
];

describe("buildPayments", () => {
  it("derives each payment's state from logs served newest-first, as the mirror node does", () => {
    const receiptHash = `0x${"22".repeat(32)}` as Hex;
    const oldestFirst = [
      ...paid(1n, 100),
      log("ReceiptSubmitted", { id: 1n, receiptHash }, 110),
      ...paid(2n, 120, 1_500_000_000n),
      // Satisfaction guarantee: Disputed (no arbitration deadline) then ClawedBack in the same transaction.
      log("Disputed", { id: 2n, reasonHash: JOB, arbitrationDeadline: 0n }, 130, "bb", 0),
      log("ClawedBack", { id: 2n, client: CLIENT, refund: 1_500_000_000n, remainingBond: 0n }, 130, "bb", 1),
      ...paid(3n, 140),
      log("Disputed", { id: 3n, reasonHash: JOB, arbitrationDeadline: 999n }, 150, "cc"),
      log("Released", { id: 1n }, 280, "dd"),
      ...paid(4n, 300),
    ];

    const payments = buildPayments(decodeBondsLogs([...oldestFirst].reverse()));

    expect(payments.map(p => [p.id, p.state])).toEqual([
      [4n, "open"],
      [3n, "disputed"],
      [2n, "refunded"],
      [1n, "released"],
    ]);
    expect(payments.find(p => p.id === 1n)).toMatchObject({ receiptHash, disputeUntil: 280 });
    expect(payments.find(p => p.id === 2n)?.refunded).toBe(1_500_000_000n);
    expect(payments.find(p => p.id === 3n)?.arbitrationDeadline).toBe(999);
    expect(payments.find(p => p.id === 4n)?.schedule?.toLowerCase()).toBe(SCHEDULE);
  });

  it("tells clawbacks, arbiter splits and rulings for the agent apart", () => {
    const amount = 800_000_000n;
    const payments = buildPayments(
      decodeBondsLogs([
        ...paid(1n, 100, amount),
        log("Disputed", { id: 1n, reasonHash: JOB, arbitrationDeadline: 0n }, 110, "bb", 0),
        log("ClawedBack", { id: 1n, client: CLIENT, refund: amount, remainingBond: 0n }, 110, "bb", 1),
        ...paid(2n, 200, amount),
        log("Disputed", { id: 2n, reasonHash: JOB, arbitrationDeadline: 999n }, 210, "cc"),
        log("ClawedBack", { id: 2n, client: CLIENT, refund: amount / 2n, remainingBond: 0n }, 220, "dd"),
        ...paid(3n, 300, amount),
        log("Disputed", { id: 3n, reasonHash: JOB, arbitrationDeadline: 999n }, 310, "ee"),
        log("Released", { id: 3n }, 320, "ff"),
        ...paid(4n, 400, amount),
        log("Released", { id: 4n }, 580, "12"),
      ]),
    );
    const outcome = (id: bigint) => paymentOutcome(payments.find(p => p.id === id)!);

    expect(outcome(1n)).toMatchObject({ label: "Clawed back", settledLabel: "clawback tx" });
    expect(outcome(2n)).toMatchObject({ label: "Arbiter split (50% refunded)", settledLabel: "resolution tx" });
    expect(payments.find(p => p.id === 2n)?.disputeTx).toBe(`0x${"cc".repeat(32)}`);
    expect(outcome(3n)).toMatchObject({ label: "Arbiter ruled for the agent", settledLabel: "resolution tx" });
    expect(outcome(4n)).toMatchObject({ label: "Released", settledLabel: "release tx" });
  });

  it("ignores logs that are not AgentBonds events", () => {
    const foreign: MirrorLog = {
      topics: [`0x${"ff".repeat(32)}`],
      data: "0x",
      transaction_hash: "0x00",
      timestamp: "1.0",
      index: 0,
    };
    expect(decodeBondsLogs([foreign])).toEqual([]);
  });
});

describe("indexReceipts", () => {
  it("keys HCS receipts by the keccak256 recorded on-chain", () => {
    const message = encodeReceipt({ bonds: BONDS, paymentId: 1n, agent: AGENT, summary: "Delivered", createdAt: 1 });
    const index = indexReceipts([
      { message: Buffer.from(message).toString("base64"), sequence_number: 3 },
      { message: Buffer.from("not json").toString("base64"), sequence_number: 4 },
    ]);
    expect(index.size).toBe(1);
    expect(index.get(hashMessage(message))).toEqual({ summary: "Delivered", sequenceNumber: 3 });
  });
});

describe("formatting", () => {
  it("formats units used across the dashboard", () => {
    expect(formatUsd(1_500_000n)).toBe("$1.50");
    expect(formatHbar(250_000_000n)).toBe("2.5 ℏ");
    expect(formatDuration(3_725)).toBe("1h 2m");
    expect(entityIdFromAddress(SCHEDULE)).toBe("0.0.10597059");
  });
});
