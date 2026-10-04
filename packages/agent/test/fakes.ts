import { zeroAddress, type Address, type Hex } from "viem";
import type { AgentInfo, BondsGateway, DisputeResult, PayResult, PaymentInfo } from "../src/bonds";
import type { MessagePublisher, PublishedMessage } from "../src/messages";

export const BONDS = "0x000000000000000000000000000000000000b0d5" as Address;
export const AGENT = "0x00000000000000000000000000000000000a9e17" as Address;
export const CLIENT = "0x0000000000000000000000000000000000c11e47" as Address;
const HBAR = 100_000_000n;
const ZERO = `0x${"00".repeat(32)}` as Hex;

/** In-memory AgentBonds following the contract's rules: full coverage, locks, instant clawback. */
export class FakeBonds implements BondsGateway {
  readonly address = BONDS;
  payments: PaymentInfo[] = [];
  receipts: { id: bigint; hash: Hex }[] = [];
  agent: AgentInfo = {
    address: AGENT,
    name: "Research Agent",
    registered: true,
    arbiter: zeroAddress,
    disputeWindow: 180,
    receiptTopic: 4242n,
    bond: 40n * HBAR,
    locked: 0n,
    pendingWithdrawal: 0n,
    withdrawableAt: 0,
    freeBond: 40n * HBAR,
    payments: 0,
    disputes: 0,
    clawbacks: 0,
  };

  constructor(readonly account: Address = CLIENT) {}

  async getAgent(agent: Address): Promise<AgentInfo> {
    return agent.toLowerCase() === AGENT.toLowerCase()
      ? { ...this.agent }
      : { ...this.agent, address: agent, registered: false };
  }

  async listAgents() {
    return [{ ...this.agent }];
  }

  async getPayment(id: bigint): Promise<PaymentInfo> {
    const payment = this.payments[Number(id) - 1];
    if (!payment) return { ...this.emptyPayment(id) };
    return { ...payment };
  }

  async quoteUsd(tinybars: bigint) {
    return { ok: true, usd: tinybars / 1000n }; // $0.10 per HBAR, 6-decimal USD
  }

  async postBond(tinybars: bigint): Promise<Hex> {
    this.agent.bond += tinybars;
    this.agent.freeBond += tinybars;
    return `0x${"01".repeat(32)}`;
  }

  async submitReceipt(id: bigint, receiptHash: Hex): Promise<Hex> {
    this.receipts.push({ id, hash: receiptHash });
    this.payments[Number(id) - 1].receiptHash = receiptHash;
    return `0x${"02".repeat(32)}`;
  }

  async pay(agent: Address, tinybars: bigint, jobHash: Hex, maxUsd: bigint): Promise<PayResult> {
    if (tinybars > this.agent.freeBond) throw new Error(`NotCovered(${this.agent.freeBond})`);
    const usd = tinybars / 1000n;
    if (maxUsd > 0n && usd > maxUsd) throw new Error(`OverQuote(${usd}, ${maxUsd})`);
    this.agent.locked += tinybars;
    this.agent.freeBond -= tinybars;
    this.agent.payments += 1;
    const id = BigInt(this.payments.length + 1);
    this.payments.push({
      ...this.emptyPayment(id),
      client: this.account,
      agent,
      amount: tinybars,
      usdValue: usd,
      disputeUntil: 1_790_000_180,
      status: "open",
      jobHash,
    });
    return { id, disputeUntil: 1_790_000_180, usdValue: usd, txHash: `0x${"03".repeat(32)}` };
  }

  async dispute(id: bigint, reasonHash: Hex): Promise<DisputeResult> {
    const payment = this.payments[Number(id) - 1];
    payment.status = "refunded";
    payment.refunded = payment.amount;
    payment.disputeHash = reasonHash;
    this.agent.bond -= payment.amount;
    this.agent.locked -= payment.amount;
    this.agent.disputes += 1;
    this.agent.clawbacks += 1;
    return { status: "refunded", refunded: payment.amount, txHash: `0x${"04".repeat(32)}` };
  }

  private emptyPayment(id: bigint): PaymentInfo {
    return {
      id,
      client: zeroAddress,
      agent: zeroAddress,
      amount: 0n,
      usdValue: 0n,
      paidAt: 0,
      disputeUntil: 0,
      arbitrationDeadline: 0,
      status: "none",
      refunded: 0n,
      jobHash: ZERO,
      receiptHash: ZERO,
      disputeHash: ZERO,
      schedule: zeroAddress,
    };
  }
}

export class FakePublisher implements MessagePublisher {
  published: { topicId: string; message: string }[] = [];

  async publish(topicId: string, message: string): Promise<PublishedMessage> {
    this.published.push({ topicId, message });
    return { topicId, sequenceNumber: this.published.length, transactionId: "0.0.1@1790000000.0" };
  }
}
