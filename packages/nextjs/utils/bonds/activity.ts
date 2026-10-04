import { agentBondsAbi } from "@sh/agent/abi";
import { hashMessage } from "@sh/agent/messages";
import { NETWORKS } from "@sh/agent/network";
import { type Address, type Hex, decodeEventLog } from "viem";
import { hedera } from "viem/chains";

export type PaymentState = "open" | "disputed" | "released" | "refunded";

/** Pages of 100 entries fetched per refresh; logs are re-sorted chronologically after fetching. */
const MAX_PAGES = 50;

const mirrorNodeUrl = (chainId: number) => NETWORKS[chainId === hedera.id ? "mainnet" : "testnet"].mirrorNode;

export type MirrorLog = {
  data: Hex;
  topics: Hex[];
  transaction_hash: Hex;
  /** Consensus timestamp, "seconds.nanoseconds". */
  timestamp: string;
  /** Position of the log within its transaction. */
  index: number;
};

export type BondsEvent = {
  eventName: string;
  args: Record<string, unknown>;
  txHash: Hex;
  timestamp: number;
};

export type PaymentRow = {
  id: bigint;
  client: Address;
  agent: Address;
  amount: bigint;
  usdValue: bigint;
  jobHash: Hex;
  paidAt: number;
  disputeUntil: number;
  payTx: Hex;
  state: PaymentState;
  schedule?: Address;
  receiptHash?: Hex;
  receiptTx?: Hex;
  disputeTx?: Hex;
  arbitrationDeadline?: number;
  refunded?: bigint;
  settledTx?: Hex;
};

export type ReceiptRecord = { summary: string; sequenceNumber: number };

/** Total order of logs: consensus timestamp (to the nanosecond), then position within the transaction. */
const logOrder = (log: MirrorLog) => {
  const [seconds, nanos = "0"] = log.timestamp.split(".");
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos.padEnd(9, "0"));
};

/** Decodes AgentBonds logs in chronological order, skipping anything that is not an AgentBonds event. */
export function decodeBondsLogs(logs: MirrorLog[]): BondsEvent[] {
  const ordered = [...logs].sort((a, b) => {
    const delta = logOrder(a) - logOrder(b);
    return delta !== 0n ? (delta < 0n ? -1 : 1) : a.index - b.index;
  });
  const events: BondsEvent[] = [];
  for (const log of ordered) {
    try {
      const decoded = decodeEventLog({
        abi: agentBondsAbi,
        data: log.data,
        topics: log.topics.filter(Boolean) as [Hex, ...Hex[]],
      });
      events.push({
        eventName: decoded.eventName,
        args: (decoded.args ?? {}) as Record<string, unknown>,
        txHash: log.transaction_hash,
        timestamp: Number(log.timestamp.split(".")[0]),
      });
    } catch {
      // Not an AgentBonds event.
    }
  }
  return events;
}

/** Folds the chronological event stream into one row per payment, newest first. */
export function buildPayments(events: BondsEvent[]): PaymentRow[] {
  const byId = new Map<bigint, PaymentRow>();
  for (const event of events) {
    const id = event.args.id as bigint | undefined;
    if (id === undefined) continue;

    if (event.eventName === "Paid") {
      byId.set(id, {
        id,
        client: event.args.client as Address,
        agent: event.args.agent as Address,
        amount: event.args.amount as bigint,
        usdValue: event.args.usdValue as bigint,
        jobHash: event.args.jobHash as Hex,
        paidAt: event.timestamp,
        disputeUntil: Number(event.args.disputeUntil),
        payTx: event.txHash,
        state: "open",
      });
      continue;
    }

    const row = byId.get(id);
    if (!row) continue;
    switch (event.eventName) {
      case "ReleaseScheduled":
        row.schedule = event.args.schedule as Address;
        break;
      case "ReceiptSubmitted":
        row.receiptHash = event.args.receiptHash as Hex;
        row.receiptTx = event.txHash;
        break;
      case "Disputed": {
        row.disputeTx = event.txHash;
        const deadline = Number(event.args.arbitrationDeadline);
        if (deadline > 0) {
          row.state = "disputed";
          row.arbitrationDeadline = deadline;
        }
        break;
      }
      case "ClawedBack":
        row.state = "refunded";
        row.refunded = event.args.refund as bigint;
        row.settledTx = event.txHash;
        break;
      case "Released":
        row.state = "released";
        row.settledTx = event.txHash;
        break;
    }
  }
  return [...byId.values()].sort((a, b) => (a.id > b.id ? -1 : 1));
}

type TopicMessage = { message: string; sequence_number: number };

/** Indexes an agent's receipt topic by keccak256(message), the hash recorded with each payment. */
export function indexReceipts(messages: TopicMessage[]): Map<Hex, ReceiptRecord> {
  const index = new Map<Hex, ReceiptRecord>();
  for (const entry of messages) {
    const message = Buffer.from(entry.message, "base64").toString("utf8");
    try {
      const parsed = JSON.parse(message);
      if (parsed.type !== "receipt") continue;
      index.set(hashMessage(message), { summary: String(parsed.summary ?? ""), sequenceNumber: entry.sequence_number });
    } catch {
      // Not a receipt.
    }
  }
  return index;
}

/** Pages through a mirror-node collection newest first, up to MAX_PAGES, so recent entries are never dropped. */
async function fetchAllPages<T>(baseUrl: string, path: string, key: string): Promise<T[]> {
  const items: T[] = [];
  let next: string | null = path;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const response = await fetch(`${baseUrl}${next}`);
    if (!response.ok) throw new Error(`Mirror node returned ${response.status}`);
    const body = (await response.json()) as Record<string, unknown> & { links?: { next: string | null } };
    items.push(...((body[key] as T[]) ?? []));
    next = body.links?.next ?? null;
  }
  return items;
}

export async function fetchPayments(chainId: number, bonds: Address): Promise<PaymentRow[]> {
  const logs = await fetchAllPages<MirrorLog>(
    mirrorNodeUrl(chainId),
    `/api/v1/contracts/${bonds}/results/logs?order=desc&limit=100`,
    "logs",
  );
  return buildPayments(decodeBondsLogs(logs));
}

export async function fetchReceipts(chainId: number, topicId: string): Promise<Map<Hex, ReceiptRecord>> {
  const messages = await fetchAllPages<TopicMessage>(
    mirrorNodeUrl(chainId),
    `/api/v1/topics/${topicId}/messages?order=desc&limit=100`,
    "messages",
  );
  return indexReceipts(messages);
}
