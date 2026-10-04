/**
 * Bootstrap a bonded demo agent and a client, in one command:
 *   funds an agent account and a client account, creates the agent's HCS receipt topic (only the agent may
 *   submit), registers the agent in AgentBonds with its bond, and writes packages/agent/.env.
 *
 * Usage: OWNER_PRIVATE_KEY=0x... yarn agent:setup
 * Optional env: AGENT_NAME ("Research Agent"), BOND_HBAR (40), DISPUTE_WINDOW_SECONDS (180), ARBITER (none =
 *   satisfaction guarantee), AGENT_FUND_HBAR (BOND_HBAR + 5), CLIENT_FUND_HBAR (40), BONDS_ADDRESS.
 * Resuming: pass AGENT_PRIVATE_KEY / CLIENT_PRIVATE_KEY and AGENT_FUND_HBAR=0 / CLIENT_FUND_HBAR=0; an already
 *   registered agent is not registered again.
 */
import { Client, PrivateKey, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, getAddress, http, zeroAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentBondsAbi } from "../abi";
import { accountIdForAddress } from "../mirror";
import { NETWORKS, hashscanTopic, hederaChain } from "../network";
import { asHex, bondsAddress, networkFromEnv, requireEnv } from "../runtime";
import { hbarToWeibars } from "../units";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const network = networkFromEnv();
const chain = hederaChain(network, process.env.HEDERA_RPC_URL || undefined);
const env = (name: string, fallback: string) => process.env[name]?.trim() || fallback;
const publicClient = createPublicClient({ chain, transport: http() });

async function confirm(label: string, hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ✓ ${label}  ${NETWORKS[network].hashscan}/transaction/${hash}`);
}

const ownerKey = asHex(requireEnv("OWNER_PRIVATE_KEY"));
const owner = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(ownerKey) });
const bonds = bondsAddress(network);
console.log(`Funding account ${owner.account.address} on ${network}; AgentBonds ${bonds}`);

// 1. Accounts (a plain HBAR transfer to a new EVM address auto-creates the account)
const agentKey = asHex(process.env.AGENT_PRIVATE_KEY?.trim() || generatePrivateKey());
const clientKey = asHex(process.env.CLIENT_PRIVATE_KEY?.trim() || generatePrivateKey());
const agent = privateKeyToAccount(agentKey);
const client = privateKeyToAccount(clientKey);
const bondHbar = env("BOND_HBAR", "40");
for (const [label, to, amount] of [
  ["agent", agent.address, env("AGENT_FUND_HBAR", String(Number(bondHbar) + 5))],
  ["client", client.address, env("CLIENT_FUND_HBAR", "40")],
] as const) {
  if (Number(amount) > 0) {
    await confirm(
      `fund ${label} ${to} with ${amount} HBAR`,
      await owner.sendTransaction({ to, value: hbarToWeibars(amount) }),
    );
  }
}

// 2. Register the agent with its bond and receipt topic (skipped if it already is)
const registered = await publicClient.readContract({
  address: bonds,
  abi: agentBondsAbi,
  functionName: "getAgent",
  args: [agent.address],
});
if (registered.registered) {
  console.log(`  agent already registered (bond ${registered.bond} tinybars)`);
} else {
  const ownerAccountId = await accountIdForAddress(network, owner.account.address);
  const hedera = Client.forName(network).setOperator(
    ownerAccountId,
    PrivateKey.fromStringECDSA(ownerKey.slice(2)),
  );
  const topicReceipt = await (
    await new TopicCreateTransaction()
      .setTopicMemo(`AgentBonds receipts ${agent.address}`)
      .setSubmitKey(PrivateKey.fromStringECDSA(agentKey.slice(2)).publicKey)
      .execute(hedera)
  ).getReceipt(hedera);
  hedera.close();
  const topicId = topicReceipt.topicId!;
  console.log(`  ✓ receipt topic ${topicId}  ${hashscanTopic(network, topicId.toString())}`);

  const agentWallet = createWalletClient({ chain, transport: http(), account: agent });
  const arbiter = process.env.ARBITER?.trim() ? getAddress(process.env.ARBITER.trim()) : zeroAddress;
  const { request } = await publicClient.simulateContract({
    address: bonds,
    abi: agentBondsAbi,
    functionName: "register",
    args: [
      env("AGENT_NAME", "Research Agent"),
      arbiter,
      Number(env("DISPUTE_WINDOW_SECONDS", "180")),
      BigInt(topicId.num.toString()),
    ],
    value: hbarToWeibars(bondHbar),
    account: agent,
  });
  const gas = await publicClient.estimateContractGas(request);
  await confirm(
    `register agent with a ${bondHbar} HBAR bond`,
    await agentWallet.writeContract({ ...request, gas: gas * 2n }),
  );
}

// 3. Env for the demo and chat
writeFileSync(
  join(packageRoot, ".env"),
  [
    `HEDERA_NETWORK=${network}`,
    `BONDS_ADDRESS=${bonds}`,
    `AGENT_PRIVATE_KEY=${agentKey}`,
    `CLIENT_PRIVATE_KEY=${clientKey}`,
    `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ?? ""}`,
    "",
  ].join("\n"),
);
console.log(`\nAgent ${agent.address}  (0.0.x: ${await accountIdForAddress(network, agent.address)})`);
console.log(`Client ${client.address}`);
console.log(`Wrote ${join(packageRoot, ".env")}. Next: yarn agent:demo --wait   (or yarn agent:chat)`);
console.log(`Agent profile: http://localhost:3000/agent/${agent.address}`);
