import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { agentBondsAbi } from "./abi";
import { hederaChain, type HederaNetwork } from "./network";
import { hbarToWeibars, tinybarsToHbar } from "./units";

/** Mirrors `AgentBonds.Status`. */
export const STATUSES = ["none", "open", "disputed", "released", "refunded"] as const;
export type Status = (typeof STATUSES)[number];

export type AgentInfo = {
  address: Address;
  name: string;
  registered: boolean;
  arbiter: Address;
  disputeWindow: number;
  receiptTopic: bigint;
  bond: bigint;
  locked: bigint;
  pendingWithdrawal: bigint;
  withdrawableAt: number;
  freeBond: bigint;
  payments: number;
  disputes: number;
  clawbacks: number;
};

export type PaymentInfo = {
  id: bigint;
  client: Address;
  agent: Address;
  amount: bigint;
  usdValue: bigint;
  paidAt: number;
  disputeUntil: number;
  arbitrationDeadline: number;
  status: Status;
  refunded: bigint;
  jobHash: Hex;
  receiptHash: Hex;
  disputeHash: Hex;
  schedule: Address;
};

export type PayResult = { id: bigint; disputeUntil: number; usdValue: bigint; txHash: Hex };
export type DisputeResult = { status: Status; refunded: bigint; txHash: Hex };

const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

/** The AgentBonds operations agents and their clients need; implemented over JSON-RPC and faked in tests. */
export interface BondsGateway {
  readonly address: Address;
  readonly account: Address;
  getAgent(agent: Address): Promise<AgentInfo>;
  listAgents(): Promise<AgentInfo[]>;
  getPayment(id: bigint): Promise<PaymentInfo>;
  quoteUsd(tinybars: bigint): Promise<{ ok: boolean; usd: bigint }>;
  postBond(tinybars: bigint): Promise<Hex>;
  submitReceipt(id: bigint, receiptHash: Hex): Promise<Hex>;
  pay(agent: Address, tinybars: bigint, jobHash: Hex, maxUsd: bigint): Promise<PayResult>;
  dispute(id: bigint, reasonHash: Hex): Promise<DisputeResult>;
}

export class RpcBondsGateway implements BondsGateway {
  readonly account: Address;
  private readonly publicClient: PublicClient<Transport, Chain>;
  private readonly walletClient: WalletClient<Transport, Chain, Account>;

  constructor(
    readonly address: Address,
    private readonly signer: Account,
    network: HederaNetwork,
    rpcUrl?: string,
  ) {
    const chain = hederaChain(network, rpcUrl);
    this.account = signer.address;
    this.publicClient = createPublicClient({ chain, transport: http() });
    this.walletClient = createWalletClient({ chain, transport: http(), account: signer });
  }

  private get contract() {
    return { address: this.address, abi: agentBondsAbi } as const;
  }

  async getAgent(agent: Address): Promise<AgentInfo> {
    const [info, name, freeBond] = await Promise.all([
      this.publicClient.readContract({ ...this.contract, functionName: "getAgent", args: [agent] }),
      this.publicClient.readContract({ ...this.contract, functionName: "names", args: [agent] }),
      this.publicClient.readContract({ ...this.contract, functionName: "freeBond", args: [agent] }),
    ]);
    return {
      address: agent,
      name,
      registered: info.registered,
      arbiter: info.arbiter,
      disputeWindow: info.disputeWindow,
      receiptTopic: info.receiptTopic,
      bond: info.bond,
      locked: info.locked,
      pendingWithdrawal: info.pendingWithdrawal,
      withdrawableAt: Number(info.withdrawableAt),
      freeBond,
      payments: info.payments,
      disputes: info.disputes,
      clawbacks: info.clawbacks,
    };
  }

  async listAgents(): Promise<AgentInfo[]> {
    const addresses = await this.publicClient.readContract({ ...this.contract, functionName: "agentList" });
    return Promise.all(addresses.map(address => this.getAgent(address)));
  }

  async getPayment(id: bigint): Promise<PaymentInfo> {
    const p = await this.publicClient.readContract({
      ...this.contract,
      functionName: "getPayment",
      args: [id],
    });
    return {
      id,
      client: p.client,
      agent: p.agent,
      amount: p.amount,
      usdValue: p.usdValue,
      paidAt: Number(p.paidAt),
      disputeUntil: Number(p.disputeUntil),
      arbitrationDeadline: Number(p.arbitrationDeadline),
      status: STATUSES[p.status],
      refunded: p.refunded,
      jobHash: p.jobHash,
      receiptHash: p.receiptHash,
      disputeHash: p.disputeHash,
      schedule: p.schedule,
    };
  }

  async quoteUsd(tinybars: bigint): Promise<{ ok: boolean; usd: bigint }> {
    const [ok, usd] = await this.publicClient.readContract({
      ...this.contract,
      functionName: "quoteUsd",
      args: [tinybars],
    });
    return { ok, usd };
  }

  postBond(tinybars: bigint): Promise<Hex> {
    return this.send("postBond", [], tinybars).then(({ transactionHash }) => transactionHash);
  }

  submitReceipt(id: bigint, receiptHash: Hex): Promise<Hex> {
    return this.send("submitReceipt", [id, receiptHash]).then(({ transactionHash }) => transactionHash);
  }

  async pay(agent: Address, tinybars: bigint, jobHash: Hex, maxUsd: bigint): Promise<PayResult> {
    const receipt = await this.send("pay", [agent, jobHash, maxUsd], tinybars);
    for (const event of this.events(receipt)) {
      if (event.eventName === "Paid") {
        return {
          id: event.args.id,
          disputeUntil: Number(event.args.disputeUntil),
          usdValue: event.args.usdValue,
          txHash: receipt.transactionHash,
        };
      }
    }
    throw new Error(`Paid event missing from ${receipt.transactionHash}`);
  }

  async dispute(id: bigint, reasonHash: Hex): Promise<DisputeResult> {
    const receipt = await this.send("dispute", [id, reasonHash ?? ZERO_HASH]);
    const payment = await this.getPayment(id);
    return { status: payment.status, refunded: payment.refunded, txHash: receipt.transactionHash };
  }

  private events(receipt: TransactionReceipt) {
    return receipt.logs
      .filter(log => log.address.toLowerCase() === this.address.toLowerCase())
      .flatMap(log => {
        try {
          return [decodeEventLog({ abi: agentBondsAbi, data: log.data, topics: log.topics })];
        } catch {
          return [];
        }
      });
  }

  /**
   * Simulates, then sends with twice the gas estimate: the relay undercounts calls that reach Hedera system
   * contracts (the Schedule Service), and Hedera refunds unused gas above 80% of the limit.
   * `value` is tinybars and is converted to the weibars the JSON-RPC relay expects.
   */
  private async send(
    functionName: "postBond" | "submitReceipt" | "pay" | "dispute",
    args: readonly unknown[],
    tinybars?: bigint,
  ): Promise<TransactionReceipt> {
    const value = tinybars === undefined ? undefined : hbarToWeibars(tinybarsToHbar(tinybars));
    const { request } = await this.publicClient.simulateContract({
      ...this.contract,
      functionName,
      args,
      value,
      account: this.signer,
    } as never);
    const estimate = await this.publicClient.estimateContractGas(request as never);
    const hash = await this.walletClient.writeContract({
      ...(request as object),
      gas: estimate * 2n,
    } as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
    return receipt;
  }
}
