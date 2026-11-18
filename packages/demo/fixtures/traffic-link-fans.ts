/**
 * The page of one link, beside traffic-sources.ts: the fans each demo link
 * brought (`ofLinkFansGet`), the link's source when it has none
 * (`ofLinkSourceGet`, and `ofLinkSourcePut`, kept in memory so the control can
 * be tried), and the cards «Ждут вас» → Трафик of the links without a source.
 * Invented fans of the demo pages (world.ts). Covers: a paying fan, one who
 * never paid, one who left, unknown money, a trial link (no money at all), a
 * link never walked (the shoutout born two days ago, the newest X link), links
 * with more than 20 fans; a new link without a source whose name says which it
 * probably is («Twitter Rounds Two» → X), and links without one that say
 * nothing.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { proposeTrafficSource } from "@agency_hub_core/shared";

import { between, demoError, iso, isDemoReply, mills, queryNumber, queryString, rng, type DemoHandler, type DemoHandlers, type DemoRequest } from "../core.ts";
import { demoFans } from "../world.ts";
import { DAY_MS, HOUR_MS, OF_PAGES, demoDigits, mskDayKey, mskDayStart } from "./publish-of-common.ts";
import { ofLinks } from "./publish-of-ofapi.ts";
import { trafficSourcesHandlers } from "./traffic-sources.ts";

type OfLink = KernelOperationResponse<"ofLinksGet">["links"][number];
type Fans = KernelOperationResponse<"ofLinkFansGet">;
type Fan = Fans["fans"][number];
type Source = KernelOperationResponse<"ofLinkSourceGet">;
type History = KernelOperationResponse<"ofLinksHistoryGet">;

const keyOf = (link: { pageId: number; linkKind: string; linkRef: string }) => `${link.pageId}:${link.linkKind}:${link.linkRef}`;

// ── A new link without a source ─────────────────────────────────────────────

/** Made this many days ago on the main page; its name says X. */
const NEW_LINK_DAYS = 5;
const NEW_LINK = { name: "Twitter Rounds Two", page: 0, kind: "tracking" as const };

function newLinkRef(): string {
  return demoDigits("traffic-link-fans:new", 8);
}

/** Its days: a few fans a day from the day it was made. */
function newLinkDay(day: string, made: string): { fans: number; clicks: number; money: number } | null {
  if (day < made) return null;
  const random = rng(`traffic-link-fans:new:${day}`);
  const fans = Math.round(between(random, 0.5, 4.4));
  const clicks = Math.round(fans * between(random, 1.6, 3) + between(random, 0, 4));
  return { fans, clicks, money: mills(fans * between(random, 2, 7)) };
}

function newLinkMadeAt(now: Date): number {
  return mskDayStart(now, -NEW_LINK_DAYS) + 14 * HOUR_MS;
}

/** The new links the demo's `ofLinksGet` lists beside the sources' (publish-of-ofapi.ts). */
export function demoNewLinks(now: Date): OfLink[] {
  const page = OF_PAGES[NEW_LINK.page] ?? OF_PAGES[0]!;
  const made = newLinkMadeAt(now);
  const lastRead = now.getTime() - 20 * 60_000;
  let fans = 0;
  let clicks = 0;
  let money = 0;
  for (let day = mskDayKey(made); day <= mskDayKey(now); day = mskDayKey(Date.parse(`${day}T12:00:00Z`) + DAY_MS)) {
    const figures = newLinkDay(day, mskDayKey(made));
    if (figures) {
      fans += figures.fans;
      clicks += figures.clicks;
      money += figures.money;
    }
  }
  return [{
    pageId: page.id,
    linkKind: NEW_LINK.kind,
    linkRef: newLinkRef(),
    name: NEW_LINK.name,
    url: `https://onlyfans.com/${page.username}/c${demoDigits("traffic-link-fans:url", 3)}`,
    linkCreatedAt: iso(new Date(made)),
    linkEndsAt: null,
    isFinished: null,
    state: "active",
    trialDays: null,
    tags: [],
    observedAt: iso(new Date(lastRead)),
    businessDate: mskDayKey(lastRead),
    runRef: "2001",
    inLatestRun: true,
    clicks,
    claims: null,
    subscribers: fans,
    spenders: Math.max(1, Math.round(fans * 0.2)),
    fans,
    fansMetric: "subscribers",
    vendorMoney: {
      revenueBasis: "creator_net_after_platform_fee", netMills: money, chargebacksMills: 0,
      calculatedAt: iso(new Date(lastRead - 40 * 60_000)), isLoading: false, lastRecalculation: null,
    },
    hubMoney: {
      state: "no_data", reason: "no_completed_walk", revenueBasis: "creator_net_after_platform_fee",
      attributionRule: "ofapi_subscription_period_equal_split.v1", floorAt: null, netMills: null, pendingMills: null,
      transactionCount: null, fanCount: null,
    },
    comparison: { state: null, flags: [], fromAt: null, toAt: null, vendorDeltaMills: null, hubNetMills: null, differenceMills: null },
    binding: null,
  }];
}

