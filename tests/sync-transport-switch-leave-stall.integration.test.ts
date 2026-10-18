// The page transport switch (see tests/sync-transport-switch.integration.test.ts): leaving the browser is confirmed before Node takes the page, part 4 (stalled deliveries).
// Split out so the CI shards can spread these slow, real-time tests (each file runs whole in one shard).

import { describe, expect, it } from "vitest";

import { until } from "./helpers/sync-engine.ts";
import {
  attemptOf,
  bigAnswers,
  currentLinkOf,
  diedAfterBrowserSent,
  leftBy,
  onBrowser,
  rig,
  startHost,
  testDb,
  useSwitchHarness,
} from "./helpers/sync-transport-switch.ts";

useSwitchHarness();

describe("leaving the browser is confirmed before Node takes the page (Astra PR 14, P1)", () => {
  it("a delivery that stalls is cut after its silence, never sooner; the next connection's delivers it (Astra PR 14 round 4)", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    bigAnswers(r);
    const old = await diedAfterBrowserSent(r);
    r.operator.bodiesUnreadable = true;
    await startHost(r);
    await until(async () => r.operator.recovers.flat().includes(old.id), 20_000, "the operator asked about the attempt");
    // It reads now, but stalls after the first part.
    r.operator.stallAfterParts = 1;
    r.operator.bodiesUnreadable = false;
    const sentBefore = r.operator.partsSent.length;
    await until(async () => r.operator.partsSent.length > sentBefore, 40_000, "the delivery under way");
    const stalledOn = r.operator.partsSent[sentBefore]!.link;
    const stalledAt = Date.now();
    // A new connection only after the stall's silence (30 s), within one more step (≤ 30 s) and its ask.
    await until(async () => currentLinkOf(r) > stalledOn, 90_000, "the stalled connection cut");
    const after = Date.now() - stalledAt;
    expect(after).toBeGreaterThanOrEqual(25_000);
    expect(after).toBeLessThanOrEqual(80_000);
    // No longer stalled: the next delivery is whole (the engine took the
    // body, which it does only whole), and the leave ends.
    r.operator.stallAfterParts = null;
    await until(async () => (await leftBy(r.page.pageId)).by === "operator", 120_000, "the leave confirmed");
    // Its `sent` went to the engine that died: unknown to this one — the
    // result's own instant proves nothing (Astra's review of PR 15, round 6).
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "response", sendMark: "completion_fallback" });
  }, 300_000);

  it("a delivery that stalls while the leave first asks (before the drain) is cut after its silence too, and asked again on the next connection", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await onBrowser(r);
    bigAnswers(r);
    const old = await diedAfterBrowserSent(r);
    r.operator.stallAfterParts = 1;
    const sentBefore = r.operator.partsSent.length;
    await startHost(r);
    await until(async () => r.operator.partsSent.length > sentBefore, 40_000, "the delivery under way");
    const stalledOn = r.operator.partsSent[sentBefore]!.link;
    const stalledAt = Date.now();
    await until(async () => currentLinkOf(r) > stalledOn, 90_000, "the stalled connection cut");
    expect(Date.now() - stalledAt).toBeGreaterThanOrEqual(25_000);
    r.operator.stallAfterParts = null;
    await until(async () => (await leftBy(r.page.pageId)).by === "operator", 120_000, "the leave confirmed");
    expect(await attemptOf(r, old.id)).toMatchObject({ outcome: "response" });
  }, 300_000);
});
