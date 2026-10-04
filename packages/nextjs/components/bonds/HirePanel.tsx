"use client";

import { useState } from "react";
import { hashJob } from "@sh/agent/messages";
import { parseEther, parseUnits } from "viem";
import { useBondsWrite } from "~~/hooks/bonds";
import { useScaffoldReadContract } from "~~/hooks/scaffold-hbar";
import { formatHbar, formatUsd } from "~~/utils/bonds/format";
import { notification } from "~~/utils/scaffold-hbar";

/** Pays an agent for a job. The agent is paid instantly; the amount stays refundable from its bond. */
export const HirePanel = ({ agent, freeBond }: { agent: string; freeBond?: bigint }) => {
  const [amount, setAmount] = useState("10");
  const [job, setJob] = useState("");
  const [maxUsd, setMaxUsd] = useState("");
  const { write, isPending } = useBondsWrite();

  const valid = /^\d+(\.\d{1,8})?$/.test(amount) && Number(amount) > 0;
  const tinybars = valid ? parseUnits(amount, 8) : 0n;
  const { data: quote, isLoading: quoteLoading } = useScaffoldReadContract({
    contractName: "AgentBonds",
    functionName: "quoteUsd",
    args: [tinybars],
  });
  const covered = freeBond === undefined || tinybars <= freeBond;

  const hire = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!job.trim()) return notification.error("Describe the job; its hash is stored with the payment");
    const hash = await write(
      "pay",
      [agent, hashJob(job), maxUsd ? parseUnits(maxUsd, 6) : 0n],
      // The relay takes value in weibars (18 decimals); the contract sees tinybars.
      parseEther(amount),
    );
    if (hash) setJob("");
  };

  return (
    <form onSubmit={hire} className="space-y-3">
      <label className="form-control">
        <span className="label-text text-xs font-semibold">Job</span>
        <textarea
          className="textarea textarea-bordered textarea-sm w-full"
          rows={3}
          placeholder="What exactly are you paying for? Its hash is stored with the payment."
          value={job}
          onChange={event => setJob(event.target.value)}
        />
      </label>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="form-control">
          <span className="label-text text-xs font-semibold">Amount</span>
          <div className="join w-full">
            <input
              className="input input-sm input-bordered join-item w-full tabular-nums"
              inputMode="decimal"
              value={amount}
              onChange={event => setAmount(event.target.value)}
            />
            <span className="join-item btn btn-sm btn-disabled no-animation">ℏ</span>
          </div>
          <span className="text-[11px] text-base-content/60 mt-1">
            {quote?.[0]
              ? `≈ ${formatUsd(quote[1])} at the Chainlink price`
              : quoteLoading
                ? "Pricing with Chainlink…"
                : "No fresh Chainlink price"}
          </span>
        </label>
        <label className="form-control">
          <span className="label-text text-xs font-semibold">Agreed price cap (optional)</span>
          <div className="join w-full">
            <input
              className="input input-sm input-bordered join-item w-full tabular-nums"
              inputMode="decimal"
              placeholder="e.g. 2.00"
              value={maxUsd}
              onChange={event => setMaxUsd(event.target.value)}
            />
            <span className="join-item btn btn-sm btn-disabled no-animation">USD</span>
          </div>
          <span className="text-[11px] text-base-content/60 mt-1">Reverts if the HBAR is worth more than this</span>
        </label>
      </div>
      {!covered && (
        <p className="text-sm text-error m-0">
          The agent&apos;s free bond ({formatHbar(freeBond)}) can&apos;t cover this payment, so the contract will refuse
          it.
        </p>
      )}
      <button className="btn btn-primary btn-sm" disabled={isPending || !valid || !covered}>
        {isPending ? <span className="loading loading-spinner loading-xs" /> : `Pay ${amount || 0} ℏ`}
      </button>
    </form>
  );
};
