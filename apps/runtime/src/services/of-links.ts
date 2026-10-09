// «Ссылки OnlyFans» (traffic sources plan §2.6, PR 12): the owner's read of
// the link series, the "link → channel → contractor" bindings and the
// series' collection state, shaped for the dashboard. Local reads only: no
// vendor egress, no writes.
//
// Hub's own money (PR 13) has its place in every response already. Each
// place is filled by one of the `hub…NotComputed` builders below; PR 13
// replaces them with its attribution, and nothing else here has to change.

import {
  OF_LINKS_ATTRIBUTION_RULE,
  OF_LINKS_BUSINESS_TIME_ZONE,
  OF_LINKS_REVENUE_BASIS,
  type OfLink,
  type OfLinkChannelsResponse,
  type OfLinkHistoryResponse,
  type OfLinkHubMoney,
  type OfLinkHubMoneyTotal,
  type OfLinkMoneyComparison,
  type OfLinksResponse,
} from "@agency_hub_core/contracts";
import {
  linkDeltaBetween,
  linkSegments,
  listLastLinkRecalculations,
  listLatestLinkSnapshots,
  listLinkSeries,
  listLinkSeriesAccountChanges,
  listLinkSeriesAttempts,
  listLinkSeriesListFloors,
  listLinkSeriesPairStates,
  listLinkSeriesWindowResults,
  listLinkSnapshotHistory,
  listOfLinkPages,
  pointChangedBinding,
  pointRecalculatedMoney,
  readLinkSeriesFloor,
  readTrafficBindingsSnapshot,
  totalSegments,
  type ChannelTermInterval,
  type Database,
  type LinkBindingInterval,
  type LinkSegment,
  type LinkSeriesAttemptRow,
  type LinkSeriesPoint,
  type LinkStatKind,
  type TrafficBindingsSnapshot,
} from "@agency_hub_core/db";
import {
  businessDateToUtcStart,
  diffBusinessDays,
  MOSCOW_TIME_ZONE,
  nextBusinessDate,
  previousBusinessDate,
  toBusinessDate,
} from "@agency_hub_core/shared";

import { findStaleLinkStatPairs, OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS } from "./ofapi-link-stats-monitor.ts";
import { nextOfapiLinkStatsWindowAt } from "./ofapi-link-stats-windows.ts";

/** The history's default and longest range, in business days. */
export const OF_LINK_HISTORY_DEFAULT_DAYS = 30;
export const OF_LINK_RANGE_MAX_DAYS = 400;

/** A request the routes answer 400 or 404. */
export class OfLinksRequestError extends Error {
  constructor(readonly kind: "bad_request" | "not_found", message: string) {
    super(message);
  }
}

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value === null ? null : value.toISOString());

/** Mills on the wire are a JSON number; past 2^53 a number stops counting,
 * and money that stops counting is a wrong amount served as a fact. */
function millsNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error("a stored money amount exceeds the range this API can serve without losing precision");
  }
  return result;
}
const millsOrNull = (value: bigint | null) => (value === null ? null : millsNumber(value));

// ---------------------------------------------------------------------------
// Hub's own money (PR 13 fills these).

export function hubMoneyNotComputed(): OfLinkHubMoney {
  return {
    state: "no_data",
    reason: "not_computed",
    revenueBasis: OF_LINKS_REVENUE_BASIS,
    attributionRule: OF_LINKS_ATTRIBUTION_RULE,
    floorAt: null,
    netMills: null,
    pendingMills: null,
    transactionCount: null,
    fanCount: null,
  };
}

export function hubMoneyTotalNotComputed(): OfLinkHubMoneyTotal {
  return {
    state: "no_data",
    reason: "not_computed",
    revenueBasis: OF_LINKS_REVENUE_BASIS,
    attributionRule: OF_LINKS_ATTRIBUTION_RULE,
    netMills: null,
    pendingMills: null,
  };
}

