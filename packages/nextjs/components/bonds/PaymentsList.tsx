"use client";

import { useState } from "react";
import { hashMessage } from "@sh/agent/messages";
import type { Hex } from "viem";
import { useAccount } from "wagmi";
import { useBondsWrite, useNow } from "~~/hooks/bonds";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { type PaymentOutcome, type PaymentRow, type ReceiptRecord, paymentOutcome } from "~~/utils/bonds/activity";
import { entityIdFromAddress, formatDuration, formatHbar, formatUsd, shortHex } from "~~/utils/bonds/format";

const TONE_CLASS: Record<PaymentOutcome["tone"], string> = {
  warning: "badge-warning",
  info: "badge-info",
  success: "badge-success",
  error: "badge-error",
};

export const PaymentsList = ({
  payments,
  receipts,
  receiptsLoading,
  arbiter,
  isLoading,
}: {
  payments: PaymentRow[];
  receipts?: Map<Hex, ReceiptRecord>;
  /** True while the agent's HCS topic is still being fetched. */
  receiptsLoading: boolean;
  arbiter?: string;
  isLoading: boolean;
}) => {
  if (isLoading) return <div className="h-32 rounded-box bg-base-200 animate-pulse" />;
  if (payments.length === 0) {
    return (
      <div className="rounded-box border border-dashed border-base-300 p-8 text-center text-sm text-base-content/60">
        No payments yet. Hire this agent above, or run <code className="font-mono">yarn agent:demo</code>.
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {payments.map(payment => (
        <PaymentItem
          key={payment.id.toString()}
          payment={payment}
          receipt={payment.receiptHash ? receipts?.get(payment.receiptHash) : undefined}
          receiptsLoading={receiptsLoading}
          arbiter={arbiter}
        />
      ))}
    </ul>
  );
};

const PaymentItem = ({
  payment,
  receipt,
  receiptsLoading,
  arbiter,
}: {
  payment: PaymentRow;
  receipt?: ReceiptRecord;
  receiptsLoading: boolean;
  arbiter?: string;
}) => {
  const { address } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const explorer = targetNetwork.blockExplorers?.default.url;
  const now = Math.floor(useNow() / 1000);
  const { write, isPending } = useBondsWrite();
  const [reason, setReason] = useState("");
  const [refundPct, setRefundPct] = useState(100);

  const me = address?.toLowerCase();
  const isClient = me === payment.client.toLowerCase();
  const isArbiter = Boolean(arbiter && me === arbiter.toLowerCase());
  const windowLeft = payment.disputeUntil - now;
  const canDispute = isClient && payment.state === "open" && windowLeft > 0;
  const canRelease = payment.state === "open" && windowLeft <= 0;
  const arbitrationExpired =
    payment.state === "disputed" && payment.arbitrationDeadline !== undefined && now >= payment.arbitrationDeadline;
  const outcome = paymentOutcome(payment);
  // A guarantee clawback disputes and refunds in one transaction; arbitrated disputes have their own.
  const separateDisputeTx = payment.disputeTx && payment.disputeTx !== payment.settledTx;

  return (
    <li className="rounded-box border border-base-300 bg-base-100 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-mono text-xs text-base-content/60">#{payment.id.toString()}</span>
        <span className="font-semibold tabular-nums">{formatHbar(payment.amount)}</span>
        <span className="text-sm text-base-content/70 tabular-nums">
          {payment.usdValue > 0n ? formatUsd(payment.usdValue) : "no price recorded"}
        </span>
        <span className="text-sm">
          from <span className="font-mono">{shortHex(payment.client)}</span>
          {isClient && <span className="badge badge-ghost badge-xs ml-1">you</span>}
        </span>
        <span className={`badge badge-sm ml-auto ${TONE_CLASS[outcome.tone]}`}>{outcome.label}</span>
      </div>

      <div className="text-sm">
        {receipt ? (
          <p className="m-0">
            <span className="text-base-content/60">Agent&apos;s receipt: </span>“{receipt.summary}”{" "}
            <span
              className="badge badge-ghost badge-sm"
              title="keccak256 of this HCS message equals the receiptHash recorded on-chain"
            >
              ✓ verified on HCS #{receipt.sequenceNumber}
            </span>
          </p>
        ) : (
          <p className="m-0 text-base-content/60">
            {!payment.receiptHash
              ? payment.state === "open"
                ? "No receipt yet."
                : "No receipt posted."
              : receiptsLoading
                ? "Checking the receipt on HCS…"
                : "Receipt recorded on-chain; its HCS message isn't indexed yet."}
          </p>
        )}
        {payment.state === "refunded" && payment.refunded !== undefined && (
          <p className="m-0 text-error font-medium">
            {formatHbar(payment.refunded)} returned to the client from the agent&apos;s bond
            {payment.refunded < payment.amount
              ? `; the arbiter let the agent keep ${formatHbar(payment.amount - payment.refunded)}.`
              : "."}
          </p>
        )}
        {payment.state === "released" && payment.arbitrated && (
          <p className="m-0 text-success font-medium">The arbiter ruled for the agent; nothing was refunded.</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <a className="link" href={`${explorer}/transaction/${payment.payTx}`} target="_blank" rel="noreferrer">
          payment tx
        </a>
        {payment.receiptTx && (
          <a className="link" href={`${explorer}/transaction/${payment.receiptTx}`} target="_blank" rel="noreferrer">
            receipt tx
          </a>
        )}
        {separateDisputeTx && (
          <a className="link" href={`${explorer}/transaction/${payment.disputeTx}`} target="_blank" rel="noreferrer">
            dispute tx
          </a>
        )}
        {payment.settledTx && (
          <a className="link" href={`${explorer}/transaction/${payment.settledTx}`} target="_blank" rel="noreferrer">
            {outcome.settledLabel}
          </a>
        )}
        {payment.schedule && (
          <a
            className="link"
            href={`${explorer}/schedule/${entityIdFromAddress(payment.schedule)}`}
            target="_blank"
            rel="noreferrer"
          >
            Hedera schedule {entityIdFromAddress(payment.schedule)}
          </a>
        )}
        {payment.state === "open" && windowLeft > 0 && (
          <span className="font-semibold text-warning tabular-nums">
            refundable for {formatDuration(windowLeft)}
            {payment.schedule ? ", then released by the Hedera Schedule Service" : ""}
          </span>
        )}
        {canRelease && (
          <button
            className="btn btn-outline btn-xs ml-auto"
            disabled={isPending}
            onClick={() => write("release", [payment.id])}
          >
            Release now
          </button>
        )}
        {arbitrationExpired && (
          <button
            className="btn btn-outline btn-xs ml-auto"
            disabled={isPending}
            title="The arbiter missed its deadline; anyone can refund the client in full"
            onClick={() => write("resolveExpired", [payment.id])}
          >
            Refund (arbiter timed out)
          </button>
        )}
      </div>

      {canDispute && (
        <form
          className="join w-full"
          onSubmit={async event => {
            event.preventDefault();
            if (await write("dispute", [payment.id, hashMessage(reason.trim())])) setReason("");
          }}
        >
          <input
            className="input input-sm input-bordered join-item w-full"
            placeholder="What did the agent get wrong?"
            value={reason}
            onChange={event => setReason(event.target.value)}
            required
          />
          <button className="btn btn-sm btn-error join-item" disabled={isPending || !reason.trim()}>
            Claw back
          </button>
        </form>
      )}

      {isArbiter && payment.state === "disputed" && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            className="range range-xs w-48"
            value={refundPct}
            onChange={event => setRefundPct(Number(event.target.value))}
            aria-label="Refund percentage"
          />
          <span className="text-sm tabular-nums">Refund {refundPct}%</span>
          <button
            className="btn btn-sm btn-primary"
            disabled={isPending}
            onClick={() => write("resolve", [payment.id, BigInt(refundPct * 100)])}
          >
            Resolve dispute
          </button>
        </div>
      )}
    </li>
  );
};
