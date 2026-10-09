import { describe, expect, it } from "vitest";

import {
  linkDeltaBetween,
  linkSegments,
  splitByIntervals,
  totalSegments,
  type ChannelTermInterval,
  type LinkBindingInterval,
  type LinkSeries,
  type LinkSeriesPoint,
} from "@agency_hub_core/db";

// The arithmetic of «Ссылки OnlyFans» (traffic plan §2.6, PR 12): deltas of
// cumulative vendor counters, and channel / contractor segments cut by dated
// bindings (П9.7: an assumed start is flagged).

const at = (value: string) => new Date(value);

function point(observedAt: string, values: Partial<LinkSeriesPoint> = {}): LinkSeriesPoint {
  return {
    observedAt: at(observedAt),
    runId: 1,
    ofapiAccountId: "acct_a",
    runReason: null,
    clicks: 0,
    claims: 0,
    subscribers: 0,
    netMills: 0n,
    ...values,
  };
}

function trial(points: readonly LinkSeriesPoint[], overrides: Partial<LinkSeries> = {}): LinkSeries {
  return {
    pageId: 9,
    linkKind: "trial",
    linkRef: "10802699",
    linkCreatedAt: at("2026-08-01T00:00:00Z"),
    points,
    ...overrides,
  };
}

describe("linkDeltaBetween", () => {
  const series = trial([
    point("2026-08-01T04:45:00Z", { clicks: 10, claims: 4, subscribers: 0, netMills: 1_000n }),
    point("2026-08-01T16:45:00Z", { clicks: 15, claims: 6, subscribers: 0, netMills: 3_000n }),
    point("2026-08-02T04:45:00Z", { clicks: 20, claims: 9, subscribers: 1, netMills: 2_500n }),
    point("2026-08-02T16:45:00Z", { clicks: 22, claims: 9, subscribers: 1, netMills: null }),
  ]);

  it("is the last snapshot before the end minus the last before the start; fans are claims on a trial link", () => {
    const delta = linkDeltaBetween(series, at("2026-08-01T10:00:00Z"), at("2026-08-02T10:00:00Z"))!;
    expect(delta.startPoint?.observedAt).toEqual(at("2026-08-01T04:45:00Z"));
    expect(delta.endPoint.observedAt).toEqual(at("2026-08-02T04:45:00Z"));
    expect(delta).toMatchObject({ clicks: 10, claims: 5, subscribers: 1, fans: 5, netMills: 1_500n });
    // 3 000 → 2 500 inside the delta: a recalculation, not a loss.
    expect(delta.flags).toEqual(["vendor_recalculated"]);
  });

  it("treats a boundary instant as belonging to what follows it", () => {
    const delta = linkDeltaBetween(series, at("2026-08-01T16:45:00Z"), at("2026-08-02T04:45:00Z"))!;
    expect(delta.startPoint?.observedAt).toEqual(at("2026-08-01T04:45:00Z"));
    expect(delta.endPoint.observedAt).toEqual(at("2026-08-01T16:45:00Z"));
  });

  it("knows no money when the end snapshot does not, never putting an earlier value in its place", () => {
    // Yesterday $2.50 known, today's snapshot still computing: not "no change".
    const delta = linkDeltaBetween(series, at("2026-08-02T10:00:00Z"), at("2026-08-03T00:00:00Z"))!;
    expect(delta.endPoint.observedAt).toEqual(at("2026-08-02T16:45:00Z"));
    expect(delta.clicks).toBe(2);
    expect(delta.netMills).toBeNull();
    expect(delta.flags).toEqual(["money_unknown"]);
  });

  it("has no delta before the link's first snapshot", () => {
    expect(linkDeltaBetween(series, at("2026-07-30T00:00:00Z"), at("2026-08-01T04:45:00Z"))).toBeNull();
  });

  it("counts a link created inside the stretch from zero, without a flag", () => {
    const delta = linkDeltaBetween(series, at("2026-07-30T00:00:00Z"), at("2026-08-01T12:00:00Z"))!;
    expect(delta.startPoint).toBeNull();
    expect(delta).toMatchObject({ clicks: 10, claims: 4, netMills: 1_000n, flags: [] });
  });

  it("flags the whole accumulated value of a link that existed before the stretch with nothing read", () => {
    const old = trial(series.points, { linkCreatedAt: at("2025-11-26T17:06:21Z") });
    expect(linkDeltaBetween(old, at("2026-07-30T00:00:00Z"), at("2026-08-01T12:00:00Z"))!.flags)
      .toEqual(["no_baseline"]);
    const unknownCreation = trial(series.points, { linkCreatedAt: null });
    expect(linkDeltaBetween(unknownCreation, at("2026-07-30T00:00:00Z"), at("2026-08-01T12:00:00Z"))!.flags)
      .toEqual(["no_baseline"]);
    // Created 1 Sept under a running series, first read on 2 Oct after gaps:
    // 1–2 Oct is not September's money as that day's growth.
    const missed = trial([point("2026-10-02T03:45:00Z", { clicks: 300, claims: 90, netMills: 120_000n })], {
      linkCreatedAt: at("2026-09-01T09:00:00Z"),
    });
    expect(linkDeltaBetween(missed, at("2026-09-30T21:00:00Z"), at("2026-10-02T21:00:00Z"))).toMatchObject({
      startPoint: null, clicks: 300, netMills: 120_000n, flags: ["no_baseline"],
    });
  });

  it("knows no money when nothing before the end knows it, or the start has snapshots but no money", () => {
    const loading = trial([
      point("2026-08-01T04:45:00Z", { clicks: 1, netMills: null }),
      point("2026-08-01T16:45:00Z", { clicks: 2, netMills: 700n }),
    ]);
    expect(linkDeltaBetween(loading, at("2026-07-30T00:00:00Z"), at("2026-08-01T12:00:00Z"))).toMatchObject({
      clicks: 1, netMills: null, flags: ["money_unknown"],
    });
    expect(linkDeltaBetween(loading, at("2026-08-01T12:00:00Z"), at("2026-08-02T00:00:00Z"))).toMatchObject({
      clicks: 1, netMills: null, flags: ["money_unknown"],
    });
  });

  it("flags an OFAPI account change inside the delta, by account or by the run's caveat", () => {
    const rebound = trial([
      point("2026-09-03T04:45:00Z", { ofapiAccountId: "acct_old", netMills: 100n }),
      point("2026-09-05T04:45:00Z", { ofapiAccountId: "acct_new", netMills: 100n }),
    ]);
    expect(linkDeltaBetween(rebound, at("2026-09-04T00:00:00Z"), at("2026-09-06T00:00:00Z"))!.flags)
      .toEqual(["binding_changed"]);
    expect(linkDeltaBetween(rebound, at("2026-09-05T12:00:00Z"), at("2026-09-06T00:00:00Z"))!.flags).toEqual([]);
    const caveat = trial([
      point("2026-09-03T04:45:00Z", { ofapiAccountId: null }),
      point("2026-09-05T04:45:00Z", { ofapiAccountId: null, runReason: "binding_changed,multi_page" }),
    ]);
    expect(linkDeltaBetween(caveat, at("2026-09-04T00:00:00Z"), at("2026-09-06T00:00:00Z"))!.flags)
      .toEqual(["binding_changed"]);
  });

  it("counts subscribers as fans on a tracking link and has no claims", () => {
    const tracking: LinkSeries = {
      ...trial([
        point("2026-08-01T04:45:00Z", { clicks: 100, claims: null, subscribers: 10 }),
        point("2026-08-02T04:45:00Z", { clicks: 130, claims: null, subscribers: 13 }),
      ]),
      linkKind: "tracking",
    };
    expect(linkDeltaBetween(tracking, at("2026-08-01T12:00:00Z"), at("2026-08-03T00:00:00Z"))).toMatchObject({
      clicks: 30, claims: null, subscribers: 3, fans: 3,
    });
  });
});