export function comparisonWithoutHubMoney(): OfLinkMoneyComparison {
  return {
    state: null,
    flags: [],
    fromAt: null,
    toAt: null,
    vendorDeltaMills: null,
    hubNetMills: null,
    differenceMills: null,
  };
}

// ---------------------------------------------------------------------------
// Shared pieces.

const fansMetricOf = (kind: LinkStatKind) => (kind === "trial" ? "claims" as const : "subscribers" as const);
const fansOf = (kind: LinkStatKind, claims: number | null, subscribers: number) =>
  (kind === "trial" ? claims : subscribers);
const linkKey = (pageId: number, kind: string, ref: string) => `${pageId}:${kind}:${ref}`;

/** expired: the link's end has passed; finished: OFAPI marks it finished
 * before its end; active otherwise. */
export function ofLinkState(input: { linkEndsAt: Date | null; isFinished: boolean | null }, now: Date) {
  if (input.linkEndsAt !== null && input.linkEndsAt.getTime() <= now.getTime()) {
    return "expired" as const;
  }
  return input.isFinished === true ? "finished" as const : "active" as const;
}

function attemptOut(row: LinkSeriesAttemptRow) {
  return {
    runRef: String(row.runId),
    observedAt: iso(row.pulledAt),
    businessDate: toBusinessDate(row.pulledAt, MOSCOW_TIME_ZONE),
    windowAt: isoOrNull(row.windowAt),
    attempt: row.attempt,
    status: row.status,
    reason: row.reason,
    usable: row.usable,
  };
}

function indexBindings(snapshot: TrafficBindingsSnapshot) {
  const bindingsByLink = new Map<string, LinkBindingInterval[]>();
  for (const binding of snapshot.bindings) {
    const key = linkKey(binding.platformAccountId, binding.linkKind, binding.platformLinkId);
    const list = bindingsByLink.get(key) ?? [];
    list.push({
      channelKey: binding.channelKey,
      validFrom: binding.validFrom,
      validTo: binding.validTo,
      validFromBasis: binding.validFromBasis,
    });
    bindingsByLink.set(key, list);
  }
  const termsByChannel = new Map<string, ChannelTermInterval[]>();
  for (const term of snapshot.terms) {
    const list = termsByChannel.get(term.channelKey) ?? [];
    list.push({
      contractorKey: term.contractorKey,
      validFrom: term.validFrom,
      validTo: term.validTo,
      validFromBasis: term.validFromBasis,
    });
    termsByChannel.set(term.channelKey, list);
  }
  return {
    bindingsByLink,
    termsByChannel,
    channelTitles: new Map(snapshot.channels.map((channel) => [channel.key, channel.title])),
    contractorTitles: new Map(snapshot.contractors.map((contractor) => [contractor.key, contractor.title])),
  };
}

const covers = (interval: { validFrom: Date; validTo: Date | null }, at: Date) =>
  interval.validFrom.getTime() <= at.getTime()
  && (interval.validTo === null || at.getTime() < interval.validTo.getTime());

function contractorTermOut(term: ChannelTermInterval, titles: ReadonlyMap<string, string>) {
  return {
    contractorKey: term.contractorKey,
    contractorTitle: titles.get(term.contractorKey) ?? term.contractorKey,
    validFrom: iso(term.validFrom),
    validTo: isoOrNull(term.validTo),
    validFromBasis: term.validFromBasis,
  };
}

/** The binding open now, else the latest one that has started; with the
 * channel's contractor at that binding's last instant. */
