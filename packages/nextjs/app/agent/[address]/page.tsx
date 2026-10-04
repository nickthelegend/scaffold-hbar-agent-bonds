"use client";

import { use } from "react";
import Link from "next/link";
import { type Address, getAddress, isAddress, zeroAddress } from "viem";
import { useAccount } from "wagmi";
import { HirePanel } from "~~/components/bonds/HirePanel";
import { OperatorPanel } from "~~/components/bonds/OperatorPanel";
import { PaymentsList } from "~~/components/bonds/PaymentsList";
import { HederaAddress } from "~~/components/scaffold-hbar";
import { usePayments, useReceipts } from "~~/hooks/bonds";
import { useScaffoldReadContract, useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { formatDuration, formatHbar, formatUsd } from "~~/utils/bonds/format";

export default function AgentPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  if (!isAddress(address)) {
    return (
      <div className="max-w-3xl mx-auto p-10 text-center">
        <p className="text-lg">“{address}” is not an agent address.</p>
        <Link href="/" className="btn btn-primary btn-sm mt-4">
          Back to the directory
        </Link>
      </div>
    );
  }
  return <AgentProfile agent={getAddress(address)} />;
}

const AgentProfile = ({ agent }: { agent: Address }) => {
  const { address: connected } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const explorer = targetNetwork.blockExplorers?.default.url;
  const { data: info, isLoading } = useScaffoldReadContract({
    contractName: "AgentBonds",
    functionName: "getAgent",
    args: [agent],
  });
  const { data: name } = useScaffoldReadContract({ contractName: "AgentBonds", functionName: "names", args: [agent] });
  const { data: free } = useScaffoldReadContract({
    contractName: "AgentBonds",
    functionName: "freeBond",
    args: [agent],
  });
  const { data: bondQuote } = useScaffoldReadContract({
    contractName: "AgentBonds",
    functionName: "quoteUsd",
    args: [info?.bond ?? 0n],
  });
  const { payments, isLoading: paymentsLoading, error } = usePayments(agent);
  const { receipts, topicId } = useReceipts(info?.receiptTopic);

  if (isLoading)
    return (
      <div className="max-w-5xl mx-auto w-full p-8">
        <div className="h-48 rounded-box bg-base-200 animate-pulse" />
      </div>
    );
  if (!info?.registered) {
    return (
      <div className="max-w-3xl mx-auto p-10 text-center space-y-4">
        <p className="text-lg m-0">
          {agent} is not a registered agent on {targetNetwork.name}.
        </p>
        <Link href="/register" className="btn btn-primary btn-sm">
          Register it
        </Link>
      </div>
    );
  }

  const isOperator = connected?.toLowerCase() === agent.toLowerCase();
  const guaranteed = info.arbiter === zeroAddress;
  const clawedBack = payments.filter(p => p.state === "refunded").reduce((sum, p) => sum + (p.refunded ?? 0n), 0n);

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-8 space-y-8">
      <section className="rounded-box bg-base-100 border border-base-300 p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wider text-base-content/60 m-0">Bonded agent</p>
            <h1 className="text-3xl font-bold m-0">{name || "Unnamed agent"}</h1>
            <HederaAddress address={agent} chain={targetNetwork} />
            {isOperator && <span className="badge badge-primary badge-sm">you operate this agent</span>}
          </div>
          <div className="text-right space-y-1">
            <p className="text-xs uppercase tracking-wider text-base-content/60 m-0">Coverage available</p>
            <p className="text-3xl font-bold tabular-nums m-0">{formatHbar(free, 2)}</p>
            <p className="text-sm text-base-content/60 m-0 tabular-nums">
              of a {formatHbar(info.bond, 2)} bond{bondQuote?.[0] ? ` (≈ ${formatUsd(bondQuote[1])})` : ""}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <Stat label="Dispute window" value={formatDuration(info.disputeWindow)} />
          <Stat label="Disputes go to" value={guaranteed ? "Instant refund (guarantee)" : "Arbiter"} />
          <Stat label="Locked by open payments" value={formatHbar(info.locked, 2)} />
          <Stat label="Record" value={`${info.payments} paid · ${info.clawbacks} clawed back`} />
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          {!guaranteed && (
            <span className="flex items-center gap-2">
              Arbiter <HederaAddress address={info.arbiter} chain={targetNetwork} />
            </span>
          )}
          {topicId ? (
            <a className="link" href={`${explorer}/topic/${topicId}`} target="_blank" rel="noreferrer">
              Work receipts: HCS topic {topicId}
            </a>
          ) : (
            <span className="text-base-content/60">No receipt topic</span>
          )}
          {clawedBack > 0n && <span className="text-error">{formatHbar(clawedBack, 2)} clawed back so far</span>}
        </div>
      </section>

      {isOperator ? (
        <section className="rounded-box bg-base-100 border border-base-300 p-6 space-y-4">
          <h2 className="text-xl font-bold m-0">Manage your bond</h2>
          <OperatorPanel
            freeBond={free}
            pendingWithdrawal={info.pendingWithdrawal}
            withdrawableAt={Number(info.withdrawableAt)}
          />
        </section>
      ) : (
        <section className="rounded-box bg-base-100 border border-base-300 p-6 space-y-4">
          <div>
            <h2 className="text-xl font-bold m-0">Hire {name || "this agent"}</h2>
            <p className="text-sm text-base-content/60 m-0">
              Paid instantly; fully refundable from the bond for {formatDuration(info.disputeWindow)}.
            </p>
          </div>
          {connected ? (
            <HirePanel agent={agent} freeBond={free} />
          ) : (
            <p className="text-sm m-0">Connect a wallet to hire this agent.</p>
          )}
        </section>
      )}

      <section className="space-y-4">
        <h2 className="text-xl font-bold m-0">Payments</h2>
        {error && <div className="alert alert-warning text-sm">Mirror node unavailable: {String(error)}</div>}
        <PaymentsList payments={payments} receipts={receipts} arbiter={info.arbiter} isLoading={paymentsLoading} />
      </section>
    </div>
  );
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div>
    <p className="text-[11px] uppercase tracking-wider text-base-content/60 m-0">{label}</p>
    <p className="font-semibold m-0">{value}</p>
  </div>
);
