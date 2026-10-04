"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { isAddress, parseEther, zeroAddress } from "viem";
import { useAccount } from "wagmi";
import { useBondsWrite } from "~~/hooks/bonds";
import { notification } from "~~/utils/scaffold-hbar";

/** Registers the connected account as a bonded agent. */
export default function RegisterPage() {
  const { address } = useAccount();
  const router = useRouter();
  const { write, isPending } = useBondsWrite();
  const [name, setName] = useState("");
  const [bond, setBond] = useState("40");
  const [windowMinutes, setWindowMinutes] = useState("60");
  const [arbiter, setArbiter] = useState("");
  const [topic, setTopic] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return notification.error("Give your agent a name");
    if (arbiter && !isAddress(arbiter)) return notification.error("Arbiter must be an EVM address, or empty");
    const topicMatch = topic.trim().match(/^(?:0\.0\.)?(\d+)$/);
    if (topic.trim() && !topicMatch) return notification.error("Receipt topic must look like 0.0.12345");
    const seconds = Math.round(Number(windowMinutes) * 60);
    if (!Number.isFinite(seconds) || seconds < 60)
      return notification.error("Dispute window must be at least 1 minute");

    const hash = await write(
      "register",
      [name.trim(), arbiter || zeroAddress, seconds, topicMatch ? BigInt(topicMatch[1]) : 0n],
      parseEther(bond || "0"),
    );
    if (hash && address) router.push(`/agent/${address}`);
  };

  return (
    <div className="w-full max-w-2xl mx-auto px-4 py-10 space-y-6">
      <div>
        <h1 className="text-3xl font-bold m-0">Register a bonded agent</h1>
        <p className="text-base-content/70 m-0">
          The connected account becomes the agent. Its bond caps how much clients can pay it at once, because every
          payment must be fully refundable.
        </p>
      </div>
      {!address ? (
        <p>Connect the wallet your agent signs with.</p>
      ) : (
        <form onSubmit={submit} className="space-y-4 rounded-box bg-base-100 border border-base-300 p-6">
          <Field label="Agent name" hint="Shown in the directory">
            <input
              className="input input-sm input-bordered w-full"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </Field>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Initial bond (ℏ)" hint="You can add more later">
              <input
                className="input input-sm input-bordered w-full tabular-nums"
                inputMode="decimal"
                value={bond}
                onChange={e => setBond(e.target.value)}
              />
            </Field>
            <Field label="Dispute window (minutes)" hint="How long each payment stays refundable">
              <input
                className="input input-sm input-bordered w-full tabular-nums"
                inputMode="numeric"
                value={windowMinutes}
                onChange={e => setWindowMinutes(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Arbiter (optional)"
            hint="Empty = satisfaction guarantee: any dispute refunds the client at once"
          >
            <input
              className="input input-sm input-bordered w-full font-mono"
              placeholder="0x…"
              value={arbiter}
              onChange={e => setArbiter(e.target.value.trim())}
            />
          </Field>
          <Field
            label="HCS receipt topic (optional)"
            hint={
              <>
                Where you publish work receipts; <code className="font-mono">yarn agent:setup</code> creates one
              </>
            }
          >
            <input
              className="input input-sm input-bordered w-full font-mono"
              placeholder="0.0.12345"
              value={topic}
              onChange={e => setTopic(e.target.value)}
            />
          </Field>
          <button className="btn btn-primary btn-sm" disabled={isPending}>
            {isPending ? <span className="loading loading-spinner loading-xs" /> : "Register and post bond"}
          </button>
        </form>
      )}
    </div>
  );
}

const Field = ({ label, hint, children }: { label: string; hint: React.ReactNode; children: React.ReactNode }) => (
  <label className="form-control">
    <span className="label-text text-xs font-semibold">{label}</span>
    {children}
    <span className="text-[11px] text-base-content/60 mt-1">{hint}</span>
  </label>
);
