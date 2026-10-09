// The arithmetic of the link series (traffic sources plan §2.6), pure: no
// database, no clock. The series holds cumulative vendor counters; every
// figure the owner reads is a difference of two of them, and it is only as
// honest as what it says about itself — the snapshots it rests on and the
// flags that qualify it.
//
//   value before t   the link's last snapshot read strictly before t; a
//                    boundary instant belongs to what follows it.
//   delta [a, b)     value before b minus value before a. No snapshot
//                    before b: no delta. No snapshot before a: counted from
//                    zero — exact for a link born under the series, and
//                    flagged starts_before_series for a link older than its
//                    list's first read (the whole accumulated value).
//   money            the last snapshot with KNOWN money before the instant
//                    (a computing vendor value is unknown, not zero). No
//                    known money at the end, or a start that has snapshots
//                    but no known money: the money delta is unknown.
//   channel segment  one link over one stretch with one channel and one
//                    contractor: bindings and contractor terms cut the
//                    range, and each piece is a delta. The pieces of a link
//                    chain end to start, so they add up to the link's delta
//                    over the range.

import type { TrafficValidFromBasis } from "@agency_hub_core/shared";

import type { LinkStatKind } from "./ofapi.ts";

export type OfLinkDeltaFlag =
  | "starts_before_series"
  | "vendor_recalculated"
  | "binding_changed"
  | "money_unknown"
  | "assumed_binding_start"
  | "assumed_contractor_start";

/** Flag order on the wire: fixed, whatever order they were found in. */
const FLAG_ORDER: readonly OfLinkDeltaFlag[] = [
  "starts_before_series",
  "vendor_recalculated",
  "binding_changed",
  "money_unknown",
  "assumed_binding_start",
  "assumed_contractor_start",
];

export function sortDeltaFlags(flags: Iterable<OfLinkDeltaFlag>): OfLinkDeltaFlag[] {
  const present = new Set(flags);
  return FLAG_ORDER.filter((flag) => present.has(flag));
}

/** One snapshot of one link, as the arithmetic needs it. */
export interface LinkSeriesPoint {
  observedAt: Date;
  runId: number;
  /** The OFAPI account the page was read under; null = not known. */
  ofapiAccountId: string | null;
  /** The run's caveats (`binding_changed` among them on the first non-empty
   * read under a new account). */
  runReason: string | null;
  clicks: number;
  claims: number | null;
  subscribers: number;
  /** null = unknown (missing or still computing at the vendor). */
  netMills: bigint | null;
}

/** A link and its snapshots, oldest first. */
export interface LinkSeries {
  pageId: number;
  linkKind: LinkStatKind;
  linkRef: string;
  linkCreatedAt: Date | null;
  /** The first finished read of the link's list (page × kind): where the
   * series begins to see this list. */
  listFloorAt: Date | null;
  points: readonly LinkSeriesPoint[];
}

export interface LinkDelta {
  startPoint: LinkSeriesPoint | null;
  endPoint: LinkSeriesPoint;
  clicks: number;
  claims: number | null;
  subscribers: number;
  /** claims on a trial link, subscribers on a tracking link. */
  fans: number | null;
  netMills: bigint | null;
  flags: OfLinkDeltaFlag[];
}

/** Index of the last point read strictly before `at`, or -1. Points are sorted. */
export function lastIndexBefore(points: readonly LinkSeriesPoint[], at: Date): number {
  let low = 0;
  let high = points.length - 1;
  let found = -1;
  const target = at.getTime();
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (points[middle]!.observedAt.getTime() < target) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function lastKnownMoneyAtOrBefore(points: readonly LinkSeriesPoint[], index: number): bigint | null {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const money = points[cursor]!.netMills;
    if (money !== null) {
      return money;
    }
  }
  return null;
}

/** The page's OFAPI account changed into this point: the run says so, or the
 * account differs from the previous point's (both known). */
export function pointChangedBinding(previous: LinkSeriesPoint | null, point: LinkSeriesPoint): boolean {
  if (point.runReason !== null && point.runReason.split(",").includes("binding_changed")) {
    return true;
  }
  return previous !== null
    && previous.ofapiAccountId !== null
    && point.ofapiAccountId !== null
    && previous.ofapiAccountId !== point.ofapiAccountId;
}

