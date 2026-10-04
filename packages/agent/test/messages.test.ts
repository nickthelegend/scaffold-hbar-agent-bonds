import { describe, expect, it } from "vitest";
import { encodeDisputeReason, encodeReceipt, hashJob, hashMessage, MAX_MESSAGE_BYTES } from "../src/messages";
import {
  formatUsd,
  hbarToTinybars,
  hbarToWeibars,
  tinybarsToHbar,
  usdToMicros,
  weibarsToTinybars,
} from "../src/units";
import { AGENT, BONDS, CLIENT } from "./fakes";

const receipt = {
  bonds: BONDS,
  paymentId: 7n,
  agent: AGENT,
  summary: "Delivered the brief",
  createdAt: 1_790_000_000,
};

describe("receipts", () => {
  it("are canonical: lowercase addresses and integer strings in a fixed order", () => {
    expect(encodeReceipt(receipt)).toBe(
      `{"v":1,"type":"receipt","bonds":"${BONDS}","paymentId":"7","agent":"${AGENT}",` +
        `"summary":"Delivered the brief","createdAt":1790000000}`,
    );
  });

  it("hash identically regardless of address casing", () => {
    const upper = { ...receipt, agent: AGENT.toUpperCase().replace("0X", "0x") as typeof AGENT };
    expect(hashMessage(encodeReceipt(upper))).toBe(hashMessage(encodeReceipt(receipt)));
  });

  it.each([
    ["ASCII", "x".repeat(5_000)],
    ["multi-byte", "交付".repeat(1_000)],
    ["emoji", "📄✅".repeat(500)],
    ["characters JSON escapes", '"\\\n'.repeat(1_000)],
  ])("fit %s summaries into a single 1 KiB HCS message", (_, summary) => {
    const message = encodeReceipt({ ...receipt, summary });
    expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(summary.startsWith(JSON.parse(message).summary)).toBe(true);
  });
});

describe("disputes and jobs", () => {
  it("encodes dispute reasons the same canonical way", () => {
    const message = encodeDisputeReason({
      bonds: BONDS,
      paymentId: 1n,
      client: CLIENT,
      reason: "copied",
      createdAt: 1,
    });
    expect(JSON.parse(message)).toMatchObject({ type: "dispute", paymentId: "1", reason: "copied" });
  });

  it("hashes job descriptions ignoring surrounding whitespace", () => {
    expect(hashJob("  write a brief \n")).toBe(hashJob("write a brief"));
  });
});

describe("units", () => {
  it("convert between HBAR, tinybars and weibars", () => {
    expect(hbarToTinybars("1.5")).toBe(150_000_000n);
    expect(tinybarsToHbar(150_000_000n)).toBe("1.5");
    expect(hbarToWeibars("1")).toBe(10n ** 18n);
    expect(weibarsToTinybars(10n ** 18n)).toBe(100_000_000n);
  });

  it("format 6-decimal USD", () => {
    expect(usdToMicros("2.5")).toBe(2_500_000n);
    expect(formatUsd(2_500_000n)).toBe("$2.50");
  });
});
