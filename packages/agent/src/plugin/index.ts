import { BaseQueryTool, BaseTool, TOOL_TYPE, type Plugin, type ToolType } from "@hashgraph/hedera-agent-kit";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import type { AgentInfo, BondsGateway, PaymentInfo } from "../bonds";
import { encodeReceipt, hashJob, hashMessage, type MessagePublisher } from "../messages";
import { resolveRecipient, topicIdFromNumber } from "../mirror";
import { hashscanTopic, hashscanTx, type HederaNetwork } from "../network";
import { formatUsd, hbarToTinybars, tinybarsToHbar, usdToMicros } from "../units";

export const LIST_AGENTS_TOOL = "bonds_list_agents";
export const GET_AGENT_TOOL = "bonds_get_agent";
export const GET_PAYMENT_TOOL = "bonds_get_payment";
export const PAY_AGENT_TOOL = "bonds_pay_agent";
export const DISPUTE_TOOL = "bonds_dispute";
export const POST_BOND_TOOL = "bonds_post_bond";
export const SUBMIT_RECEIPT_TOOL = "bonds_submit_receipt";

export type BondsDeps = {
  bonds: BondsGateway;
  network: HederaNetwork;
  /** Publishes receipts to the agent's HCS topic; omit to record receipt hashes without publishing. */
  publisher?: MessagePublisher;
  resolveAddress?: (value: string) => Promise<Address>;
  now?: () => number;
};

type Envelope = { raw: Record<string, unknown>; humanMessage: string };

const describeAgent = (a: AgentInfo, freeUsd?: bigint) => ({
  address: a.address,
  name: a.name,
  mode: a.arbiter === "0x0000000000000000000000000000000000000000" ? "satisfaction-guarantee" : "arbitrated",
  arbiter: a.arbiter,
  disputeWindowSeconds: a.disputeWindow,
  bondHbar: tinybarsToHbar(a.bond),
  coverageAvailableHbar: tinybarsToHbar(a.freeBond),
  coverageAvailableUsd: freeUsd === undefined ? null : formatUsd(freeUsd),
  lockedHbar: tinybarsToHbar(a.locked),
  payments: a.payments,
  disputes: a.disputes,
  clawbacks: a.clawbacks,
  receiptTopic: topicIdFromNumber(a.receiptTopic),
});

const describePayment = (p: PaymentInfo) => ({
  paymentId: p.id.toString(),
  status: p.status,
  client: p.client,
  agent: p.agent,
  amountHbar: tinybarsToHbar(p.amount),
  usdValue: formatUsd(p.usdValue),
  refundedHbar: tinybarsToHbar(p.refunded),
  disputeUntil: p.disputeUntil ? new Date(p.disputeUntil * 1000).toISOString() : null,
  hasReceipt: !/^0x0+$/.test(p.receiptHash),
});

/** Read-only tool: everything happens in coreAction. */
abstract class QueryTool<P> extends BaseQueryTool {
  async normalizeParams(params: P) {
    return params;
  }
  async shouldSecondaryAction() {
    return false;
  }
}

/** Transaction tool: coreAction prepares (so policies can inspect it), secondaryAction submits. */
abstract class TransactionTool<P, Prepared> extends BaseTool<P, Prepared> {
  toolType: ToolType = TOOL_TYPE.TRANSACTION;
  async coreAction(prepared: Prepared) {
    return prepared;
  }
  abstract secondaryAction(prepared: Prepared): Promise<Envelope>;
}

class ListAgentsTool extends QueryTool<Record<string, never>> {
  method = LIST_AGENTS_TOOL;
  name = "List bonded agents";
  description =
    "Lists agents registered in AgentBonds with their bond coverage, dispute window, dispute mode and track record " +
    "(payments, disputes, clawbacks). A payment to an agent is fully refundable from its bond during the window.";
  parameters = z.object({});

  constructor(private readonly deps: BondsDeps) {
    super();
  }

  async coreAction(): Promise<Envelope> {
    const agents = await this.deps.bonds.listAgents();
    const rows = await Promise.all(
      agents.map(async a => describeAgent(a, (await this.deps.bonds.quoteUsd(a.freeBond)).usd)),
    );
    return {
      raw: { agents: rows },
      humanMessage: rows.length
        ? rows
            .map(
              r =>
                `${r.name} (${r.address}): ${r.coverageAvailableHbar} HBAR coverage (${r.coverageAvailableUsd}), ` +
                `${r.mode}, ${r.disputeWindowSeconds}s window, ${r.payments} payments, ${r.clawbacks} clawbacks`,
            )
            .join("\n")
        : "No agents are registered yet.",
    };
  }
}

const addressParameters = z.object({
  agent: z.string().optional().describe("Agent EVM address or 0.0.x account ID; defaults to yourself"),
});

class GetAgentTool extends QueryTool<z.infer<typeof addressParameters>> {
  method = GET_AGENT_TOOL;
  name = "Get agent bond";
  description =
    "Returns one agent's bond, free coverage, locked amount and dispute record (defaults to yourself).";
  parameters = addressParameters;