/** `ofLinksHistoryGet` that knows the new link too; every other link is the sources' (traffic-sources.ts). */
export function historyWithNewLinks(base: DemoHandler<"ofLinksHistoryGet">): DemoHandler<"ofLinksHistoryGet"> {
  return (request) => {
    const page = OF_PAGES[NEW_LINK.page] ?? OF_PAGES[0]!;
    if (Number(queryString(request, "pageId")) !== page.id || queryString(request, "linkKind") !== NEW_LINK.kind || queryString(request, "linkRef") !== newLinkRef()) {
      return base(request);
    }
    const { now } = request;
    const made = mskDayKey(newLinkMadeAt(now));
    const to = queryString(request, "to") ?? mskDayKey(now);
    const from = queryString(request, "from") ?? mskDayKey(Date.parse(`${to}T12:00:00Z`) - 29 * DAY_MS);
    const days: History["days"] = [];
    for (let day = from; day <= to; day = mskDayKey(Date.parse(`${day}T12:00:00Z`) + DAY_MS)) {
      const start = Date.parse(`${day}T00:00:00Z`) - 3 * HOUR_MS;
      if (start >= now.getTime()) break;
      const figures = newLinkDay(day, made);
      days.push({
        businessDate: day,
        dayStartAt: iso(new Date(start)),
        dayEndAt: iso(new Date(Math.min(start + DAY_MS, now.getTime()))),
        startObservedAt: figures === null || day === made ? null : iso(new Date(start + 50 * 60_000)),
        endObservedAt: figures === null ? null : iso(new Date(Math.min(now.getTime(), start + DAY_MS + 50 * 60_000))),
        clicks: figures?.clicks ?? null,
        claims: null,
        subscribers: figures?.fans ?? null,
        fans: figures?.fans ?? null,
        spenders: figures === null ? null : 0,
        vendorNetMills: figures?.money ?? null,
        missedWindows: 0,
        flags: [],
        hub: null,
      });
    }
    const link = demoNewLinks(now)[0]!;
    return {
      generatedAt: iso(now),
      businessTimeZone: "Europe/Moscow",
      revenueBasis: "creator_net_after_platform_fee",
      seriesFloorAt: iso(new Date(mskDayStart(now, -70) + 50 * 60_000)),
      pageId: page.id,
      pageLabel: page.label,
      linkKind: NEW_LINK.kind,
      linkRef: link.linkRef,
      name: link.name,
      linkCreatedAt: link.linkCreatedAt,
      fansMetric: "subscribers",
      range: { from, to, fromAt: iso(new Date(Date.parse(`${from}T00:00:00Z`) - 3 * HOUR_MS)), toAt: iso(new Date(Math.min(now.getTime(), Date.parse(`${to}T00:00:00Z`) - 3 * HOUR_MS + DAY_MS))) },
      snapshots: [],
      attempts: [],
      days,
      hubMoney: link.hubMoney,
    };
  };
}

// ── Sources given in the demo (kept in memory) ──────────────────────────────

const given = new Map<string, string>();

interface DemoSource { key: string; title: string; contractor: NonNullable<OfLink["binding"]>["contractor"]; linkNames: string[] }

/** The sources as the links show them: every channel a link is bound to, with its links' names. */
function sourcesOf(links: readonly OfLink[]): DemoSource[] {
  const byKey = new Map<string, DemoSource>();
  for (const link of links) {
    if (link.binding === null) continue;
    const source = byKey.get(link.binding.channelKey) ?? { key: link.binding.channelKey, title: link.binding.channelTitle, contractor: null, linkNames: [] };
    if (source.contractor === null && link.binding.contractor?.validTo === null) source.contractor = link.binding.contractor;
    if (link.name) source.linkNames.push(link.name);
    byKey.set(source.key, source);
  }
  return [...byKey.values()].sort((left, right) => left.title.localeCompare(right.title, "ru"));
}