function linkBindingOut(
  bindings: readonly LinkBindingInterval[] | undefined,
  index: ReturnType<typeof indexBindings>,
  now: Date,
): OfLink["binding"] {
  const started = (bindings ?? []).filter((binding) => binding.validFrom.getTime() <= now.getTime());
  if (started.length === 0) {
    return null;
  }
  const binding = started.find((candidate) => covers(candidate, now))
    ?? [...started].sort((left, right) => right.validFrom.getTime() - left.validFrom.getTime())[0]!;
  const at = binding.validTo === null || binding.validTo.getTime() > now.getTime()
    ? now
    : new Date(binding.validTo.getTime() - 1);
  const term = (index.termsByChannel.get(binding.channelKey) ?? []).find((candidate) => covers(candidate, at)) ?? null;
  return {
    channelKey: binding.channelKey,
    channelTitle: index.channelTitles.get(binding.channelKey) ?? binding.channelKey,
    validFrom: iso(binding.validFrom),
    validTo: isoOrNull(binding.validTo),
    validFromBasis: binding.validFromBasis,
    contractor: term === null ? null : contractorTermOut(term, index.contractorTitles),
  };
}

async function requirePage(db: Database, pageId: number) {
  const [page] = await listOfLinkPages(db, { pageId });
  if (page === undefined) {
    throw new OfLinksRequestError("not_found", "No OnlyFans page with this id");
  }
  return page;
}

/** [from 00:00, the day after `to` 00:00) in Moscow, clipped at `now`. */
function resolveRange(from: string, to: string, now: Date) {
  if (from > to) {
    throw new OfLinksRequestError("bad_request", "`from` is after `to`");
  }
  const today = toBusinessDate(now, MOSCOW_TIME_ZONE);
  if (from > today) {
    throw new OfLinksRequestError("bad_request", "`from` is in the future");
  }
  if (diffBusinessDays(from, to) > OF_LINK_RANGE_MAX_DAYS) {
    throw new OfLinksRequestError("bad_request", `The range is longer than ${OF_LINK_RANGE_MAX_DAYS} days`);
  }
  const fromAt = businessDateToUtcStart(from, MOSCOW_TIME_ZONE);
  const endOfTo = businessDateToUtcStart(nextBusinessDate(to), MOSCOW_TIME_ZONE);
  const toAt = endOfTo.getTime() < now.getTime() ? endOfTo : now;
  return { from, to, fromAt, toAt };
}

