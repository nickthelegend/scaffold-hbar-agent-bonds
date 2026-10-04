import { AbstractPolicy, type PostParamsNormalizationParams } from "@hashgraph/hedera-agent-kit";
import { Client } from "@hiero-ledger/sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ClaudeHederaToolkit } from "../src/claude-toolkit";
import { hashJob, hashMessage } from "../src/messages";
import {
  createAgentBondsPlugin,
  DISPUTE_TOOL,
  GET_AGENT_TOOL,
  GET_PAYMENT_TOOL,
  LIST_AGENTS_TOOL,
  PAY_AGENT_TOOL,
  POST_BOND_TOOL,
  SUBMIT_RECEIPT_TOOL,
  type BondsDeps,
} from "../src/plugin";
import { hbarToTinybars } from "../src/units";
import { AGENT, FakeBonds, FakePublisher } from "./fakes";

const client = Client.forTestnet();
afterAll(() => client.close());

let bonds: FakeBonds;
let publisher: FakePublisher;

const toolkit = (deps: Partial<BondsDeps> = {}, hooks: AbstractPolicy[] = []) =>
  new ClaudeHederaToolkit({
    client,
    configuration: {
      plugins: [
        createAgentBondsPlugin({
          bonds,
          network: "testnet",
          publisher,
          now: () => 1_790_000_000_000,
          ...deps,
        }),
      ],
      context: { hooks },
    },
  });

beforeEach(() => {
  bonds = new FakeBonds();
  publisher = new FakePublisher();
});

describe("client tools", () => {
  it("lists bonded agents with USD coverage and their record", async () => {
    const result = await toolkit().run(LIST_AGENTS_TOOL, {});
    expect(result.humanMessage).toContain("Research Agent");
    expect(result.humanMessage).toContain("40 HBAR coverage ($4.00)");
    expect(result.humanMessage).toContain("satisfaction-guarantee");
  });

  it("pays with the job hash and the USD cap", async () => {
    const job = "Summarise Q3 filings";
    const result = await toolkit().run(PAY_AGENT_TOOL, { agent: AGENT, amountHbar: "10", job, maxUsd: "2" });

    expect(result.raw.status).toBe("SUCCESS");
    expect(bonds.payments[0].jobHash).toBe(hashJob(job));
    expect(bonds.payments[0].amount).toBe(hbarToTinybars("10"));
    expect(result.humanMessage).toContain("fully refundable from the agent's bond");
  });

  it("surfaces the contract's refusal when the bond can't cover the payment", async () => {
    const result = await toolkit().run(PAY_AGENT_TOOL, { agent: AGENT, amountHbar: "41", job: "big job" });
    expect(result.raw.status).toBe("ERROR");
    expect(result.humanMessage).toContain("NotCovered");
  });

  it("claws a disputed payment back and records the reason's hash", async () => {
    const kit = toolkit();
    await kit.run(PAY_AGENT_TOOL, { agent: AGENT, amountHbar: "15", job: "analysis" });
    const reason = "Copied from a blog post";
    const result = await kit.run(DISPUTE_TOOL, { paymentId: "1", reason });

    expect(result.humanMessage).toContain("Clawed back 15 HBAR");
    expect(bonds.payments[0].disputeHash).toBe(hashMessage(reason));
    expect((await kit.run(GET_PAYMENT_TOOL, { paymentId: "1" })).raw.status).toBe("refunded");
    expect((await kit.run(GET_AGENT_TOOL, { agent: AGENT })).raw.clawbacks).toBe(1);
  });

  it("composes with Agent Kit policies: an off-chain cap blocks before anything is sent", async () => {
    class MaxTwentyHbar extends AbstractPolicy {
      name = "max-20-hbar";
      description = "Refuse to pay any agent more than 20 HBAR";
      relevantTools = [PAY_AGENT_TOOL];
      protected shouldBlockPostParamsNormalization(params: PostParamsNormalizationParams) {
        return params.normalisedParams.tinybars > hbarToTinybars("20");
      }
    }
    const result = await toolkit({}, [new MaxTwentyHbar()]).run(PAY_AGENT_TOOL, {
      agent: AGENT,
      amountHbar: "25",
      job: "too expensive",
    });
    expect(result.humanMessage).toContain("blocked by policy");
    expect(bonds.payments).toHaveLength(0);
  });
});

describe("provider tools", () => {
  it("publishes the receipt to the agent's HCS topic, then records the matching hash", async () => {
    const kit = toolkit();
    await kit.run(PAY_AGENT_TOOL, { agent: AGENT, amountHbar: "10", job: "brief" });
    const result = await kit.run(SUBMIT_RECEIPT_TOOL, {
      paymentId: "1",
      summary: "Delivered a 640-word brief",
    });

    expect(publisher.published[0].topicId).toBe("0.0.4242");
    expect(bonds.receipts[0].hash).toBe(hashMessage(publisher.published[0].message));
    expect(result.humanMessage).toContain("published to HCS (#1)");
  });

  it("records the receipt hash even when the agent has no topic", async () => {
    bonds.agent.receiptTopic = 0n;
    const kit = toolkit();
    await kit.run(PAY_AGENT_TOOL, { agent: AGENT, amountHbar: "10", job: "brief" });
    await kit.run(SUBMIT_RECEIPT_TOOL, { paymentId: "1", summary: "done" });
    expect(publisher.published).toHaveLength(0);
    expect(bonds.receipts).toHaveLength(1);
  });

  it("tops up the bond", async () => {
    const result = await toolkit().run(POST_BOND_TOOL, { amountHbar: "5" });
    expect(result.humanMessage).toBe("Bond is now 45 HBAR.");
  });

  it("rejects non-positive amounts before touching the chain", async () => {
    const result = await toolkit().run(POST_BOND_TOOL, { amountHbar: "0" });
    expect(result.raw.status).toBe("ERROR");
    expect(bonds.agent.bond).toBe(hbarToTinybars("40"));
  });
});

describe("ClaudeHederaToolkit", () => {
  it("exposes every plugin tool to Claude with its JSON schema", () => {
    const tools = toolkit().getTools();
    expect(tools.map(tool => tool.name)).toEqual([
      LIST_AGENTS_TOOL,
      GET_AGENT_TOOL,
      GET_PAYMENT_TOOL,
      PAY_AGENT_TOOL,
      DISPUTE_TOOL,
      POST_BOND_TOOL,
      SUBMIT_RECEIPT_TOOL,
    ]);
    const pay = tools.find(tool => tool.name === PAY_AGENT_TOOL)! as unknown as {
      input_schema: { properties: object };
    };
    expect(Object.keys(pay.input_schema.properties)).toEqual(["agent", "amountHbar", "job", "maxUsd"]);
  });
});