/** The links with the sources given in the demo: what `ofLinksGet` answers after a «Назначить». */
export function withDemoSources(links: readonly OfLink[]): OfLink[] {
  if (given.size === 0) return [...links];
  const sources = sourcesOf(links);
  return links.map((link) => {
    const key = given.get(keyOf(link));
    const source = key === undefined ? undefined : sources.find((one) => one.key === key);
    if (link.binding !== null || source === undefined) return link;
    return {
      ...link,
      binding: {
        channelKey: source.key, channelTitle: source.title, validFrom: link.linkCreatedAt ?? link.observedAt, validTo: null,
        validFromBasis: "confirmed", contractor: source.contractor,
      },
    };
  });
}

function findLink(request: DemoRequest, from: "query" | "body"): OfLink | undefined {
  const read = (key: string) => (from === "query" ? queryString(request, key) : String((request.body as Record<string, unknown> | null)?.[key] ?? ""));
  const pageId = Number(read("pageId"));
  const kind = read("linkKind");
  const ref = read("linkRef");
  return ofLinks(request.now, undefined).links.find((link) => link.pageId === pageId && link.linkKind === kind && link.linkRef === ref);
}

function sourceAnswer(link: OfLink, links: readonly OfLink[]): Source {
  const sources = sourcesOf(links);
  const bound = link.binding !== null;
  const proposed = bound ? null : proposeTrafficSource(link.name, sources);
  const choice = (source: DemoSource) => ({ channelKey: source.key, channelTitle: source.title });
  const proposal = proposed === null ? undefined : sources.find((source) => source.key === proposed);
  return {
    pageId: link.pageId,
    linkKind: link.linkKind,
    linkRef: link.linkRef,
    bound,
    proposedChannel: proposal === undefined ? null : choice(proposal),
    channels: sources.map(choice),
  };
}

// ── The fans of a link ─────────────────────────────────────────────────────

/** Links whose fan lists the walks never read to the end: born a day or two ago. */
const NEVER_WALKED = new Set(["Шаутаут @luna.shares", "X · третий аккаунт", "Тест · новый"]);

function linkFans(link: OfLink, now: Date): { fans: Fan[]; walkedAt: string | null } {
  if (NEVER_WALKED.has(link.name ?? "")) return { fans: [], walkedAt: null };
  const page = OF_PAGES.find((one) => one.id === link.pageId) ?? OF_PAGES[0]!;
  const pool = demoFans(page.label);
  const random = rng(`traffic-link-fans:${keyOf(link)}`);
  const count = Math.min(pool.length, Math.max(0, link.linkKind === "trial" ? link.claims ?? 0 : link.subscribers));
  // The last walk: this morning's (03:10 Moscow), or last night's before it.
  const morning = mskDayStart(now, 0) + 3 * HOUR_MS + 10 * 60_000;
  const walkedAt = morning <= now.getTime() ? morning : morning - DAY_MS;
  const floor = mskDayStart(now, -25) + 3 * HOUR_MS;
  const made = link.linkCreatedAt === null ? null : Date.parse(link.linkCreatedAt);
  const ended = link.state !== "active";
  const order = pool.map((fan, index) => ({ fan, index, draw: random() })).sort((left, right) => left.draw - right.draw).slice(0, count);
  // Who paid: as many as the link's spenders, sharing what OnlyFans says the link brought; of the rest most never
  // paid and some the spenders list has not shown (unknown).
  const payers = link.linkKind === "trial" ? 0 : Math.min(count, link.spenders ?? 0);
  const weights = Array.from({ length: payers }, () => between(random, 0.05, 1) ** 2);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const brought = link.vendorMoney.netMills ?? 0;
  const fans = order.map(({ fan, index }, position): Fan => {
    const own = rng(`traffic-link-fans:${keyOf(link)}:${index}`);
    const start = made !== null && made > floor ? made : own() < 0.35 ? null : floor;
    const subscribedAt = start === null ? null : start + own() * Math.max(HOUR_MS, walkedAt - start);
    const paidMills = link.linkKind === "trial" ? null
      : position < payers ? Math.max(mills(1), mills(Math.floor((brought * weights[position]!) / weightSum / mills(1))))
        : own() < 0.8 ? 0 : null;
    return {
      fanId: 50_000 + index,
      fanRef: fan.platformUserId,
      name: fan.displayName,
      username: fan.username,
      deleted: false,
      subscribedAt: subscribedAt === null ? null : iso(new Date(subscribedAt)),
      firstSeenAt: iso(new Date(start === null ? floor : Math.max(subscribedAt ?? floor, floor))),
      status: ended || own() < 0.22 ? "left" : "active",
      paidMills,
    };
  });
  fans.sort((left, right) => (right.paidMills ?? -1) - (left.paidMills ?? -1)
    || (right.subscribedAt ?? right.firstSeenAt).localeCompare(left.subscribedAt ?? left.firstSeenAt));
  return { fans, walkedAt: iso(new Date(walkedAt)) };
}