/** OFAPI lowered the money into this point: below the last known value before it. */
export function pointRecalculatedMoney(points: readonly LinkSeriesPoint[], index: number): boolean {
  const money = points[index]!.netMills;
  if (money === null) {
    return false;
  }
  const previous = lastKnownMoneyAtOrBefore(points, index - 1);
  return previous !== null && money < previous;
}

/** The link existed before its list's first read: a missing start counts the
 * whole accumulated value. Unknown creation is treated as old. */
function predatesList(series: LinkSeries): boolean {
  if (series.linkCreatedAt === null) {
    return true;
  }
  return series.listFloorAt === null || series.linkCreatedAt.getTime() < series.listFloorAt.getTime();
}

/** The delta of a link over [startAt, endAt). Null when the link has no
 * snapshot before `endAt`. Pure. */
export function linkDeltaBetween(series: LinkSeries, startAt: Date, endAt: Date): LinkDelta | null {
  const points = series.points;
  const endIndex = lastIndexBefore(points, endAt);
  if (endIndex < 0) {
    return null;
  }
  const startIndex = lastIndexBefore(points, startAt);
  const endPoint = points[endIndex]!;
  const startPoint = startIndex >= 0 ? points[startIndex]! : null;
  const flags = new Set<OfLinkDeltaFlag>();
  if (startPoint === null && predatesList(series)) {
    flags.add("starts_before_series");
  }
  // Transitions inside the delta: into every point after the start, up to
  // and including the end (without a start, from the link's first point).
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    const previous = index > 0 ? points[index - 1]! : null;
    if (pointRecalculatedMoney(points, index)) {
      flags.add("vendor_recalculated");
    }
    if (pointChangedBinding(previous, points[index]!)) {
      flags.add("binding_changed");
    }
  }
  const endMoney = lastKnownMoneyAtOrBefore(points, endIndex);
  let netMills: bigint | null;
  if (endMoney === null) {
    netMills = null;
  } else if (startPoint === null) {
    netMills = endMoney;
  } else {
    const startMoney = lastKnownMoneyAtOrBefore(points, startIndex);
    netMills = startMoney === null ? null : endMoney - startMoney;
  }
  if (netMills === null) {
    flags.add("money_unknown");
  }
  const clicks = endPoint.clicks - (startPoint?.clicks ?? 0);
  const subscribers = endPoint.subscribers - (startPoint?.subscribers ?? 0);
  const claims = series.linkKind === "trial" && endPoint.claims !== null
    ? endPoint.claims - (startPoint?.claims ?? 0)
    : null;
  return {
    startPoint,
    endPoint,
    clicks,
    claims,
    subscribers,
    fans: series.linkKind === "trial" ? claims : subscribers,
    netMills,
    flags: sortDeltaFlags(flags),
  };
}

// ---------------------------------------------------------------------------
// Channels and contractors.

export interface TrafficIntervalLike {
  validFrom: Date;
  validTo: Date | null;
  validFromBasis: TrafficValidFromBasis;
}

export interface LinkBindingInterval extends TrafficIntervalLike {
  channelKey: string;
}

export interface ChannelTermInterval extends TrafficIntervalLike {
  contractorKey: string;
}

export interface LinkSegment {
  series: LinkSeries;
  channelKey: string | null;
  contractorKey: string | null;
  startAt: Date;
  endAt: Date;
  delta: LinkDelta;
}

const FAR_FUTURE_MS = 8.64e15;

function clip(interval: TrafficIntervalLike, fromMs: number, toMs: number): [number, number] | null {
  const start = Math.max(interval.validFrom.getTime(), fromMs);
  const end = Math.min(interval.validTo?.getTime() ?? FAR_FUTURE_MS, toMs);
  return start < end ? [start, end] : null;
}

/** Splits [fromMs, toMs) by intervals that never overlap one another (the
 * store guarantees one binding per instant, one contractor per instant):
 * covered pieces carry their interval, the gaps carry null. Sorted. */
