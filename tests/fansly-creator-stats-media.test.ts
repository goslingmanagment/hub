import { describe, expect, it } from "vitest";

import {
  mediaAgeDays,
  mediaTierIndex,
  mediaVisitAsks,
  parseMediaAnswer,
} from "../apps/runtime/src/sync/fansly/lib/creator-stats-media.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";

// The media walk of Fansly's creator statistics (resources/creator-stats-media.ts):
// which windows a visit asks for, and how often an offer is due by its age.

const DAY = 86_400_000;
const D = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const NOW = new Date("2026-10-22T15:30:00Z");

describe("a media visit's windows", () => {
  it("reads a young media's surfaces from the posting day, and surface 4 only once a top list showed it there", () => {
    const state = { postedAtMs: D("2026-10-12") + 7 * 3_600_000, deletedAtMs: null, other: false, through: {} };
    expect(mediaVisitAsks(state, NOW)).toEqual([
      { source: 0, afterMs: D("2026-10-12"), beforeMs: D("2026-10-22") },
      { source: 1, afterMs: D("2026-10-12"), beforeMs: D("2026-10-22") },
    ]);
    // Surface 4 is new to the visit: from the posting day; the others from
    // the day before the last day read.
    const read = { ...state, other: true, through: { "0": D("2026-10-21"), "1": D("2026-10-21") } };
    expect(mediaVisitAsks(read, NOW)).toEqual([
      { source: 0, afterMs: D("2026-10-20"), beforeMs: D("2026-10-22") },
      { source: 1, afterMs: D("2026-10-20"), beforeMs: D("2026-10-22") },
      { source: 4, afterMs: D("2026-10-12"), beforeMs: D("2026-10-22") },
    ]);
  });

  it("reads a media past 93 days as every surface's days (-1) and Timeline, a surface never read in 400-day spans oldest first", () => {
    const posted = D("2025-03-01");
    const asks = mediaVisitAsks({ postedAtMs: posted, deletedAtMs: null, other: true, through: { "0": D("2025-06-01"), "1": D("2026-09-22") } }, NOW);
    expect(asks).toEqual([
      { source: -1, afterMs: posted, beforeMs: posted + 399 * DAY },
      { source: -1, afterMs: posted + 400 * DAY, beforeMs: D("2026-10-22") },
      { source: 1, afterMs: D("2026-09-21"), beforeMs: D("2026-10-22") },
    ]);
    // An interrupted walk goes on from the last span it read.
    const resumed = mediaVisitAsks({ postedAtMs: posted, deletedAtMs: null, other: false, through: { "-1": posted + 399 * DAY, "1": D("2026-10-22") } }, NOW);
    expect(resumed).toEqual([
      { source: -1, afterMs: posted + 398 * DAY, beforeMs: D("2026-10-22") },
      { source: 1, afterMs: D("2026-10-21"), beforeMs: D("2026-10-22") },
    ]);
  });
});

describe("a media's cadence", () => {
  it("follows the registry's tiers by the post's age: 6 h to 2 days, daily to 30, weekly to 93, monthly after", () => {
    const tiers = fanslyResourceSpec("creator-stats.media")!.tiers!;
    const everyAt = (iso: string | null) => tiers[mediaTierIndex(tiers, mediaAgeDays(iso === null ? null : Date.parse(iso), NOW))]!.everyMs;
    expect(everyAt("2026-10-21T12:00:00Z")).toBe(6 * 3_600_000);
    expect(everyAt("2026-10-19T12:00:00Z")).toBe(DAY);
    expect(everyAt("2026-08-01T00:00:00Z")).toBe(7 * DAY);
    expect(everyAt("2026-07-01T00:00:00Z")).toBe(30 * DAY);
    expect(everyAt(null)).toBe(30 * DAY);
  });
});

describe("a media answer", () => {
  it("keeps each day's own surface in a -1 answer and takes tags only from a named surface", () => {
    const answer = parseMediaAnswer({
      mediaOfferId: "10",
      afterBucket: D("2026-10-20"),
      beforeBucket: D("2026-10-22"),
      media: [{
        mediaId: "11",
        mediaType: 2,
        totals: null,
        daily: [
          { bucket: String(D("2026-10-21")), source: 0, views: 5, uniqueViewers: 4 },
          { bucket: String(D("2026-10-21")), source: 3, views: 1 },
          { bucket: String(D("2026-10-21")), views: 9 },
        ],
        tags: [{ tagId: "7", kind: 1, views: 3 }],
      }],
      likes: [{ bucket: String(D("2026-10-21")), source: 4, likes: 2, unlikes: 0 }],
    }, -1);
    expect(answer?.daily.map((row) => [row.source, row.views, row.uniqueViewers])).toEqual([[0, 5, 4], [3, 1, null]]);
    expect(answer?.tags).toEqual([]);
    expect(answer?.skipped).toBe(2);
    expect(answer?.likes).toEqual([{ source: 4, day: "2026-10-21", likes: 2, unlikes: 0 }]);
  });
});