  constructor(private readonly deps: BondsDeps) {
    super();
  }

  async coreAction(params: z.infer<typeof addressParameters>): Promise<Envelope> {
    const address = params.agent ? await resolve(this.deps, params.agent) : this.deps.bonds.account;
    const agent = await this.deps.bonds.getAgent(address);
    if (!agent.registered) throw new Error(`${address} is not a registered agent`);
    const raw = describeAgent(agent, (await this.deps.bonds.quoteUsd(agent.freeBond)).usd);
    return {
      raw,
      humanMessage:
        `${raw.name}: bond ${raw.bondHbar} HBAR, ${raw.coverageAvailableHbar} HBAR free to cover new payments ` +
        `(${raw.coverageAvailableUsd}), ${raw.lockedHbar} HBAR locked. Record: ${raw.payments} payments, ` +
        `${raw.disputes} disputes, ${raw.clawbacks} clawbacks.`,
    };
  }
}

const paymentIdParameters = z.object({ paymentId: z.string().describe("Payment ID") });

class GetPaymentTool extends QueryTool<z.infer<typeof paymentIdParameters>> {
  method = GET_PAYMENT_TOOL;
  name = "Get payment";
  description = "Returns a payment's status (open, disputed, released, refunded) and its dispute deadline.";
  parameters = paymentIdParameters;

  constructor(private readonly deps: BondsDeps) {
    super();
  }

  async coreAction(params: z.infer<typeof paymentIdParameters>): Promise<Envelope> {
    const payment = await this.deps.bonds.getPayment(BigInt(params.paymentId));
    if (payment.status === "none") throw new Error(`No payment #${params.paymentId}`);
    const raw = describePayment(payment);
    return { raw, humanMessage: `Payment #${raw.paymentId} is ${raw.status} (${raw.amountHbar} HBAR).` };
  }
}

const payParameters = z.object({
  agent: z.string().describe("Agent EVM address or 0.0.x account ID"),
  amountHbar: z.string().describe("Amount in HBAR, e.g. '15'"),
  job: z.string().min(1).describe("Exact job description; its hash is stored with the payment"),
  maxUsd: z
    .string()
    .optional()
    .describe(
      "The USD price you agreed to; the payment reverts if HBAR is worth more than this at payment time",
    ),
});
type PayParams = z.infer<typeof payParameters>;
type PreparedPay = { agent: Address; tinybars: bigint; job: string; maxUsd: bigint };

class PayAgentTool extends TransactionTool<PayParams, PreparedPay> {
  method = PAY_AGENT_TOOL;
  name = "Pay a bonded agent";
  description =
    "Pays an agent for a job. The agent is paid immediately, and the full amount stays refundable from its bond " +
    "during its dispute window. Pass maxUsd to enforce the agreed USD price.";
  parameters = payParameters;

  constructor(private readonly deps: BondsDeps) {
    super();
  }

  async normalizeParams(params: PayParams): Promise<PreparedPay> {
    const tinybars = hbarToTinybars(params.amountHbar);
    if (tinybars <= 0n) throw new Error("amountHbar must be positive");
    return {
      agent: await resolve(this.deps, params.agent),
      tinybars,
      job: params.job.trim(),
      maxUsd: params.maxUsd ? usdToMicros(params.maxUsd) : 0n,
    };
  }

  async secondaryAction(prepared: PreparedPay): Promise<Envelope> {
    const result = await this.deps.bonds.pay(
      prepared.agent,
      prepared.tinybars,
      hashJob(prepared.job),
      prepared.maxUsd,
    );
    const disputeUntil = new Date(result.disputeUntil * 1000).toISOString();
    const raw = {
      paymentId: result.id.toString(),
      agent: prepared.agent,
      amountHbar: tinybarsToHbar(prepared.tinybars),
      usdValue: formatUsd(result.usdValue),
      disputeUntil,
      transaction: hashscanTx(this.deps.network, result.txHash),
    };
    return {
      raw,
      humanMessage:
        `Paid ${raw.amountHbar} HBAR (${raw.usdValue}) to ${raw.agent} as payment #${raw.paymentId}. ` +
        `It is fully refundable from the agent's bond until ${disputeUntil}. Transaction: ${raw.transaction}`,
    };
  }
}

const disputeParameters = z.object({
  paymentId: z.string().describe("Payment ID to dispute"),
  reason: z.string().min(1).describe("What the agent did wrong; its hash is recorded on-chain"),
});
type DisputeParams = z.infer<typeof disputeParameters>;

class DisputeTool extends TransactionTool<DisputeParams, { id: bigint; reason: string }> {
  method = DISPUTE_TOOL;
  name = "Dispute a payment (claw back)";
  description =
    "Disputes a payment inside its window. For satisfaction-guarantee agents the full amount is clawed back from " +
    "the agent's bond immediately; arbitrated agents' disputes go to their arbiter.";
  parameters = disputeParameters;

