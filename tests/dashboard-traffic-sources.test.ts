import { describe, expect, it } from "vitest";
import type { OfLinkChannelsResponse } from "@agency_hub_core/contracts";

import { sourcesView } from "../apps/dashboard/src/pages/traffic/sourcesView.ts";

type Channel = OfLinkChannelsResponse["channels"][number];
type Segment = Channel["segments"][number];
type Day = NonNullable<Segment["days"]>[number];

// Today is Wednesday 18 Nov: the grid is Mon 9 … Sun 22, today is slot 9.
const TODAY = "2026-11-18";
const DATES = Array.from({ length: 10 }, (_, index) => `2026-11-${String(9 + index).padStart(2, "0")}`);

function days(fans: ReadonlyArray<number | null | "no_baseline">): Day[] {
  return DATES.map((businessDate, index) => {
    const value = fans[index] ?? null;
    if (value === "no_baseline") return { businessDate, clicks: 40, fans: 25, vendorNetMills: 1000, flags: ["no_baseline"] };
    return { businessDate, clicks: value === null ? null : value * 5, fans: value, vendorNetMills: null, flags: [] };
  });
}

function segment(name: string, fans: ReadonlyArray<number | null | "no_baseline">): Segment {
  return {
    pageId: 1, pageLabel: "page", linkKind: "tracking", linkRef: name, name, linkCreatedAt: "2026-10-01T09:00:00.000Z", channelKey: "reddit", contractorKey: null,
    startAt: "2026-11-08T21:00:00.000Z", endAt: "2026-11-18T09:00:00.000Z",
    startObservedAt: "2026-11-08T18:00:00.000Z", endObservedAt: "2026-11-18T06:00:00.000Z",
    clicks: 0, claims: null, subscribers: 0, fans: 0, vendorNetMills: 0, flags: [],
    days: days(fans),
  };
}

function response(segments: Segment[]): OfLinkChannelsResponse {
  const totals = {
    linkCount: segments.length, clicks: 0, claims: 0, subscribers: 0, fans: 0, vendorNetMills: 0,
    hubMoney: {
      state: "no_data", reason: "not_computed", revenueBasis: "creator_net_after_platform_fee",
      attributionRule: "ofapi_subscription_period_equal_split.v1", netMills: null, pendingMills: null,
    },
  } as const;
  return {
    generatedAt: "2026-11-18T09:00:00.000Z", businessTimeZone: "Europe/Moscow", revenueBasis: "creator_net_after_platform_fee",
    seriesFloorAt: null,
    range: { from: "2026-11-09", to: TODAY, fromAt: "2026-11-08T21:00:00.000Z", toAt: "2026-11-18T09:00:00.000Z" },
    channels: [{ channelKey: "reddit", channelTitle: "Reddit", contractors: [], totals, flags: [], segments }],
    contractors: [],
  };
}

describe("Трафик → Источники: the day rules", () => {
  it("never counts a no_baseline day, keeps unknown days null, and draws nothing for days to come", () => {
    const view = sourcesView(response([segment("a", [null, null, "no_baseline", 2, 0, 1, 3, 0, 1, 0])]), undefined, TODAY);
    const [row] = view.sources[0]!.rows;
    expect(row!.fans).toEqual([null, null, null, 2, 0, 1, 3, 0, 1, 0, null, null, null, null]);
    expect(row!.total).toBe(7);
    // The only link with fans is the large chart; there is no combined row.
    expect(row!.large).toBe(true);
    expect(view.sources[0]!.rows).toHaveLength(1);
  });

  it("counts the first read day of a link made inside the two weeks, and keeps such a link a row at zero", () => {
    const young = segment("young", [null, null, null, null, null, null, "no_baseline", 0, 0, 0]);
    young.linkCreatedAt = "2026-11-14T10:00:00.000Z";
    const fresh = segment("fresh", [null, null, null, null, null, null, null, null, 0, 0]);
    fresh.linkCreatedAt = "2026-11-16T10:00:00.000Z";
    fresh.days = fresh.days!.map((day) => ({ ...day, clicks: day.clicks === null ? null : 0 }));
    const old = segment("old", [null, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    old.days![0] = { businessDate: DATES[0]!, clicks: 0, fans: 0, vendorNetMills: 0, flags: ["no_baseline"] };
    const view = sourcesView(response([young, fresh, old]), undefined, TODAY);
    const rows = view.sources[0]!.rows;
    expect(rows.map((row) => row.name)).toEqual(["Все 3 ссылки", "young", "old", "fresh"]);
    expect(rows[1]!.fans.slice(5, 10)).toEqual([null, 25, 0, 0, 0]);
    // An accumulated zero is a zero for an old link too.
    expect(rows[2]!.fans[0]).toBe(0);
    expect(rows[3]!.total).toBe(0);
  });

  it("puts «Все N ссылок» first when two links bring fans, summing the known values of each day", () => {
    const view = sourcesView(response([
      segment("a", [1, null, null, 2, 0, 0, 0, 0, 0, 0]),
      segment("b", [2, null, 3, "no_baseline", 0, 0, 0, 0, 0, 0]),
      segment("c", [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
    ]), undefined, TODAY);
    const rows = view.sources[0]!.rows;
    expect(rows.map((row) => [row.name, row.large])).toEqual([
      ["Все 3 ссылки", true], ["b", false], ["a", false], ["c", false],
    ]);
    expect(rows[0]!.fans.slice(0, 10)).toEqual([3, 0, 3, 2, 0, 0, 0, 0, 0, 1]);
    expect(rows[0]!.total).toBe(9);
  });

  it("with one link of fans among several, that link is large and the others small", () => {
    const clicksOnly = segment("clicks", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    clicksOnly.days = clicksOnly.days!.map((day) => ({ ...day, clicks: 3 }));
    const view = sourcesView(response([
      segment("quiet", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      clicksOnly,
      segment("fans", [0, 4, 6, 0, 0, 0, 0, 0, 0, 0]),
    ]), undefined, TODAY);
    const source = view.sources[0]!;
    expect(source.rows.map((row) => [row.name, row.large])).toEqual([["fans", true], ["clicks", false]]);
    expect(source.quiet).toBe("ещё 1 без кликов: quiet");
    expect(source.attention).toBe("7 дней без фанов");
  });
});
