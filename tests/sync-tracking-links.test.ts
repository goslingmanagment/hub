import { describe, expect, it, vi } from "vitest";

import type { ApplyInput, LocalApplyInput, PlanContext } from "../apps/runtime/src/sync/engine/resource.ts";
import { nextUntilMs, SERVED_ROWS_MAX, trackingLinksModule } from "../apps/runtime/src/sync/fansly/resources/tracking-links.ts";
import type * as DbModule from "@agency_hub_core/db";
import type { Database, PageTrackingLinkRef, SyncAttemptRow, SyncWorkRow } from "@agency_hub_core/db";

const db = vi.hoisted(() => ({
  live: [] as string[],
  attempt: null as unknown,
}));
vi.mock("@agency_hub_core/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  listPageTrackingLinkRefs: async (): Promise<PageTrackingLinkRef[]> => db.live.map((linkRef) => ({ linkRef, createdAt: null })),
  getSyncAttempt: async (): Promise<SyncAttemptRow | null> => db.attempt as SyncAttemptRow | null,
}));

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
    db.live = ["fyp", "search"];
    db.attempt = null;
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

describe("a link Fansly no longer serves", () => {
  const now = new Date("2026-11-05T02:01:38Z");
  const links = ["search", "suggestions", "fyp", "twitter", "deleted", "erome"].map((ref) => ({ ref, afterMs: D("2025-02-27") }));
  const stuck = { links, index: 4, half: 0, beforeMs: D("2026-10-31"), untilMs: null };
  const read = ["search", "suggestions", "fyp", "twitter"];
  const ctx = { now, pageId: 1 } as unknown as PlanContext;
  const pass = async (work: Partial<SyncWorkRow>) => {
    const plan = await trackingLinksModule.plan(work as SyncWorkRow, ctx);
    if (plan.kind !== "local") throw new Error(`expected a pass, got ${plan.kind}`);
    const local = { pageId: 1, now, work, plan } as unknown as LocalApplyInput;
    return { plan, result: await trackingLinksModule.applyLocal!({} as Database, local) };
  };

  it("is passed after Fansly refuses it, and the sweep reads the next link", async () => {
    // As on a page in November: Fansly answered 500 `invalid tracking link id`
    // to the fifth link every day, and the sweep never reached the sixth.
    db.live = ["search", "suggestions", "fyp", "twitter", "erome"];
    db.attempt = { workId: 9, request: { spec: "trackinglinks.stats", step: { sweep: stuck, historyRead: read } } };
    const refused = { id: 9, cursor: { sweep: stuck, historyRead: read }, lastErrorClass: "subject_failure", lastAttemptId: 811027 };

    const { plan, result } = await pass(refused);
    expect(plan).toMatchObject({ reason: "tracking_link_refused", detail: { refused: "deleted" } });
    expect(result.work).toMatchObject({ nextDueAt: now, cursor: { sweep: { ...stuck, index: 5 }, historyRead: read } });

    // The pass cleared the refusal: the next plan asks for the next link.
    const next = await trackingLinksModule.plan({ id: 9, cursor: result.work.cursor, lastErrorClass: null, lastAttemptId: 811027 } as unknown as SyncWorkRow, ctx);
    expect(next).toMatchObject({ kind: "request", request: { spec: "trackinglinks.stats", params: { trackingLinkId: "erome" } } });
  });

  it("is passed by a sweep under way once the list drops it; with no live link left the sweep ends", async () => {
    db.live = ["search", "suggestions", "fyp", "twitter"];
    db.attempt = null;
    const { plan, result } = await pass({ id: 9, cursor: { sweep: stuck, historyRead: read }, lastErrorClass: null, lastAttemptId: null });
    expect(plan).toMatchObject({ reason: "tracking_link_gone", detail: { sweep: null } });
    expect(result.work).toMatchObject({ close: "done", closeReason: "tracking_links_read", cursor: { sweep: null, historyRead: read } });
  });
});
