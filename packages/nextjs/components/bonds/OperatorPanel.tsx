"use client";

import { useState } from "react";
import { parseEther, parseUnits } from "viem";
import { useBondsWrite, useNow } from "~~/hooks/bonds";
import { formatDuration, formatHbar } from "~~/utils/bonds/format";

/** Bond management for the agent's own operator: top up, and the delayed withdrawal flow. */
export const OperatorPanel = ({
  freeBond,
  pendingWithdrawal,
  withdrawableAt,
}: {
  freeBond?: bigint;
  pendingWithdrawal: bigint;
  withdrawableAt: number;
}) => {
  const [topUp, setTopUp] = useState("10");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const { write, isPending } = useBondsWrite();
  const now = Math.floor(useNow() / 1000);
  const waitLeft = withdrawableAt - now;
  const isAmount = (value: string) => /^\d+(\.\d{1,8})?$/.test(value) && Number(value) > 0;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wider text-base-content/60 m-0">Add to bond</p>
        <div className="join w-full">
          <input
            className="input input-sm input-bordered join-item w-full tabular-nums"
            inputMode="decimal"
            value={topUp}
            onChange={event => setTopUp(event.target.value)}
          />
          <button
            className="btn btn-sm btn-primary join-item"
            disabled={isPending || !isAmount(topUp)}
            onClick={() => write("postBond", [], parseEther(topUp))}
          >
            Post ℏ
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wider text-base-content/60 m-0">
          Withdraw free bond ({formatHbar(freeBond)} free)
        </p>
        {pendingWithdrawal > 0n ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>
              {formatHbar(pendingWithdrawal)} {waitLeft > 0 ? `unlocks in ${formatDuration(waitLeft)}` : "ready"}
            </span>
            <button
              className="btn btn-sm"
              disabled={isPending || waitLeft > 0}
              onClick={() => write("withdrawBond", [])}
            >
              Withdraw
            </button>
            <button className="btn btn-sm btn-ghost" disabled={isPending} onClick={() => write("cancelWithdrawal", [])}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="join w-full">
            <input
              className="input input-sm input-bordered join-item w-full tabular-nums"
              inputMode="decimal"
              placeholder="HBAR"
              value={withdrawAmount}
              onChange={event => setWithdrawAmount(event.target.value)}
            />
            <button
              className="btn btn-sm join-item"
              disabled={isPending || !isAmount(withdrawAmount)}
              onClick={() => write("requestWithdrawal", [parseUnits(withdrawAmount, 8)])}
            >
              Request
            </button>
          </div>
        )}
        <p className="text-[11px] text-base-content/60 m-0">
          Withdrawals wait one dispute window, so clients who checked your bond before paying stay covered.
        </p>
      </div>
    </div>
  );
};
