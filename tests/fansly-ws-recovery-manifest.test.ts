import { describe, expect, it } from "vitest";
import { fanslyWsCreatedAtMs } from "../apps/runtime/src/services/fansly-ws-recovery-manifest.ts";

describe("WS recovery manifest createdAt units", () => {
  it("reads the frame's epoch seconds, fractional or whole, and passes milliseconds through", () => {
    // Prod service-5 frames (2026-09-28) carry fractional seconds.
    expect(fanslyWsCreatedAtMs(1790599288.773)).toBe(1790599288773);
    expect(new Date(fanslyWsCreatedAtMs(1790537081.487)!).toISOString()).toBe("2026-09-27T19:24:41.487Z");
    expect(new Date(fanslyWsCreatedAtMs(1790537081)!).toISOString()).toBe("2026-09-27T19:24:41.000Z");
    expect(fanslyWsCreatedAtMs(1790537081487)).toBe(1790537081487);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 9e15, "1790537081", null, undefined])(
    "treats %s as absent", (value) => {
      expect(fanslyWsCreatedAtMs(value)).toBeNull();
    },
  );
});