  constructor(private readonly deps: BondsDeps) {
    super();
  }

  async normalizeParams(params: DisputeParams) {
    return { id: BigInt(params.paymentId), reason: params.reason.trim() };
  }

  async secondaryAction({ id, reason }: { id: bigint; reason: string }): Promise<Envelope> {
    const result = await this.deps.bonds.dispute(id, hashMessage(reason));
    const raw = {
      paymentId: id.toString(),
      status: result.status,
      refundedHbar: tinybarsToHbar(result.refunded),
      transaction: hashscanTx(this.deps.network, result.txHash),
    };
    return {
      raw,
      humanMessage:
        result.status === "refunded"
          ? `Clawed back ${raw.refundedHbar} HBAR from the agent's bond for payment #${raw.paymentId}. ${raw.transaction}`
          : `Payment #${raw.paymentId} is now ${result.status}; the agent's arbiter will decide. ${raw.transaction}`,
    };
  }
}

const bondParameters = z.object({ amountHbar: z.string().describe("HBAR to add to your bond") });

class PostBondTool extends TransactionTool<z.infer<typeof bondParameters>, bigint> {
  method = POST_BOND_TOOL;
  name = "Post bond";
  description = "Adds HBAR to your bond so you can cover larger or more concurrent payments.";
  parameters = bondParameters;

  constructor(private readonly deps: BondsDeps) {
    super();
  }

  async normalizeParams(params: z.infer<typeof bondParameters>) {
    const tinybars = hbarToTinybars(params.amountHbar);
    if (tinybars <= 0n) throw new Error("amountHbar must be positive");
    return tinybars;
  }

  async secondaryAction(tinybars: bigint): Promise<Envelope> {
    const txHash = await this.deps.bonds.postBond(tinybars);
    const agent = await this.deps.bonds.getAgent(this.deps.bonds.account);
    return {
      raw: { bondHbar: tinybarsToHbar(agent.bond), transaction: hashscanTx(this.deps.network, txHash) },
      humanMessage: `Bond is now ${tinybarsToHbar(agent.bond)} HBAR.`,
    };
  }
}

const receiptParameters = z.object({
  paymentId: z.string().describe("Payment the work was for"),
  summary: z
    .string()
    .min(1)
    .describe("What you delivered, specific enough for the client or an arbiter to check"),
});
type ReceiptParams = z.infer<typeof receiptParameters>;

class SubmitReceiptTool extends TransactionTool<ReceiptParams, { id: bigint; message: string }> {
  method = SUBMIT_RECEIPT_TOOL;
  name = "Submit work receipt";
  description =
    "Publishes a receipt for delivered work to your HCS topic and records its hash on the payment, so clients and " +
    "arbiters can verify what you delivered.";
  parameters = receiptParameters;

  constructor(private readonly deps: BondsDeps) {
    super();
  }

  async normalizeParams(params: ReceiptParams) {
    const id = BigInt(params.paymentId);
    const message = encodeReceipt({
      bonds: this.deps.bonds.address,
      paymentId: id,
      agent: this.deps.bonds.account,
      summary: params.summary.trim(),
      createdAt: Math.floor((this.deps.now?.() ?? Date.now()) / 1000),
    });
    return { id, message };
  }

  async secondaryAction({ id, message }: { id: bigint; message: string }): Promise<Envelope> {
    const agent = await this.deps.bonds.getAgent(this.deps.bonds.account);
    const topicId = topicIdFromNumber(agent.receiptTopic);
    const published =
      topicId && this.deps.publisher ? await this.deps.publisher.publish(topicId, message) : null;
    const txHash = await this.deps.bonds.submitReceipt(id, hashMessage(message));
    return {
      raw: {
        paymentId: id.toString(),
        receiptHash: hashMessage(message),
        topic: topicId ? hashscanTopic(this.deps.network, topicId) : null,
        sequenceNumber: published?.sequenceNumber ?? null,
        transaction: hashscanTx(this.deps.network, txHash),
      },
      humanMessage: `Receipt for payment #${id} recorded${published ? ` and published to HCS (#${published.sequenceNumber})` : ""}.`,
    };
  }
}

async function resolve(deps: BondsDeps, value: string): Promise<Address> {
  if (isAddress(value.trim())) return getAddress(value.trim());
  return (deps.resolveAddress ?? (v => resolveRecipient(deps.network, v)))(value);
}

/** Hedera Agent Kit plugin for AgentBonds: provider tools (bond, receipts) and client tools (hire, dispute). */
export const createAgentBondsPlugin = (deps: BondsDeps): Plugin => ({
  name: "agent-bonds",
  version: "0.1.0",
  description:
    "Hire bonded AI agents with clawback guarantees, or operate one: bonds, payments, receipts, disputes.",
  tools: () => [
    new ListAgentsTool(deps),
    new GetAgentTool(deps),
    new GetPaymentTool(deps),
    new PayAgentTool(deps),
    new DisputeTool(deps),
    new PostBondTool(deps),
    new SubmitReceiptTool(deps),
  ],
});
