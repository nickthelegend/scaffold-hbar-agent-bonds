import { AgentMode } from "@hashgraph/hedera-agent-kit";
import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RpcBondsGateway } from "./bonds";
import { ClaudeHederaToolkit } from "./claude-toolkit";
import { HcsPublisher } from "./hcs";
import { accountIdForAddress } from "./mirror";
import { NETWORKS, type HederaNetwork } from "./network";
import { createAgentBondsPlugin } from "./plugin";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: join(packageRoot, ".env") });

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy packages/agent/.env.example to packages/agent/.env (or run \`yarn agent:setup\`).`,
    );
  }
  return value;
}

export const asHex = (key: string): Hex => (key.startsWith("0x") ? key : `0x${key}`) as Hex;

export const networkFromEnv = (): HederaNetwork => (process.env.HEDERA_NETWORK ?? "testnet") as HederaNetwork;

/** AgentBonds address: BONDS_ADDRESS, or the deployment record written by `yarn foundry:deploy`. */
export function bondsAddress(network = networkFromEnv()): Address {
  if (process.env.BONDS_ADDRESS?.trim()) return getAddress(process.env.BONDS_ADDRESS.trim());
  const file = join(packageRoot, "..", "foundry", "deployments", `${NETWORKS[network].chainId}.json`);
  if (existsSync(file)) {
    const match = Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, string>).find(
      ([, name]) => name === "AgentBonds",
    );
    if (match) return getAddress(match[0]);
  }
  throw new Error(`No AgentBonds deployment for ${network}; deploy it or set BONDS_ADDRESS`);
}

export type Role = "agent" | "client";

export type BondsRuntime = {
  network: HederaNetwork;
  address: Address;
  bonds: RpcBondsGateway;
  toolkit: ClaudeHederaToolkit;
  client: Client;
};

/** Wires a key (the agent's or the client's), AgentBonds and the plugin from packages/agent/.env. */
export async function createRuntime(role: Role): Promise<BondsRuntime> {
  const network = networkFromEnv();
  const privateKey = asHex(requireEnv(role === "agent" ? "AGENT_PRIVATE_KEY" : "CLIENT_PRIVATE_KEY"));
  const account = privateKeyToAccount(privateKey);
  const accountId = await accountIdForAddress(network, account.address);

  const client = Client.forName(network).setOperator(
    accountId,
    PrivateKey.fromStringECDSA(privateKey.slice(2)),
  );
  const bonds = new RpcBondsGateway(
    bondsAddress(network),
    account,
    network,
    process.env.HEDERA_RPC_URL || undefined,
  );
  const toolkit = new ClaudeHederaToolkit({
    client,
    configuration: {
      plugins: [createAgentBondsPlugin({ bonds, network, publisher: new HcsPublisher(client) })],
      context: { mode: AgentMode.AUTONOMOUS, accountId },
    },
  });

  return { network, address: account.address, bonds, toolkit, client };
}