function generated(now: Date, seriesFloorAt: Date | null) {
  return {
    generatedAt: iso(now),
    businessTimeZone: OF_LINKS_BUSINESS_TIME_ZONE,
    revenueBasis: OF_LINKS_REVENUE_BASIS,
    seriesFloorAt: isoOrNull(seriesFloorAt),
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/of-links

export async function getOfLinks(db: Database, input: { pageId?: number | undefined; now: Date }): Promise<OfLinksResponse> {
  const { now } = input;
  const pages = await listOfLinkPages(db);
  if (input.pageId !== undefined && !pages.some((page) => page.pageId === input.pageId)) {
    // An inactive page is still answered for its own links; an unknown one is a 404.
    pages.push(await requirePage(db, input.pageId));
  }
  const allPageIds = pages.map((page) => page.pageId);
  const linkPageIds = input.pageId === undefined ? allPageIds : [input.pageId];

  const [seriesFloorAt, pairs, snapshots, recalculations, accountChanges, bindingsSnapshot] = await Promise.all([
    readLinkSeriesFloor(db),
    listLinkSeriesPairStates(db, { pageIds: allPageIds }),
    listLatestLinkSnapshots(db, { pageIds: linkPageIds }),
    listLastLinkRecalculations(db, { pageIds: linkPageIds }),
    listLinkSeriesAccountChanges(db, { pageIds: linkPageIds }),
    readTrafficBindingsSnapshot(db),
  ]);

  // The series monitor's own rule. A pair never attempted at all is not
  // judged here (the monitor answers for it from the schedule's anchor).
  const staleByPair = new Map<string, Date>();
  for (const page of pages) {
    const pagePairs = pairs.filter((pair) => pair.platformAccountId === page.pageId);
    for (const stalePair of findStaleLinkStatPairs(pagePairs, now, () => null)) {
      staleByPair.set(`${page.pageId}:${stalePair.linkKind}`, stalePair.since);
    }
  }

  const usableRunByPair = new Map(
    pairs.map((pair) => [`${pair.platformAccountId}:${pair.linkKind}`, pair.lastUsableRunId]),
  );
  const recalculationByLink = new Map(
    recalculations.map((row) => [linkKey(row.platformAccountId, row.linkKind, row.platformLinkId), row]),
  );
  const bindingIndex = indexBindings(bindingsSnapshot);

  const links: OfLink[] = snapshots.map((row) => {
    const key = linkKey(row.platformAccountId, row.linkKind, row.platformLinkId);
    const recalculation = recalculationByLink.get(key) ?? null;
    const accountChangedAt = recalculation === null
      ? null
      : accountChanges
        .filter((change) => change.platformAccountId === row.platformAccountId
          && change.linkKind === row.linkKind
          && change.at.getTime() <= recalculation.observedAt.getTime())
        .at(-1)?.at ?? null;
    return {
      pageId: row.platformAccountId,
      linkKind: row.linkKind,
      linkRef: row.platformLinkId,
      name: row.name,
      url: row.url,
      linkCreatedAt: isoOrNull(row.linkCreatedAt),
      linkEndsAt: isoOrNull(row.linkEndsAt),
      isFinished: row.isFinished,
      state: ofLinkState(row, now),
      trialDays: row.trialDays,
      tags: row.tags,
      observedAt: iso(row.observedAt),
      businessDate: toBusinessDate(row.observedAt, MOSCOW_TIME_ZONE),
      runRef: String(row.runId),
      inLatestRun: usableRunByPair.get(`${row.platformAccountId}:${row.linkKind}`) === row.runId,
      clicks: row.clicks,
      claims: row.claims,
      subscribers: row.subscribers,
      spenders: row.spenders,
      fans: fansOf(row.linkKind, row.claims, row.subscribers),
      fansMetric: fansMetricOf(row.linkKind),
      vendorMoney: {
        revenueBasis: OF_LINKS_REVENUE_BASIS,
        netMills: millsOrNull(row.netMills),
        chargebacksMills: millsOrNull(row.chargebacksMills),
        calculatedAt: isoOrNull(row.revenueCalculatedAt),
        isLoading: row.revenueIsLoading,
        lastRecalculation: recalculation === null ? null : {
          observedAt: iso(recalculation.observedAt),
          previousObservedAt: iso(recalculation.previousObservedAt),
          fromMills: millsNumber(recalculation.fromMills),
          toMills: millsNumber(recalculation.toMills),
          bindingChanged: recalculation.bindingChanged,
          accountChangedAt: isoOrNull(accountChangedAt),
        },
      },
      hubMoney: hubMoneyNotComputed(),
      comparison: comparisonWithoutHubMoney(),
      binding: linkBindingOut(bindingIndex.bindingsByLink.get(key), bindingIndex, now),
    };
  });

  return {
    ...generated(now, seriesFloorAt),
    staleAfterHours: OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS / 3_600_000,
    pages: pages.map((page) => ({
      pageId: page.pageId,
      pageLabel: page.pageLabel,
      ofapiMapped: page.ofapiAccountId !== null,
      ofapiAuthStatus: page.ofapiAuthStatus,
      kinds: pairs
        .filter((pair) => pair.platformAccountId === page.pageId)
        .map((pair) => {
          const staleSince = staleByPair.get(`${page.pageId}:${pair.linkKind}`) ?? null;
          return {
            linkKind: pair.linkKind,
            lastUsableAt: isoOrNull(pair.lastUsableAt),
            lastUsableRunRef: pair.lastUsableRunId === null ? null : String(pair.lastUsableRunId),
            linkCount: pair.lastUsableLinkCount,
            lastAttempt: pair.lastAttempt === null ? null : attemptOut(pair.lastAttempt),
            stale: staleSince !== null,
            staleSince: isoOrNull(staleSince),
          };
        }),
    })),
    links,
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/of-links/history

export async function getOfLinkHistory(db: Database, input: {
  pageId: number;
  linkKind: LinkStatKind;
  linkRef: string;
  from?: string | undefined;
  to?: string | undefined;
  now: Date;
}): Promise<OfLinkHistoryResponse> {
  const { now } = input;
  const page = await requirePage(db, input.pageId);
  const to = input.to ?? toBusinessDate(now, MOSCOW_TIME_ZONE);
  let from = input.from;
  if (from === undefined) {
    from = to;
    for (let day = 1; day < OF_LINK_HISTORY_DEFAULT_DAYS; day += 1) {
      from = previousBusinessDate(from);
    }
  }
  const range = resolveRange(from, to, now);

  const history = await listLinkSnapshotHistory(db, {
    pageId: input.pageId,
    linkKind: input.linkKind,
    linkRef: input.linkRef,
    before: new Date(Math.max(now.getTime(), range.toAt.getTime()) + 1),
  });
  if (history.length === 0) {
    throw new OfLinksRequestError("not_found", "The series has never seen this link");
  }
  const [seriesFloorAt, listFloors, attempts, windows, meta] = await Promise.all([
    readLinkSeriesFloor(db),
    listLinkSeriesListFloors(db, { pageIds: [input.pageId] }),
    listLinkSeriesAttempts(db, { pageId: input.pageId, linkKind: input.linkKind, from: range.fromAt, to: range.toAt }),
    listLinkSeriesWindowResults(db, { pageId: input.pageId, linkKind: input.linkKind, from: range.fromAt, to: range.toAt }),
    listLatestLinkSnapshots(db, { pageIds: [input.pageId] }),
  ]);
  const latest = meta.find((row) => row.linkKind === input.linkKind && row.platformLinkId === input.linkRef) ?? null;

  const points: LinkSeriesPoint[] = history.map((row) => ({
    observedAt: row.observedAt,
    runId: row.runId,
    ofapiAccountId: row.ofapiAccountId,
    runReason: row.runReason,
    clicks: row.clicks,
    claims: row.claims,
    subscribers: row.subscribers,
    netMills: row.netMills,
  }));
  const series = {
    pageId: input.pageId,
    linkKind: input.linkKind,
    linkRef: input.linkRef,
    linkCreatedAt: latest?.linkCreatedAt ?? null,
    listFloorAt: listFloors.get(`${input.pageId}:${input.linkKind}`) ?? null,
    points: points.filter((point) => point.observedAt.getTime() < range.toAt.getTime()),
  };

  const snapshots = history.flatMap((row, index) => {
    const at = row.observedAt.getTime();
    if (at < range.fromAt.getTime() || at >= range.toAt.getTime()) {
      return [];
    }
    return [{
      runRef: String(row.runId),
      observedAt: iso(row.observedAt),
      businessDate: toBusinessDate(row.observedAt, MOSCOW_TIME_ZONE),
      windowAt: isoOrNull(row.windowAt),
      runStatus: row.runStatus,
      runReason: row.runReason,
      clicks: row.clicks,
      claims: row.claims,
      subscribers: row.subscribers,
      spenders: row.spenders,
      fans: fansOf(input.linkKind, row.claims, row.subscribers),
      vendorNetMills: millsOrNull(row.netMills),
      vendorChargebacksMills: millsOrNull(row.chargebacksMills),
      vendorCalculatedAt: isoOrNull(row.revenueCalculatedAt),
      vendorIsLoading: row.revenueIsLoading,
      isFinished: row.isFinished,
      linkEndsAt: isoOrNull(row.linkEndsAt),
      bindingChanged: pointChangedBinding(index > 0 ? points[index - 1]! : null, points[index]!),
      vendorRecalculated: pointRecalculatedMoney(points, index),
    }];
  });

  const days: OfLinkHistoryResponse["days"] = [];
  for (let day = range.from; day <= range.to; day = nextBusinessDate(day)) {
    const dayStart = businessDateToUtcStart(day, MOSCOW_TIME_ZONE);
    if (dayStart.getTime() >= range.toAt.getTime()) {
      break;
    }
    const nextStart = businessDateToUtcStart(nextBusinessDate(day), MOSCOW_TIME_ZONE);
    const dayEnd = nextStart.getTime() < range.toAt.getTime() ? nextStart : range.toAt;
    const delta = linkDeltaBetween(series, dayStart, dayEnd);
    // A window counts as missed once it has closed without a usable result.
    const missedWindows = windows.firstWindowAt === null || dayEnd.getTime() <= windows.firstWindowAt.getTime()
      ? null
      : windows.windows.filter((window) =>
        window.windowAt.getTime() >= dayStart.getTime()
        && window.windowAt.getTime() < dayEnd.getTime()
        && !window.usable
        && nextOfapiLinkStatsWindowAt(window.windowAt).getTime() <= now.getTime()).length;
    days.push({
      businessDate: day,
      dayStartAt: iso(dayStart),
      dayEndAt: iso(dayEnd),
      startObservedAt: delta?.startPoint ? iso(delta.startPoint.observedAt) : null,
      endObservedAt: delta ? iso(delta.endPoint.observedAt) : null,
      clicks: delta?.clicks ?? null,
      claims: delta?.claims ?? null,
      subscribers: delta?.subscribers ?? null,
      fans: delta?.fans ?? null,
      vendorNetMills: delta === null ? null : millsOrNull(delta.netMills),
      missedWindows,
      flags: delta?.flags ?? [],
      hub: null,
    });
  }

  return {
    ...generated(now, seriesFloorAt),
    pageId: page.pageId,
    pageLabel: page.pageLabel,
    linkKind: input.linkKind,
    linkRef: input.linkRef,
    name: latest?.name ?? null,
    linkCreatedAt: isoOrNull(latest?.linkCreatedAt ?? null),
    fansMetric: fansMetricOf(input.linkKind),
    range: { from: range.from, to: range.to, fromAt: iso(range.fromAt), toAt: iso(range.toAt) },
    snapshots,
    attempts: attempts.map(attemptOut),
    days,
    hubMoney: hubMoneyNotComputed(),
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/of-links/channels

function totalsOut(segments: readonly LinkSegment[]) {
  const totals = totalSegments(segments);
  return {
    totals: {
      linkCount: totals.linkCount,
      clicks: totals.clicks,
      claims: totals.claims,
      subscribers: totals.subscribers,
      fans: totals.fans,
      vendorNetMills: millsNumber(totals.netMills),
      hubMoney: hubMoneyTotalNotComputed(),
    },
    flags: totals.flags,
  };
}

const compareKeys = (left: string | null, right: string | null) =>
  left === right ? 0 : left === null ? 1 : right === null ? -1 : left < right ? -1 : 1;

export async function getOfLinkChannels(db: Database, input: {
  from?: string | undefined;
  to?: string | undefined;
  pageId?: number | undefined;
  now: Date;
}): Promise<OfLinkChannelsResponse> {
  const { now } = input;
  const seriesFloorAt = await readLinkSeriesFloor(db);
  const today = toBusinessDate(now, MOSCOW_TIME_ZONE);
  const range = resolveRange(
    input.from ?? (seriesFloorAt === null ? today : toBusinessDate(seriesFloorAt, MOSCOW_TIME_ZONE)),
    input.to ?? today,
    now,
  );
  let pages = await listOfLinkPages(db);
  if (input.pageId !== undefined) {
    const page = await requirePage(db, input.pageId);
    pages = [page];
  }
  const pageLabels = new Map(pages.map((page) => [page.pageId, page.pageLabel]));
  const [allSeries, bindingsSnapshot] = await Promise.all([
    listLinkSeries(db, { pageIds: pages.map((page) => page.pageId), before: range.toAt }),
    readTrafficBindingsSnapshot(db),
  ]);
  const index = indexBindings(bindingsSnapshot);

  // A channel's segments are cut by bindings alone, a contractor's by the
  // bindings and the contractor terms: a term added or moved inside a binding
  // changes who brought what, never the channel's own total.
  const segmentsOf = (terms: typeof index.termsByChannel | null) => allSeries.flatMap((series) =>
    linkSegments(
      series,
      index.bindingsByLink.get(linkKey(series.pageId, series.linkKind, series.linkRef)) ?? [],
      terms,
      range.fromAt,
      range.toAt,
    ));
  const channelSegments = segmentsOf(null);
  const contractorSegments = segmentsOf(index.termsByChannel);
  const names = new Map(allSeries.map((series) => [linkKey(series.pageId, series.linkKind, series.linkRef), series.name]));

  const segmentOut = (segment: LinkSegment) => ({
    pageId: segment.series.pageId,
    pageLabel: pageLabels.get(segment.series.pageId) ?? String(segment.series.pageId),
    linkKind: segment.series.linkKind,
    linkRef: segment.series.linkRef,
    name: names.get(linkKey(segment.series.pageId, segment.series.linkKind, segment.series.linkRef)) ?? null,
    channelKey: segment.channelKey,
    contractorKey: segment.contractorKey,
    startAt: iso(segment.startAt),
    endAt: iso(segment.endAt),
    startObservedAt: segment.delta.startPoint ? iso(segment.delta.startPoint.observedAt) : null,
    endObservedAt: iso(segment.delta.endPoint.observedAt),
    clicks: segment.delta.clicks,
    claims: segment.delta.claims,
    subscribers: segment.delta.subscribers,
    fans: segment.delta.fans,
    vendorNetMills: millsOrNull(segment.delta.netMills),
    flags: segment.delta.flags,
  });

  const groupBy = (segments: readonly LinkSegment[], keyOf: (segment: LinkSegment) => string | null) => {
    const groups = new Map<string | null, LinkSegment[]>();
    for (const segment of segments) {
      const key = keyOf(segment);
      groups.set(key, [...(groups.get(key) ?? []), segment]);
    }
    return [...groups.entries()].sort(([left], [right]) => compareKeys(left, right));
  };
  const segmentOrder = (left: LinkSegment, right: LinkSegment) =>
    left.series.pageId - right.series.pageId
    || left.series.linkKind.localeCompare(right.series.linkKind)
    || left.series.linkRef.length - right.series.linkRef.length
    || left.series.linkRef.localeCompare(right.series.linkRef)
    || left.startAt.getTime() - right.startAt.getTime();

  const channels = groupBy(channelSegments, (segment) => segment.channelKey)
    .map(([channelKey, segments]) => ({
      channelKey,
      channelTitle: channelKey === null ? null : index.channelTitles.get(channelKey) ?? channelKey,
      contractors: channelKey === null
        ? []
        : (index.termsByChannel.get(channelKey) ?? [])
          .filter((term) =>
            term.validFrom.getTime() < range.toAt.getTime()
            && (term.validTo === null || term.validTo.getTime() > range.fromAt.getTime()))
          .map((term) => contractorTermOut(term, index.contractorTitles)),
      ...totalsOut(segments),
      segments: [...segments].sort(segmentOrder).map(segmentOut),
    }));

  const contractors = groupBy(contractorSegments, (segment) => segment.contractorKey)
    .map(([contractorKey, segments]) => ({
      contractorKey,
      contractorTitle: contractorKey === null ? null : index.contractorTitles.get(contractorKey) ?? contractorKey,
      channelKeys: [...new Set(segments
        .map((segment) => segment.channelKey)
        .filter((key): key is string => key !== null))].sort(),
      ...totalsOut(segments),
      segments: [...segments].sort(segmentOrder).map(segmentOut),
    }));

  return {
    ...generated(now, seriesFloorAt),
    range: { from: range.from, to: range.to, fromAt: iso(range.fromAt), toAt: iso(range.toAt) },
    channels,
    contractors,
  };
}