// ── «Ждут вас» → Трафик ─────────────────────────────────────────────────────

/** The cards of the links without a source (the server's rule: not ended, made within 30 days or a fan within 14). */
export function demoLinkUnboundSeeds(request: DemoRequest) {
  const { now } = request;
  const links = withDemoSources(ofLinks(now, undefined).links);
  const pages = new Map(OF_PAGES.map((page) => [page.id, page.label]));
  const history = trafficSourcesHandlers.ofLinksHistoryGet!;
  const from = mskDayKey(now.getTime() - 13 * DAY_MS);
  return links.flatMap((link) => {
    if (link.binding !== null || link.state !== "active") return [];
    const made = link.linkCreatedAt === null ? null : Date.parse(link.linkCreatedAt);
    const recent = made !== null && now.getTime() - made <= 30 * DAY_MS;
    let gotFan = false;
    if (!recent) {
      const days = history({ ...request, query: { pageId: String(link.pageId), linkKind: link.linkKind, linkRef: link.linkRef, from } });
      gotFan = !isDemoReply(days) && days.days.some((day) => (day.fans ?? 0) > 0);
    }
    if (!recent && !gotFan) return [];
    const proposal = sourceAnswer(link, links).proposedChannel;
    const ref = keyOf(link);
    return [{
      kind: "traffic.link_unbound",
      key: `traffic.link_unbound:${ref}`,
      title: `Ссылка «${link.name ?? link.linkRef}» без источника`,
      pages: [pages.get(link.pageId) ?? ""].filter((label) => label !== ""),
      object: { type: "of_link", id: ref },
      evidence: {
        pageId: link.pageId, linkKind: link.linkKind, linkRef: link.linkRef, name: link.name,
        proposedChannel: proposal === null ? null : { key: proposal.channelKey, title: proposal.channelTitle },
        ...(recent ? { since: link.linkCreatedAt } : {}),
      },
      link: `/traffic/link/${ref.replaceAll(":", "/")}`,
      agoMs: recent && made !== null ? now.getTime() - made : 3 * HOUR_MS,
    }];
  });
}

// ── Answers ────────────────────────────────────────────────────────────────

export const trafficLinkFansHandlers: DemoHandlers = {
  ofLinkFansGet: (request) => {
    const link = findLink(request, "query");
    if (!link) return demoError(404, "Not Found", "The series has never seen this link");
    const limit = Math.min(100, Math.max(1, queryNumber(request, "limit", 20)));
    const offset = Math.max(0, queryNumber(request, "offset", 0));
    const { fans, walkedAt } = linkFans(link, request.now);
    const known = fans.filter((fan) => fan.paidMills !== null);
    return {
      generatedAt: iso(request.now),
      pageId: link.pageId,
      linkKind: link.linkKind,
      linkRef: link.linkRef,
      total: fans.length,
      paying: known.length === 0 ? null : known.filter((fan) => (fan.paidMills ?? 0) > 0).length,
      walkedAt,
      limit,
      offset,
      fans: fans.slice(offset, offset + limit),
    };
  },
  ofLinkSourceGet: (request) => {
    const links = withDemoSources(ofLinks(request.now, undefined).links);
    const link = findLink(request, "query");
    const shown = link && links.find((one) => keyOf(one) === keyOf(link));
    if (!shown) return demoError(404, "Not Found", "The series has never seen this link");
    return sourceAnswer(shown, links);
  },
  ofLinkSourcePut: (request) => {
    const links = withDemoSources(ofLinks(request.now, undefined).links);
    const link = findLink(request, "body");
    const shown = link && links.find((one) => keyOf(one) === keyOf(link));
    if (!shown) return demoError(404, "Not Found", "The series has never seen this link");
    if (shown.binding !== null) return demoError(409, "Conflict", "The link already has a source; change it with traffic:bindings:set");
    const channelKey = String((request.body as Record<string, unknown> | null)?.channelKey ?? "");
    if (!sourcesOf(links).some((source) => source.key === channelKey)) return demoError(400, "Bad Request", "No source with this key");
    given.set(keyOf(shown), channelKey);
    const after = withDemoSources(ofLinks(request.now, undefined).links);
    return { ...sourceAnswer(after.find((one) => keyOf(one) === keyOf(shown))!, after), validFrom: shown.linkCreatedAt ?? shown.observedAt };
  },
};
