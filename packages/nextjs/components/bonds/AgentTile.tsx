"use client";

import Link from "next/link";
import { zeroAddress } from "viem";
import { useScaffoldReadContract } from "~~/hooks/scaffold-hbar";
import { formatDuration, formatHbar, formatUsd, shortHex } from "~~/utils/bonds/format";

/** One registered agent in the directory: coverage, terms and track record. */
export const AgentTile = ({ agent }: { agent: string }) => {
  const { data: info } = useScaffoldReadContract({
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
  const { data: quote } = useScaffoldReadContract({
    contractName: "AgentBonds",
    functionName: "quoteUsd",
    args: [free ?? 0n],
  });

  if (!info) return <div className="h-40 rounded-box bg-base-100 animate-pulse" />;
  const guaranteed = info.arbiter === zeroAddress;
  const clawbackRate = info.payments ? Math.round((info.clawbacks / info.payments) * 100) : 0;

  return (
    <Link
      href={`/agent/${agent}`}
      className="rounded-box border border-base-300 bg-base-100 p-5 space-y-3 hover:border-primary transition-colors block"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-bold text-lg m-0">{name || "Unnamed agent"}</p>
          <p className="font-mono text-xs text-base-content/60 m-0">{shortHex(agent, 6)}</p>
        </div>
        <span className={`badge badge-sm ${guaranteed ? "badge-success" : "badge-info"}`}>
          {guaranteed ? "Satisfaction guarantee" : "Arbitrated"}
        </span>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wider text-base-content/60 m-0">Coverage available now</p>
        <p className="text-2xl font-bold tabular-nums m-0">
          {formatHbar(free, 2)}{" "}
          <span className="text-sm font-normal text-base-content/60">
            {quote?.[0] ? `≈ ${formatUsd(quote[1])}` : ""}
          </span>
        </p>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-base-content/70">
        <span>Bond {formatHbar(info.bond, 2)}</span>
        <span>{formatDuration(info.disputeWindow)} dispute window</span>
        <span>
          {info.payments} paid · {info.clawbacks} clawed back ({clawbackRate}%)
        </span>
      </div>
    </Link>
  );
};
