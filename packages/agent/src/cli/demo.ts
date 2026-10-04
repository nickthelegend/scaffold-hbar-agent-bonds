/**
 * Scripted walkthrough, no LLM required. A client hires a bonded agent twice:
 *   1. job A: the agent delivers and posts an honest receipt to HCS  -> released by the Schedule Service
 *   2. job B: the agent posts a bogus receipt; the client disputes   -> clawed back from the agent's bond
 *
 * Usage: yarn agent:demo [--wait]   (--wait polls until the network releases job A's locked bond on its own)
 */
import {
  DISPUTE_TOOL,
  GET_AGENT_TOOL,
  GET_PAYMENT_TOOL,
  LIST_AGENTS_TOOL,
  PAY_AGENT_TOOL,
  SUBMIT_RECEIPT_TOOL,
} from "../plugin";
import { createRuntime } from "../runtime";

const wait = process.argv.includes("--wait");
const step = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m`);
/** Later steps need the payment id, so a failed payment ends the walkthrough instead of cascading. */
const requirePayment = (result: { raw: Record<string, unknown>; humanMessage: string }) => {
  if (result.raw.paymentId === undefined) throw new Error(result.humanMessage);
  return result;
};

const agentSide = await createRuntime("agent");
const clientSide = await createRuntime("client");
const agent = agentSide.address;

try {
  step("0. Client: which agents are bonded, and for how much?");
  console.log((await clientSide.toolkit.run(LIST_AGENTS_TOOL, {})).humanMessage);

  step("1. Client hires the agent for job A, capped at the agreed $2.00");
  const jobA = requirePayment(
    await clientSide.toolkit.run(PAY_AGENT_TOOL, {
      agent,
      amountHbar: process.env.DEMO_JOB_A_HBAR ?? "10",
      job: "Summarise Q3 filings for HBAR treasury holders into a one-page brief.",
      maxUsd: "2",
    }),
  );
  console.log(jobA.humanMessage);

  step("2. Agent delivers job A and posts its receipt to HCS");
  const receiptA = await agentSide.toolkit.run(SUBMIT_RECEIPT_TOOL, {
    paymentId: jobA.raw.paymentId,
    summary: "Delivered a 640-word brief citing 4 filings; sources linked at the end.",
  });
  console.log(receiptA.humanMessage);

  step("3. Client hires the agent for job B");
  const jobB = requirePayment(
    await clientSide.toolkit.run(PAY_AGENT_TOOL, {
      agent,
      amountHbar: process.env.DEMO_JOB_B_HBAR ?? "15",
      job: "Original competitor analysis of three Hedera DEXes, with fresh volume data.",
    }),
  );
  console.log(jobB.humanMessage);

  step("4. The agent cuts corners: its 'delivery' is a pasted blog post");
  console.log(
    (
      await agentSide.toolkit.run(SUBMIT_RECEIPT_TOOL, {
        paymentId: jobB.raw.paymentId,
        summary: "Delivered competitor analysis.",
      })
    ).humanMessage,
  );

  step("5. Client disputes job B: the HBAR comes back from the agent's bond");
  const dispute = await clientSide.toolkit.run(DISPUTE_TOOL, {
    paymentId: jobB.raw.paymentId,
    reason: "The 'analysis' is copied from a 2024 blog post and has no volume data.",
  });
  console.log(dispute.humanMessage);

  step("6. The agent's public record");
  console.log((await clientSide.toolkit.run(GET_AGENT_TOOL, { agent })).humanMessage);

  if (wait && jobA.raw.paymentId) {
    step(`7. Waiting for the network to release job A's locked bond (no keeper involved)…`);
    const deadline = Date.parse(String(jobA.raw.disputeUntil)) + 5 * 60_000;
    for (;;) {
      const payment = await clientSide.toolkit.run(GET_PAYMENT_TOOL, { paymentId: jobA.raw.paymentId });
      console.log(payment.humanMessage);
      if (payment.raw.status !== "open") break;
      if (Date.now() > deadline) {
        console.log("Not released yet: the schedule may have been throttled. Anyone can now call release().");
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 15_000));
    }
  }
} finally {
  agentSide.client.close();
  clientSide.client.close();
}