describe("splitByIntervals", () => {
  it("covers the range with the intervals and the gaps between them", () => {
    const intervals = [
      { validFrom: at("2026-08-10T00:00:00Z"), validTo: at("2026-08-20T00:00:00Z"), validFromBasis: "confirmed" as const, id: "a" },
      { validFrom: at("2026-08-25T00:00:00Z"), validTo: null, validFromBasis: "confirmed" as const, id: "b" },
    ];
    const pieces = splitByIntervals(intervals, at("2026-08-01T00:00:00Z").getTime(), at("2026-09-01T00:00:00Z").getTime());
    expect(pieces.map((piece) => [new Date(piece.startMs).toISOString().slice(0, 10), new Date(piece.endMs).toISOString().slice(0, 10), piece.interval?.id ?? null]))
      .toEqual([
        ["2026-08-01", "2026-08-10", null],
        ["2026-08-10", "2026-08-20", "a"],
        ["2026-08-20", "2026-08-25", null],
        ["2026-08-25", "2026-09-01", "b"],
      ]);
  });
});

describe("linkSegments and totals", () => {
  // Snapshots at 00:00 UTC every day from 08-01 to 08-31: clicks = day of month × 10.
  const points = Array.from({ length: 31 }, (_, index) => point(
    `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    { clicks: (index + 1) * 10, claims: index + 1, netMills: BigInt((index + 1) * 1_000) },
  ));
  const series = trial(points, { linkCreatedAt: at("2026-07-31T12:00:00Z") });
  const bindings: LinkBindingInterval[] = [
    { channelKey: "lora.reddit", validFrom: at("2026-07-31T12:00:00Z"), validTo: at("2026-08-11T00:00:00Z"), validFromBasis: "assumed_link_created" },
    { channelKey: "lora.porntoki", validFrom: at("2026-08-21T00:00:00Z"), validTo: null, validFromBasis: "confirmed" },
  ];
  const terms = new Map<string, ChannelTermInterval[]>([
    ["lora.porntoki", [
      { contractorKey: "coraline-red", validFrom: at("2026-08-26T00:00:00Z"), validTo: null, validFromBasis: "assumed_link_created" },
    ]],
  ]);

  it("cuts the range by bindings and contractor terms; the pieces add up to the link's delta", () => {
    const from = at("2026-08-05T00:00:00Z");
    const to = at("2026-08-31T12:00:00Z");
    const segments = linkSegments(series, bindings, terms, from, to);
    // A channel's segments: the bindings alone.
    expect(linkSegments(series, bindings, null, from, to).map((segment) => [
      segment.channelKey, segment.contractorKey, segment.startAt.toISOString().slice(0, 10), segment.delta.clicks, segment.delta.flags,
    ])).toEqual([
      ["lora.reddit", null, "2026-08-05", 60, ["assumed_binding_start"]],
      [null, null, "2026-08-11", 100, []],
      ["lora.porntoki", null, "2026-08-21", 110, []],
    ]);
    expect(segments.map((segment) => [
      segment.channelKey, segment.contractorKey, segment.startAt.toISOString().slice(0, 10),
      segment.endAt.toISOString().slice(0, 10), segment.delta.clicks, segment.delta.flags,
    ])).toEqual([
      // value before 08-11 (08-10: 100) − value before 08-05 (08-04: 40)
      ["lora.reddit", null, "2026-08-05", "2026-08-11", 60, ["assumed_binding_start"]],
      [null, null, "2026-08-11", "2026-08-21", 100, []],
      ["lora.porntoki", null, "2026-08-21", "2026-08-26", 50, []],
      ["lora.porntoki", "coraline-red", "2026-08-26", "2026-08-31", 60, ["assumed_contractor_start"]],
    ]);
    const whole = linkDeltaBetween(series, from, to)!;
    expect(totalSegments(segments)).toMatchObject({ linkCount: 1, clicks: whole.clicks, claims: whole.claims, netMills: whole.netMills });
  });

  it("keeps a channel's total when a contractor term starts between snapshots whose money is unknown", () => {
    // 08-15's money is still computing; a contractor starts on 08-15 12:00.
    const computing = trial(points.map((item) => item.observedAt.getTime() === at("2026-08-15T00:00:00Z").getTime()
      ? { ...item, netMills: null }
      : item), { linkCreatedAt: at("2026-07-31T12:00:00Z") });
    const bound: LinkBindingInterval[] = [
      { channelKey: "lora.porntoki", validFrom: at("2026-07-31T12:00:00Z"), validTo: null, validFromBasis: "confirmed" },
    ];
    const lateContractor = new Map<string, ChannelTermInterval[]>([
      ["lora.porntoki", [{ contractorKey: "coraline-red", validFrom: at("2026-08-15T12:00:00Z"), validTo: null, validFromBasis: "confirmed" }]],
    ]);
    const from = at("2026-08-10T12:00:00Z");
    const to = at("2026-08-20T12:00:00Z");
    const channel = totalSegments(linkSegments(computing, bound, null, from, to));
    expect(channel).toMatchObject({ netMills: 10_000n, flags: [] });
    // Who brought it is not known around the unknown snapshot; the channel's total does not move.
    const byContractor = linkSegments(computing, bound, lateContractor, from, to);
    expect(byContractor.map((segment) => [segment.contractorKey, segment.delta.netMills, segment.delta.flags])).toEqual([
      [null, null, ["money_unknown"]],
      ["coraline-red", null, ["money_unknown"]],
    ]);
    expect(totalSegments(linkSegments(computing, bound, new Map(), from, to))).toMatchObject({ netMills: 10_000n });
  });

  it("leaves out stretches before the link's first snapshot", () => {
    const segments = linkSegments(series, bindings, terms, at("2026-07-01T00:00:00Z"), at("2026-08-01T00:00:00Z"));
    expect(segments).toEqual([]);
  });

  it("sums known money only and keeps money_unknown", () => {
    const unknown = trial([point("2026-08-01T00:00:00Z", { clicks: 5, netMills: null })], { linkRef: "11687581" });
    const segments = [
      ...linkSegments(series, [], null, at("2026-08-01T12:00:00Z"), at("2026-08-02T12:00:00Z")),
      ...linkSegments(unknown, [], null, at("2026-07-31T00:00:00Z"), at("2026-08-02T12:00:00Z")),
    ];
    expect(totalSegments(segments)).toMatchObject({ linkCount: 2, clicks: 15, netMills: 1_000n, flags: ["money_unknown"] });
  });
});
