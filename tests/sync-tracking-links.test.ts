import { describe, expect, it } from "vitest";

import type { ApplyInput, PlanContext } from "../apps/runtime/src/sync/engine/resource.ts";
import { nextUntilMs, SERVED_ROWS_MAX, trackingLinksModule } from "../apps/runtime/src/sync/fansly/resources/tracking-links.ts";
import type { Database, SyncWorkRow } from "@agency_hub_core/db";

// `tracking-links.daily`: Fansly cuts an answer at 1000 rows and keeps the
// newest. A busy link's revenue is a row a day and type, so its history passes
// that within months (a busy FYP link: 20 months old, its first four were lost).

const DAY = 86_400_000;
const D = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** `count` revenue rows, newest first from `newest`, four types a day. */
function revenue(newest: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: String(D(newest) - Math.floor(i / 4) * DAY),
    type: 2010 + (i % 4),
    totalGross: 1000,
    totalNet: 0,
  }));
}

describe("tracking link history", () => {
  const oldest = D("2026-10-30") - 249 * DAY;

  it("follows a cut answer with a read ending at its oldest day, whole", () => {
    const full = revenue("2026-10-30", SERVED_ROWS_MAX);
    expect(nextUntilMs(full, D("2026-10-31"), D("2025-02-27"))).toBe(oldest + DAY);
    expect(nextUntilMs(full.slice(1), D("2026-10-31"), D("2025-02-27"))).toBeNull();
    expect(nextUntilMs(full, D("2026-10-31"), oldest)).toBeNull();
    expect(nextUntilMs(full, oldest + DAY, D("2025-02-27"))).toBeNull();
  });

  it("reads a link's revenue page by page, then moves to the next link", async () => {
    const tx = { execute: async () => ({ rowCount: 0, rows: [] }) } as unknown as Database;
    const now = new Date("2026-10-31T08:21:00Z");
    const links = [{ ref: "fyp", afterMs: D("2025-02-27") }, { ref: "search", afterMs: D("2025-02-28") }];
    const sweep = { links, index: 0, half: 1, beforeMs: now.getTime(), untilMs: null };
    const apply = (step: unknown, response: unknown) => trackingLinksModule.apply(tx, {
      pageId: 1,
      now,
      response,
      observation: { id: 7, receivedAt: now },
      request: { spec: "trackinglinks.revenuestats", params: {}, step },
    } as unknown as ApplyInput);

    const cut = await apply({ sweep, historyRead: [] }, revenue("2026-10-30", SERVED_ROWS_MAX));
    expect(cut.work.cursor).toEqual({ sweep: { ...sweep, untilMs: oldest + DAY }, historyRead: [] });
    const plan = await trackingLinksModule.plan(
      { cursor: cut.work.cursor } as unknown as SyncWorkRow,
      { now, pageId: 1 } as unknown as PlanContext,
    );
    expect(plan).toMatchObject({
      kind: "request",
      request: { spec: "trackinglinks.revenuestats", params: { trackingLinkId: "fyp", beforeMs: oldest + DAY, afterMs: D("2025-02-27") } },
    });

    const rest = await apply({ sweep: { ...sweep, untilMs: oldest + DAY }, historyRead: [] }, revenue("2026-02-23", 400));
    expect(rest.work.cursor).toEqual({ sweep: { ...sweep, index: 1, half: 0 }, historyRead: ["fyp"] });
  });
});
