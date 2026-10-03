import { describe, expect, it } from "vitest";
import { buildFanEarningsReceipt } from "../apps/runtime/src/sync/fansly/lib/fan-earnings-receipt.ts";

const row = { correlationAccountId: "fan-a", type: 2110, totalGross: 100, totalNet: 80 };
function receipt(payload: unknown, window: "lifetime" | "monthly" = "lifetime") {
  return buildFanEarningsReceipt({
    pageId: 1, fanRef: "fan-a", window, payload,
    observationId: 10, checkedAt: new Date("2026-09-10T00:00:00Z"),
  });
}

describe("earnings receipts use the captured monetary contract", () => {
  it.each([
    {}, [null], [{ ...row, totalNet: undefined }],
    [{ ...row, correlationAccountId: "another-fan" }],
    [row, { ...row, totalGross: 0.1 }],
  ])("rejects malformed, partial or incorrectly bound payloads", (payload) => {
    expect(receipt(payload)).toMatchObject({ outcome: "invalid", fingerprint: null });
  });

  it("distinguishes an empty response from explicit zero and negative values", () => {
    expect(receipt([]).outcome).toBe("empty");
    for (const amount of [0, -100]) {
      expect(receipt([{ ...row, totalGross: amount, totalNet: amount }]).outcome).toBe("observed");
    }
  });

  it("requires a durable observation before a check can be certified", () => {
    expect(buildFanEarningsReceipt({
      pageId: 1, fanRef: "fan-a", window: "lifetime", payload: [row],
      observationId: null, checkedAt: new Date(),
    }).outcome).toBe("invalid");
  });

  it("ignores row order and detects old-window corrections in monthly snapshots", () => {
    const months = [1, 2].map((month) => ({ ...row, year: 2026, month }));
    const original = receipt(months, "monthly");
    expect(original.outcome).toBe("observed");
    expect(receipt([...months].reverse(), "monthly").fingerprint).toBe(original.fingerprint);
    expect(receipt([{ ...months[0], totalNet: 70 }, months[1]], "monthly").fingerprint)
      .not.toBe(original.fingerprint);
    expect(receipt([row], "monthly").outcome).toBe("invalid");
  });
});
