import { useEffect, useState } from "react";
import { topicIdFromNumber } from "@sh/agent/mirror";
import { useQuery } from "@tanstack/react-query";
import type { Abi, Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { useDeployedContractInfo, useTargetNetwork, useTransactor } from "~~/hooks/scaffold-hbar";
import { fetchPayments, fetchReceipts } from "~~/utils/bonds/activity";

const POLL_MS = 8_000;

const chainlinkFeedAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const satisfies Abi;

export function useHbarUsdPrice(feed: Address | undefined) {
  const { targetNetwork } = useTargetNetwork();
  const now = useNow(30_000);
  const round = useReadContract({
    address: feed,
    abi: chainlinkFeedAbi,
    functionName: "latestRoundData",
    chainId: targetNetwork.id,
    query: { enabled: Boolean(feed), refetchInterval: 30_000 },
  });
  const decimals = useReadContract({
    address: feed,
    abi: chainlinkFeedAbi,
    functionName: "decimals",
    chainId: targetNetwork.id,
    query: { enabled: Boolean(feed) },
  });
  if (!round.data || decimals.data === undefined) return undefined;
  const updatedAt = Number(round.data[3]);
  return {
    price: Number(round.data[1]) / 10 ** decimals.data,
    updatedAt,
    ageSeconds: Math.max(0, Math.floor(now / 1000) - updatedAt),
  };
}

/** Every AgentBonds payment, decoded from the mirror node (optionally only one agent's). */
export function usePayments(agent?: Address) {
  const { targetNetwork } = useTargetNetwork();
  const { data: contract } = useDeployedContractInfo({ contractName: "AgentBonds" });
  const query = useQuery({
    queryKey: ["bonds-payments", targetNetwork.id, contract?.address],
    queryFn: () => fetchPayments(targetNetwork.id, contract!.address as Address),
    enabled: Boolean(contract),
    refetchInterval: POLL_MS,
  });
  const payments = agent
    ? (query.data ?? []).filter(p => p.agent.toLowerCase() === agent.toLowerCase())
    : (query.data ?? []);
  return { payments, isLoading: query.isLoading, error: query.error };
}

/** Receipts an agent published to its HCS topic, keyed by the hash recorded on-chain. */
export function useReceipts(receiptTopic: bigint | undefined) {
  const { targetNetwork } = useTargetNetwork();
  const topicId = receiptTopic !== undefined ? (topicIdFromNumber(receiptTopic) ?? undefined) : undefined;
  const query = useQuery({
    queryKey: ["bonds-receipts", targetNetwork.id, topicId],
    queryFn: () => fetchReceipts(targetNetwork.id, topicId!),
    enabled: Boolean(topicId),
    refetchInterval: POLL_MS,
  });
  return { receipts: query.data, topicId, isLoading: query.isLoading };
}

/**
 * The relay's eth_estimateGas undercounts calls that reach Hedera system contracts (the Schedule Service), so
 * AgentBonds writes send twice the estimate.
 */
export const GAS_ESTIMATE_MULTIPLIER = 2n;

type BondsFunction =
  | "register"
  | "postBond"
  | "requestWithdrawal"
  | "cancelWithdrawal"
  | "withdrawBond"
  | "pay"
  | "dispute"
  | "resolve"
  | "resolveExpired"
  | "release";

/** Writes to AgentBonds with the scaffold's notifications; `value` is in weibars, as the relay expects. */
export function useBondsWrite() {
  const { data: contract } = useDeployedContractInfo({ contractName: "AgentBonds" });
  const { writeContractAsync, isPending } = useWriteContract();
  const transactor = useTransactor();
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const { address: account } = useAccount();

  /** Resolves to the tx hash, or undefined if the user rejected or it failed (already shown as a notification). */
  const write = async (functionName: BondsFunction, args: readonly unknown[], value?: bigint) => {
    if (!contract || !publicClient) return undefined;
    const call = { address: contract.address, abi: contract.abi, functionName, args, value } as never;
    try {
      return await transactor(async () => {
        const estimate = await publicClient.estimateContractGas({ ...(call as object), account } as never);
        return writeContractAsync({
          ...(call as object),
          chainId: targetNetwork.id,
          gas: estimate * GAS_ESTIMATE_MULTIPLIER,
        } as never);
      });
    } catch {
      return undefined;
    }
  };

  return { write, isPending };
}

/** Wall-clock time that re-renders every `intervalMs`, for countdowns and freshness labels. */
export function useNow(intervalMs = 1_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