export function splitByIntervals<T extends TrafficIntervalLike>(
  intervals: readonly T[],
  fromMs: number,
  toMs: number,
): Array<{ startMs: number; endMs: number; interval: T | null }> {
  const covered = intervals
    .map((interval) => ({ interval, range: clip(interval, fromMs, toMs) }))
    .filter((item): item is { interval: T; range: [number, number] } => item.range !== null)
    .sort((left, right) => left.range[0] - right.range[0]);
  const pieces: Array<{ startMs: number; endMs: number; interval: T | null }> = [];
  let cursor = fromMs;
  for (const { interval, range: [start, end] } of covered) {
    if (start > cursor) {
      pieces.push({ startMs: cursor, endMs: start, interval: null });
    }
    const pieceStart = Math.max(start, cursor);
    if (end > pieceStart) {
      pieces.push({ startMs: pieceStart, endMs: end, interval });
      cursor = end;
    }
  }
  if (cursor < toMs) {
    pieces.push({ startMs: cursor, endMs: toMs, interval: null });
  }
  return pieces;
}

/** Every segment of one link over [from, to): cut by its bindings, each bound
 * piece cut again by its channel's contractor terms. Pieces before the
 * link's first snapshot carry nothing and are left out. Pure. */
export function linkSegments(
  series: LinkSeries,
  bindings: readonly LinkBindingInterval[],
  termsByChannel: ReadonlyMap<string, readonly ChannelTermInterval[]>,
  from: Date,
  to: Date,
): LinkSegment[] {
  const segments: LinkSegment[] = [];
  const push = (
    startMs: number,
    endMs: number,
    binding: LinkBindingInterval | null,
    term: ChannelTermInterval | null,
  ) => {
    const startAt = new Date(startMs);
    const endAt = new Date(endMs);
    const delta = linkDeltaBetween(series, startAt, endAt);
    if (delta === null) {
      return;
    }
    const flags = new Set(delta.flags);
    if (binding?.validFromBasis === "assumed_link_created") {
      flags.add("assumed_binding_start");
    }
    if (term?.validFromBasis === "assumed_link_created") {
      flags.add("assumed_contractor_start");
    }
    segments.push({
      series,
      channelKey: binding?.channelKey ?? null,
      contractorKey: term?.contractorKey ?? null,
      startAt,
      endAt,
      delta: { ...delta, flags: sortDeltaFlags(flags) },
    });
  };
  for (const piece of splitByIntervals(bindings, from.getTime(), to.getTime())) {
    if (piece.interval === null) {
      push(piece.startMs, piece.endMs, null, null);
      continue;
    }
    const terms = termsByChannel.get(piece.interval.channelKey) ?? [];
    for (const termPiece of splitByIntervals(terms, piece.startMs, piece.endMs)) {
      push(termPiece.startMs, termPiece.endMs, piece.interval, termPiece.interval);
    }
  }
  return segments;
}

export interface SegmentTotals {
  linkCount: number;
  clicks: number;
  claims: number;
  subscribers: number;
  fans: number;
  netMills: bigint;
  flags: OfLinkDeltaFlag[];
}

/** Sums segments; money over the segments that know it (the others carry
 * money_unknown, which the union of flags keeps). `exclude` drops flags that
 * do not concern the group (a channel's total does not rest on its
 * contractor's start). */
export function totalSegments(
  segments: readonly LinkSegment[],
  exclude: readonly OfLinkDeltaFlag[] = [],
): SegmentTotals {
  const links = new Set<string>();
  const flags = new Set<OfLinkDeltaFlag>();
  let clicks = 0;
  let claims = 0;
  let subscribers = 0;
  let fans = 0;
  let netMills = 0n;
  for (const segment of segments) {
    links.add(`${segment.series.pageId}:${segment.series.linkKind}:${segment.series.linkRef}`);
    clicks += segment.delta.clicks;
    claims += segment.delta.claims ?? 0;
    subscribers += segment.delta.subscribers;
    fans += segment.delta.fans ?? 0;
    netMills += segment.delta.netMills ?? 0n;
    for (const flag of segment.delta.flags) {
      if (!exclude.includes(flag)) {
        flags.add(flag);
      }
    }
  }
  return { linkCount: links.size, clicks, claims, subscribers, fans, netMills, flags: sortDeltaFlags(flags) };
}
