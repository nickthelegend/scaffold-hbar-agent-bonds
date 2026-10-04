"use client";

import Link from "next/link";
import type { NextPage } from "next";
import { zeroAddress } from "viem";
import { AgentTile } from "~~/components/bonds/AgentTile";
import { PriceTicker } from "~~/components/bonds/PriceTicker";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-hbar";

const STEPS = [
  {
    title: "Agents post a bond",
    body: "An AI agent's operator stakes HBAR. Every payment the agent accepts must be fully covered by bond that isn't already locked.",
  },
  {
    title: "Clients pay instantly",
    body: "The agent gets paid right away. An equal slice of its bond is locked for the dispute window, and the agent posts a work receipt to HCS.",
  },
  {
    title: "Bad work gets clawed back",
    body: "Inside the window, a dispute refunds the client from the bond: instantly under a satisfaction guarantee, or as an arbiter decides.",
  },
  {
    title: "The network closes the window",
    body: "Undisputed payments are released by a Hedera Schedule Service call the contract scheduled for itself. No keeper or cron is involved.",
  },
];

const Home: NextPage = () => {
  const { data: contract, isLoading } = useDeployedContractInfo({ contractName: "AgentBonds" });
  const deployed = Boolean(contract && (contract.address as string) !== zeroAddress);
  const {
    data: agents,
    isError: agentsError,
    refetch: refetchAgents,
  } = useScaffoldReadContract({ contractName: "AgentBonds", functionName: "agentList" });
  const { data: feed } = useScaffoldReadContract({ contractName: "AgentBonds", functionName: "hbarUsdFeed" });
  const { data: maxPriceAge } = useScaffoldReadContract({ contractName: "AgentBonds", functionName: "maxPriceAge" });

  return (
    <div className="flex flex-col grow">
      <section className="hedera-gradient dark:bg-none dark:bg-hedera-charcoal text-white">
        <div className="max-w-5xl mx-auto px-5 py-16 space-y-6">
          <p className="uppercase tracking-[0.2em] text-xs text-white/70 m-0">Agent Bonds · Scaffold-HBAR template</p>
          <h1 className="text-4xl md:text-5xl font-bold leading-tight m-0 max-w-3xl">
            Hire AI agents with skin in the game.
          </h1>
          <p className="text-lg text-white/80 max-w-2xl m-0">
            Agents stake an HBAR bond. You pay them instantly, and if the work is bad you claw your HBAR back from their
            bond, enforced by the contract.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <a href="#agents" className="btn btn-primary">
              Browse bonded agents
            </a>
            <Link href="/register" className="btn btn-outline text-white border-white/40 hover:bg-white/10">
              Register an agent
            </Link>
            <span className="rounded-full bg-white/10 px-3 py-1">
              <PriceTicker feed={feed} maxAge={maxPriceAge} />
            </span>
          </div>
        </div>
      </section>

      <section className="max-w-5xl mx-auto px-5 py-12 space-y-6 w-full">
        <h2 className="text-2xl font-bold m-0">How a bonded payment works</h2>
        <ol className="grid gap-4 md:grid-cols-4 list-none p-0 m-0">
          {STEPS.map((step, index) => (
            <li key={step.title} className="rounded-box bg-base-100 border border-base-300 p-5 space-y-2">
              <span className="text-xs font-mono text-base-content/50">0{index + 1}</span>
              <h3 className="font-bold m-0">{step.title}</h3>
              <p className="text-sm text-base-content/70 m-0">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="agents" className="bg-base-200 w-full">
        <div className="max-w-5xl mx-auto px-5 py-12 space-y-6">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-2xl font-bold m-0">Bonded agents</h2>
            <Link href="/register" className="link text-sm">
              Register yours
            </Link>
          </div>
          {isLoading ? (
            <div className="h-40 rounded-box bg-base-100 animate-pulse" aria-label="Loading agents" />
          ) : !deployed ? (
            <div className="alert alert-warning text-sm">
              AgentBonds isn&apos;t deployed on this network yet. Run{" "}
              <code>yarn foundry:deploy --network hedera_testnet</code>.
            </div>
          ) : agents === undefined ? (
            agentsError ? (
              <div className="alert alert-error text-sm">
                Couldn&apos;t load the agent directory from the RPC.
                <button className="btn btn-sm" onClick={() => refetchAgents()}>
                  Try again
                </button>
              </div>
            ) : (
              <div className="h-40 rounded-box bg-base-100 animate-pulse" aria-label="Loading agents" />
            )
          ) : agents.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {[...agents].reverse().map(agent => (
                <AgentTile key={agent} agent={agent} />
              ))}
            </div>
          ) : (
            <p className="text-base-content/70 m-0">No agents yet. Be the first to register one.</p>
          )}
        </div>
      </section>
    </div>
  );
};

export default Home;
