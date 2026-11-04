/**
 * OnlyFans through the vendor (OnlyFans API): links, Smart Links, media,
 * typed exports, profile visitors and account actions of the two OnlyFans
 * pages. Collection stopped two days before the request (2026-11-01 in
 * reality), so everything here is what Hub kept until then: full, a few days
 * old, and honest about the stop.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { between, intBetween, iso, isoDay, mills, pick, rng } from "../core.ts";
import { demoFans, demoNetSum, type DemoPage } from "../world.ts";
import { DAY_MS, HOUR_MS, OF_PAGES, demoDigits, demoSha, demoUuid, mskDayKey, ofAccountId, ofStop } from "./publish-of-common.ts";

type OfLinks = KernelOperationResponse<"ofLinksGet">;
type OfLink = OfLinks["links"][number];
type OfLinksPage = OfLinks["pages"][number];
type Marketing = KernelOperationResponse<"ofapiMarketingGet">;
type Resource = Marketing["resources"][number];
type Media = KernelOperationResponse<"ofapiMediaGet">;
type Job = KernelOperationResponse<"ofapiTypedExportList">["jobs"][number];
type VisitorDay = KernelOperationResponse<"ofapiProfileVisitorsGet">["days"][number];
type Intent = KernelOperationResponse<"ofapiActionGet">;

/** The last link-series run before the stop: 21:00 Moscow the evening before. */
function lastRun(now: Date): number {
  return ofStop(now).getTime() - 3 * HOUR_MS;
}

// --- «Ссылки OnlyFans» -------------------------------------------------------

interface LinkSeed {
  name: string;
  kind: "tracking" | "trial";
  /** Share of the page's money that came through the link. */
  share: number;
  ageDays: number;
  state?: OfLink["state"];
  trialDays?: number;
  channel: keyof typeof CHANNELS | null;
  tags?: string[];
}

const CHANNELS = {
  reddit: { title: "Reddit", contractor: ["north-wind", "Студия «Северный ветер»"] },
  x: { title: "X (Twitter)", contractor: ["promo-lab", "Promo Lab — Тимур"] },
  instagram: { title: "Instagram", contractor: null },
  tiktok: { title: "TikTok", contractor: ["promo-lab", "Promo Lab — Тимур"] },
  shoutouts: { title: "Шаутауты", contractor: ["shout-desk", "Шаут-деск (Ксения)"] },
  telegram: { title: "Telegram-канал", contractor: null },
} as const;

const LINK_SEEDS: Readonly<Record<string, readonly LinkSeed[]>> = {
  "mia-of": [
    { name: "Reddit · основной профиль", kind: "tracking", share: 0.18, ageDays: 140, channel: "reddit", tags: ["reddit"] },
    { name: "Reddit · промо-посты", kind: "tracking", share: 0.09, ageDays: 60, channel: "reddit", tags: ["reddit", "october"] },
    { name: "X · ссылка в био", kind: "tracking", share: 0.11, ageDays: 210, channel: "x" },
    { name: "Instagram · сторис", kind: "tracking", share: 0.06, ageDays: 90, channel: "instagram" },
    { name: "TikTok · био", kind: "tracking", share: 0.04, ageDays: 45, channel: "tiktok" },
    { name: "Шаутаут @luna.shares", kind: "tracking", share: 0.03, ageDays: 24, channel: "shoutouts", tags: ["s4s"] },
    { name: "Telegram · закреп", kind: "tracking", share: 0.02, ageDays: 33, channel: "telegram" },
    { name: "Летнее промо", kind: "tracking", share: 0.05, ageDays: 150, state: "expired", channel: "reddit", tags: ["summer"] },
    { name: "Пробные 7 дней · Reddit", kind: "trial", share: 0.07, ageDays: 75, trialDays: 7, channel: "reddit" },
    { name: "Пробные 30 дней · бывшие фаны", kind: "trial", share: 0.05, ageDays: 40, trialDays: 30, channel: null },
    { name: "Хэллоуин · пробные 3 дня", kind: "trial", share: 0.02, ageDays: 12, trialDays: 3, state: "finished", channel: "x", tags: ["halloween"] },
  ],
  "mia-vip-of": [
    { name: "Ссылка с основной страницы", kind: "tracking", share: 0.22, ageDays: 190, channel: null },
    { name: "Reddit · VIP", kind: "tracking", share: 0.08, ageDays: 70, channel: "reddit" },
    { name: "X · закреплённый пост", kind: "tracking", share: 0.06, ageDays: 120, channel: "x" },
    { name: "Рассылка по фанам mia-of", kind: "tracking", share: 0.12, ageDays: 28, channel: null, tags: ["mass-dm"] },
    { name: "VIP · пробные 3 дня", kind: "trial", share: 0.04, ageDays: 55, trialDays: 3, channel: "reddit" },
  ],
};

function buildLink(now: Date, page: DemoPage, seed: LinkSeed, index: number): OfLink {
  const random = rng(`oflink:${page.label}:${index}`);
  const run = lastRun(now);
  const created = run - seed.ageDays * DAY_MS;
  const state = seed.state ?? "active";
  // All-time money through the link: its share of the page's net over its life.
  const lifeNet = demoNetSum(page.label, new Date(run), Math.min(seed.ageDays, 365));
  const net = Math.round(lifeNet * seed.share * between(random, 0.85, 1.15) * 100) / 100;
  const fans = Math.max(3, Math.round(net / between(random, 9, 16)));
  const clicks = Math.round(fans * between(random, 6, 14));
  const spenders = Math.max(1, Math.round(fans * between(random, 0.12, 0.3)));
  const linkRef = demoDigits(`oflinkref:${page.label}:${index}`, 7);
  const observedAt = iso(new Date(run));
  const floorAt = run - 25 * DAY_MS;
  const knowsMoney = !(page.label === "mia-of" && index === 4);
  const hubAvailable = seed.kind === "tracking" ? index !== 6 : index !== 9;
  const hubNet = hubAvailable ? Math.round(net * Math.min(0.9, 25 / seed.ageDays) * between(random, 0.92, 1.0) * 100) / 100 : null;
  const vendorDelta = hubNet === null ? null : Math.round(hubNet * between(random, 0.98, 1.03) * 100) / 100;
  let comparison: OfLink["comparison"];
  if (hubNet === null || vendorDelta === null) {
    comparison = { state: null, flags: [], fromAt: null, toAt: null, vendorDeltaMills: null, hubNetMills: null, differenceMills: null };
  } else {
    const compState: NonNullable<OfLink["comparison"]["state"]> = seed.kind === "trial" ? "provisional"
      : index === 2 ? "different_history" : index === 3 ? "provisional" : "comparable";
    comparison = {
      state: compState,
      flags: index === 3 ? ["vendor_lagging"] : [],
      fromAt: iso(new Date(floorAt)),
      toAt: iso(new Date(run - 2 * HOUR_MS)),
      vendorDeltaMills: mills(vendorDelta),
      hubNetMills: mills(hubNet),
      differenceMills: mills(hubNet) - mills(vendorDelta),
    };
  }
  const channel = seed.channel === null ? null : CHANNELS[seed.channel];
  const channelFrom = iso(new Date(created + DAY_MS));
  return {
    pageId: page.id,
    linkKind: seed.kind,
    linkRef,
    name: seed.name,
    url: `https://onlyfans.com/${page.username}/${seed.kind === "trial" ? "trial" : "c"}${demoDigits(`oflinkurl:${page.label}:${index}`, 3)}`,
    linkCreatedAt: iso(new Date(created)),
    linkEndsAt: state === "expired" ? iso(new Date(run - 20 * DAY_MS)) : seed.kind === "trial" ? iso(new Date(run + (state === "finished" ? 18 : 45) * DAY_MS)) : null,
    isFinished: seed.kind === "trial" ? state === "finished" : null,
    state,
    trialDays: seed.trialDays ?? null,
    tags: seed.tags ?? [],
    observedAt,
    businessDate: mskDayKey(run),
    runRef: `of-links:${mskDayKey(run)}T21:${page.label}`,
    inLatestRun: !(state === "expired"),
    clicks,
    claims: seed.kind === "trial" ? fans : null,
    subscribers: seed.kind === "trial" ? Math.round(fans * 0.4) : fans,
    spenders: knowsMoney ? spenders : null,
    fans,
    fansMetric: seed.kind === "trial" ? "claims" : "subscribers",
    vendorMoney: {
      revenueBasis: "creator_net_after_platform_fee",
      netMills: knowsMoney ? mills(net) : null,
      chargebacksMills: knowsMoney ? mills(Math.round(net * 0.008 * 100) / 100) : null,
      calculatedAt: knowsMoney ? iso(new Date(run - 2 * HOUR_MS)) : null,
      isLoading: knowsMoney ? false : true,
      lastRecalculation: page.label === "mia-of" && index === 1 ? {
        observedAt: iso(new Date(run - 9 * DAY_MS)),
        previousObservedAt: iso(new Date(run - 9 * DAY_MS - 6 * HOUR_MS)),
        fromMills: mills(Math.round(net * 1.12)),
        toMills: mills(Math.round(net * 0.94)),
        bindingChanged: false,
        accountChangedAt: null,
      } : null,
    },
    hubMoney: hubNet === null
      ? { state: "no_data", reason: "no_completed_walk", revenueBasis: "creator_net_after_platform_fee", attributionRule: "ofapi_subscription_period_equal_split.v1", floorAt: null, netMills: null, pendingMills: null, transactionCount: null, fanCount: null }
      : {
        state: "available", reason: null, revenueBasis: "creator_net_after_platform_fee", attributionRule: "ofapi_subscription_period_equal_split.v1",
        floorAt: iso(new Date(floorAt)), netMills: mills(hubNet), pendingMills: index % 3 === 0 ? mills(Math.round(hubNet * 0.03 * 100) / 100) : 0,
        transactionCount: Math.max(1, Math.round(hubNet / 14)), fanCount: Math.max(1, Math.round(spenders * 0.7)),
      },
    comparison,
    binding: channel === null ? null : {
      channelKey: seed.channel ?? "",
      channelTitle: channel.title,
      validFrom: channelFrom,
      validTo: null,
      validFromBasis: index % 4 === 1 ? "assumed_link_created" : "confirmed",
      contractor: channel.contractor === null ? null : {
        contractorKey: channel.contractor[0],
        contractorTitle: channel.contractor[1],
        validFrom: channelFrom,
        validTo: null,
        validFromBasis: "confirmed",
      },
    },
  };
}

function linksPage(now: Date, page: DemoPage, links: readonly OfLink[]): OfLinksPage {
  const run = lastRun(now);
  const attemptAt = now.getTime() - 95 * 60_000;
  return {
    pageId: page.id,
    pageLabel: page.label,
    ofapiMapped: true,
    ofapiAuthStatus: "connected",
    kinds: (["tracking", "trial"] as const).map((linkKind) => ({
      linkKind,
      lastUsableAt: iso(new Date(run)),
      lastUsableRunRef: `of-links:${mskDayKey(run)}T21:${page.label}`,
      linkCount: links.filter((link) => link.linkKind === linkKind && link.inLatestRun).length,
      lastAttempt: {
        runRef: `of-links:${mskDayKey(attemptAt)}:${page.label}`,
        observedAt: iso(new Date(attemptAt)),
        businessDate: mskDayKey(attemptAt),
        windowAt: iso(new Date(attemptAt - 5 * 60_000)),
        attempt: 1,
        status: "skipped",
        reason: "ofapi_client_not_configured",
        usable: false,
      },
      stale: true,
      staleSince: iso(new Date(run)),
    })),
  };
}

export function ofLinks(now: Date, pageId: number | undefined): OfLinks {
  const links = OF_PAGES.flatMap((page) => (LINK_SEEDS[page.label] ?? []).map((seed, index) => buildLink(now, page, seed, index)));
  return {
    generatedAt: iso(now),
    businessTimeZone: "Europe/Moscow",
    revenueBasis: "creator_net_after_platform_fee",
    seriesFloorAt: iso(new Date(lastRun(now) - 56 * DAY_MS)),
    staleAfterHours: 12,
    pages: OF_PAGES.map((page) => linksPage(now, page, links.filter((link) => link.pageId === page.id))),
    links: pageId === undefined ? links : links.filter((link) => link.pageId === pageId),
  };
}

// --- Smart Links ---------------------------------------------------------------

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(seed: string): string {
  const random = rng(`ulid:${seed}`);
  return `01J${Array.from({ length: 23 }, () => ULID_ALPHABET[Math.floor(random() * 32)]).join("")}`;
}

function resource(base: Pick<Resource, "pageId" | "kind" | "id" | "name" | "observedAt"> & Partial<Resource>): Resource {
  return {
    nativeAccountRef: null, shared: false, parentId: null, linkType: null, platform: null, platformPixelId: null,
    publicUrl: null, httpMethod: null, status: null, destination: null, clicks: null, conversions: null, subscribers: null,
    spenders: null, revenueMills: null, revenueBasis: "unspecified", cost: null, tags: [], eventNames: {}, conversionTypes: [],
    scope: null, linkIds: [], templateVariables: [], headerNames: [], hasBodyTemplate: false,
    ...base,
  };
}

export function ofapiMarketing(now: Date): Marketing {
  const [mia, vip] = OF_PAGES;
  if (!mia || !vip) throw new Error("demo: OnlyFans pages missing");
  const observed = iso(new Date(lastRun(now) - HOUR_MS));
  const linkA = ulid("smart:mia:reddit");
  const linkB = ulid("smart:mia:x");
  const linkC = ulid("smart:vip:trial");
  const resources: Resource[] = [
    resource({
      pageId: mia.id, nativeAccountRef: ofAccountId(mia), kind: "smart_link", id: linkA, name: "Reddit · октябрьская кампания", observedAt: observed,
      linkType: "tracking_link", publicUrl: "https://sl.demo-links.invalid/mia-reddit", status: "active",
      clicks: 4182, conversions: 391, subscribers: 236, spenders: 61, revenueMills: String(mills(2874.4)), revenueBasis: "net",
      cost: { inputMode: "cpc", inputValue: "0.09", currency: "USD", unit: "per_click", source: "provider_campaign_configuration" },
      tags: ["reddit", "october"],
    }),
    resource({
      pageId: mia.id, nativeAccountRef: ofAccountId(mia), kind: "smart_link", id: linkB, name: "X · реклама у партнёров", observedAt: observed,
      linkType: "tracking_link", publicUrl: "https://sl.demo-links.invalid/mia-x", status: "active",
      clicks: 1265, conversions: 88, subscribers: 54, spenders: 12, revenueMills: String(mills(612.75)), revenueBasis: "net",
      tags: ["x"],
    }),
    resource({
      pageId: vip.id, nativeAccountRef: ofAccountId(vip), kind: "smart_link", id: linkC, name: "VIP · пробные 7 дней", observedAt: observed,
      linkType: "free_trial", publicUrl: "https://sl.demo-links.invalid/mia-vip-trial", status: "active",
      clicks: 702, conversions: 140, subscribers: 97, spenders: 21, revenueMills: String(mills(1190.2)), revenueBasis: "net",
    }),
    resource({
      pageId: mia.id, nativeAccountRef: ofAccountId(mia), kind: "pixel", id: "5512", parentId: linkA, name: "Meta · основной пиксель", observedAt: observed,
      platform: "meta", platformPixelId: "8812045519034", status: "active",
      eventNames: { event_click: "ViewContent", event_new_subscriber: "Subscribe", event_first_transaction: "Purchase" },
    }),
    resource({
      pageId: mia.id, nativeAccountRef: ofAccountId(mia), kind: "pixel", id: "5513", parentId: linkB, name: null, observedAt: observed,
      platform: "creatortraffic", platformPixelId: null, status: "paused",
    }),
    resource({
      pageId: null, kind: "postback", id: "17", shared: true, name: null, observedAt: observed,
      httpMethod: "POST", destination: "https://track.demo-agency.invalid/of/postback", scope: "global",
      conversionTypes: ["new_subscriber", "new_transaction"], templateVariables: ["{click_id}", "{amount}", "{smart_link_id}"],
      headerNames: ["Authorization"], hasBodyTemplate: true,
    }),
  ];
  const stop = ofStop(now).getTime();
  const daily = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(stop - (7 - index) * DAY_MS);
    const random = rng(`smart-daily:${isoDay(day)}`);
    const clicks = intBetween(random, 110, 240);
    const subscribers = Math.round(clicks * between(random, 0.05, 0.08));
    return {
      period: "daily" as const, timestamp: isoDay(day), clicks, subscribers, spenders: Math.max(1, Math.round(subscribers * 0.25)),
      revenueMills: String(mills(Math.round(subscribers * between(random, 9, 15) * 100) / 100)), revenueBasis: "net" as const, attributionOnly: true as const,
    };
  });
  const fans = demoFans(mia.label).slice(5, 13);
  const conversions = fans.map((fan, index) => ({
    period: "row" as const, occurredAt: iso(new Date(stop - (index * 7 + 3) * HOUR_MS)), fanId: fan.platformUserId, username: fan.username,
    conversionType: index % 3 === 0 ? "new_transaction" : "new_subscriber", country: fan.country,
    isBot: false, isDuplicate: index === 4, organic: index === 6, previouslySubscribed: index === 2,
    subscribedUsingPromo: false, currentSubscriptionFromSmartLink: index !== 6,
    amountNetMills: index % 3 === 0 ? String(mills(pick(rng(`conv:${index}`), [9.99, 14.99, 24.0]))) : null,
    attributionOnly: true as const,
  }));
  const intent = (id: string, action: string, state: string, at: number, preview: Partial<Marketing["intents"][number]["preview"]>, extra: Partial<Marketing["intents"][number]> = {}): Marketing["intents"][number] => ({
    id: demoUuid(`mkt:${id}`), action, state, errorCode: null, remoteId: null, accountingState: "complete", projectionState: "complete",
    createdAt: iso(new Date(at)), responseObservationId: state === "prepared" ? null : 90_000 + id.length * 13,
    preview: {
      pageId: mia.id, pageLabel: mia.label, accountId: ofAccountId(mia), values: [], destination: null, templateVariables: [], headerNames: [],
      targetId: null, changedFields: [], conversionTypes: [], scope: null, affectedLinkIds: [], affectedLinksComplete: true,
      effect: "", externalTest: false, estimatedCredits: 1, ...preview,
    },
    ...extra,
  });
  return {
    resources,
    analytics: [
      {
        pageId: mia.id, operation: "ofapi_read_smart_link_stats", linkId: linkA, observedAt: observed,
        window: { from: isoDay(new Date(stop - 7 * DAY_MS)), to: isoDay(new Date(stop - DAY_MS)) }, requestedRevenueBasis: "net",
        coverage: { state: "complete", reason: null }, rows: daily,
      },
      {
        pageId: mia.id, operation: "ofapi_read_smart_link_conversions", linkId: linkA, observedAt: observed,
        window: { from: isoDay(new Date(stop - 3 * DAY_MS)), to: isoDay(new Date(stop - DAY_MS)) }, requestedRevenueBasis: null,
        coverage: { state: "partial", reason: "max_calls_reached" }, rows: conversions,
      },
    ],
    intents: [
      intent("pixel-test", "pixel_test", "rejected", stop - 30 * HOUR_MS, { targetId: "5513", effect: "Отправит тестовое событие «Новая подписка» в CreatorTraffic", externalTest: true }, { errorCode: "pixel_test_unsupported" }),
      intent("tags", "tags_add", "succeeded", stop - 4 * DAY_MS, { targetId: linkA, values: [{ field: "tags", value: ["reddit", "october"] }], effect: "Добавит 2 тега к Smart Link «Reddit · октябрьская кампания»" }, { remoteId: linkA }),
      intent("create", "smart_link_create", "succeeded", stop - 9 * DAY_MS, { values: [{ field: "name", value: "X · реклама у партнёров" }, { field: "link_type", value: "tracking_link" }], effect: "Создаст Smart Link на странице mia-of" }, { remoteId: linkB }),
    ],
    attributionWindowHours: 6,
    revenueIsAdditive: false,
  };
}

// --- Media ---------------------------------------------------------------------

const MEDIA_TOTALS: Readonly<Record<string, number>> = { "mia-of": 186, "mia-vip-of": 74 };
const PHOTO_NAMES = ["IMG_", "DSC_", "mia_set_", "shoot_"] as const;

function mediaItem(now: Date, page: DemoPage, index: number, observationId: number, observedAt: string): Media["media"][number] {
  const random = rng(`ofmedia:${page.label}:${index}`);
  const video = random() < 0.28;
  const cdn = index % 23 === 7;
  const width = video ? 1080 : pick(random, [1080, 1440, 2316, 3024]);
  const height = video ? 1920 : Math.round(width * pick(random, [1.25, 1.333, 1.5]));
  const named = random() < 0.7;
  const forms: Media["media"][number]["releaseForms"] = random() < 0.45
    ? [{ id: demoDigits(`rf:${page.label}`, 6), name: "Mia Hart — согласие модели", status: "approved" }]
    : [];
  if (index === 11) forms.push({ id: "550198", name: "Гостья: Jade K.", status: "pending" });
  return {
    mediaRef: demoDigits(`ofmediaref:${page.label}:${index}`, 10),
    materialKind: cdn ? "cdn" : "vault",
    uploadJobId: null,
    sourceId: null,
    isReady: index === 3 ? false : true,
    uploadStatus: null,
    providerType: video ? "video" : "photo",
    hasError: index === 17,
    canView: index !== 17,
    filename: named ? `${pick(random, PHOTO_NAMES)}${intBetween(random, 1000, 9999)}.${video ? "mp4" : "jpg"}` : null,
    bytes: video ? intBetween(random, 18_000_000, 240_000_000) : intBetween(random, 900_000, 7_800_000),
    duration: video ? intBetween(random, 14, 420) : null,
    width,
    height,
    releaseForms: forms,
    observedAt,
    observationId,
  };
}

export function ofapiMedia(now: Date, page: DemoPage, offset: number, limit: number): Media {
  const stop = ofStop(now).getTime();
  const completedAt = iso(new Date(stop - 5 * HOUR_MS));
  const observationId = 71_000 + page.id * 10;
  const total = MEDIA_TOTALS[page.label] ?? 0;
  const sources: Media["sources"] = [
    { name: "weekend_teaser.mp4", mime: "video/mp4", bytes: 48_211_904 },
    { name: "mirror_set_04.jpg", mime: "image/jpeg", bytes: 3_412_877 },
    { name: "welcome_dm_photo.jpg", mime: "image/jpeg", bytes: 1_904_221 },
  ].map((file, index) => ({
    id: demoUuid(`ofsource:${page.label}:${index}`), pageId: page.id, filename: file.name, mimeType: file.mime, bytes: file.bytes,
    sha256: demoSha(`ofsource:${page.label}:${index}`),
  }));
  const upload = (index: number, destination: "vault" | "cdn", state: string, uploadStatus: string | null, reason: string | null, ageHours: number, credits: number): Media["uploads"][number] => ({
    id: demoUuid(`ofupload:${page.label}:${index}`), sourceId: sources[index % sources.length]!.id, destination, state, rowVersion: 3 + index, reason,
    uploadId: uploadStatus === null ? null : `ofapi_media_${demoDigits(`upl:${page.label}:${index}`, 12)}`,
    mediaRef: state === "complete" && destination === "vault" ? demoDigits(`ofmediaref:${page.label}:${index}`, 10) : null,
    uploadStatus, isReady: state === "complete" ? true : null, spentCredits: state === "blocked" ? 0 : credits, actualCredits: state === "blocked" ? null : credits,
    collectionJobId: demoUuid(`ofupload-job:${page.label}:${index}`), createdAt: iso(new Date(stop - ageHours * HOUR_MS)),
  });
  const uploads = page.label === "mia-of"
    ? [
      upload(0, "vault", "blocked", null, "collection_off", -20, 145),
      upload(1, "vault", "complete", "completed", null, 30, 11),
      upload(2, "cdn", "complete", "completed", null, 54, 6),
    ]
    : [upload(1, "vault", "complete", "completed", null, 76, 11)];
  const media = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => mediaItem(now, page, offset + index, observationId, completedAt));
  return {
    pageId: page.id,
    sources,
    uploads,
    media,
    totalMedia: total,
    inventory: {
      state: "complete",
      completedAt,
      jobId: demoUuid(`ofinventory:${page.label}`),
      note: "Каталог медиатеки собран целиком перед остановкой сбора OnlyFans API; новые файлы с тех пор не читались.",
    },
  };
}

// --- Typed exports and visitors -------------------------------------------------

function jobsOf(now: Date, page: DemoPage): Job[] {
  const stop = ofStop(now).getTime();
  const job = (index: number, profile: Job["profile"], fields: Partial<Job>): Job => ({
    jobId: demoUuid(`ofexport:${page.label}:${index}`), pageId: page.id, profile, state: "complete", rowVersion: 4, reason: null,
    createdAt: iso(new Date(stop - (index + 1) * 26 * HOUR_MS)), vendorExportId: `exp_${demoDigits(`exp:${page.label}:${index}`, 8)}`,
    vendorStatus: "completed", totalRows: null, deliveredRows: null, creditCost: 2, spentCredits: 2, imported: true,
    sha256: demoSha(`ofexport:${page.label}:${index}`), artifactBytes: null, collectionJobId: demoUuid(`ofexport-col:${page.label}:${index}`),
    controlAction: null, sourceJobId: null, ...fields,
  });
  // The vendor counts every fan of the page; one job delivers at most 1 000 rows.
  const fans = page.subscribers;
  const delivered = Math.min(1000, fans);
  if (page.label === "mia-of") {
    return [
      job(0, "trial_links", { state: "blocked", reason: "collection_off", vendorStatus: "calculating_credits_completed", creditCost: 2, spentCredits: 0, imported: false, sha256: null, createdAt: iso(new Date(stop - 7 * HOUR_MS)) }),
      job(1, "smart_links", { state: "blocked", reason: "export_failed", vendorStatus: "failed", totalRows: 3, deliveredRows: 0, creditCost: 2, spentCredits: 1, imported: false, sha256: null }),
      job(2, "profile_visitors", { totalRows: 30, deliveredRows: 30, artifactBytes: 2_214 }),
      job(3, "fans", { totalRows: fans, deliveredRows: delivered, creditCost: 10, spentCredits: 10, artifactBytes: 61_880 }),
      job(4, "tracking_links", { totalRows: 8, deliveredRows: 8, artifactBytes: 1_402 }),
    ];
  }
  return [
    job(2, "profile_visitors", { totalRows: 30, deliveredRows: 30, artifactBytes: 2_190 }),
    job(3, "fans", { totalRows: fans, deliveredRows: delivered, creditCost: 6, spentCredits: 6, artifactBytes: 52_406 }),
  ];
}

export function ofapiExportJobs(now: Date, page: DemoPage): Job[] {
  return jobsOf(now, page);
}

export function findExportJob(now: Date, jobId: string): { page: DemoPage; job: Job } | undefined {
  for (const page of OF_PAGES) {
    const job = jobsOf(now, page).find((item) => item.jobId === jobId);
    if (job) return { page, job };
  }
  return undefined;
}

function visitorCounts(page: DemoPage, day: string) {
  const random = rng(`visitors:${page.label}:${day}`);
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const base = page.label === "mia-of" ? 1150 : 420;
  const total = Math.round(base * (weekday === 0 || weekday === 6 ? 1.2 : 1) * between(random, 0.7, 1.3));
  const guests = Math.round(total * between(random, 0.5, 0.62));
  return { total, guests, users: total - guests, subscribers: Math.round(total * between(random, 0.09, 0.15)), duration: between(random, 28, 61).toFixed(1) };
}

export function exportRows(now: Date, page: DemoPage, job: Job, offset: number, limit: number): Record<string, string | null>[] {
  if (!job.imported) return [];
  const account = ofAccountId(page);
  const stop = ofStop(now).getTime();
  const all: Record<string, string | null>[] = [];
  if (job.profile === "profile_visitors") {
    for (let index = 30; index >= 1; index -= 1) {
      const day = isoDay(new Date(stop - index * DAY_MS));
      const counts = visitorCounts(page, day);
      all.push({ account_id: account, date: day, total_visitors: String(counts.total), guest_visitors: String(counts.guests), user_visitors: String(counts.users), subscriber_visitors: String(counts.subscribers), avg_view_duration: counts.duration });
    }
  } else if (job.profile === "fans") {
    for (const fan of demoFans(page.label).slice(0, 1000)) {
      all.push({
        account_id: account, onlyfans_id: fan.platformUserId, username: fan.username, name: fan.displayName, can_chat: "true",
        rebill_on: fan.autoRenew ? "true" : "false", subscribe_at: iso(new Date(stop - fan.firstSeenDaysAgo * DAY_MS)),
        expired_at: iso(new Date(stop + 30 * DAY_MS - (fan.firstSeenDaysAgo % 30) * DAY_MS)), renewed_at: fan.autoRenew ? iso(new Date(stop - (fan.firstSeenDaysAgo % 30) * DAY_MS)) : null,
        total_summ: fan.totalSpent.toFixed(2),
      });
    }
  } else if (job.profile === "tracking_links") {
    for (const link of ofLinks(now, page.id).links.filter((item) => item.linkKind === "tracking")) {
      all.push({
        account_id: account, onlyfans_id: link.linkRef, campaign_code: link.linkRef.slice(-3), campaign_name: link.name, onlyfans_url: link.url,
        spenders_count: link.spenders === null ? null : String(link.spenders), count_subscribers: String(link.subscribers), count_transitions: String(link.clicks),
        revenue: link.vendorMoney.netMills === null ? null : (link.vendorMoney.netMills / 1000).toFixed(2), tags: (link.tags ?? []).join(","),
      });
    }
  }
  return all.slice(offset, offset + limit);
}

export function profileVisitors(now: Date, page: DemoPage, from: string, to: string, source: "export" | "rest"): KernelOperationResponse<"ofapiProfileVisitorsGet"> {
  const stop = ofStop(now);
  const stopDay = isoDay(stop);
  const days: VisitorDay[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let at = start; at <= end && days.length < 400; at += DAY_MS) {
    const day = isoDay(new Date(at));
    if (day >= stopDay) {
      days.push({ date: day, source: "missing", totalVisitors: null, guestVisitors: null, userVisitors: null, subscriberVisitors: null, avgViewDuration: null, chartDuration: null, durationUnit: "vendor_unspecified", availability: "missing", observedAt: null, observationId: null });
      continue;
    }
    const counts = visitorCounts(page, day);
    const partial = source === "rest" && day === isoDay(new Date(stop.getTime() - DAY_MS));
    days.push({
      date: day, source, totalVisitors: counts.total, guestVisitors: counts.guests, userVisitors: counts.users, subscriberVisitors: counts.subscribers,
      avgViewDuration: source === "export" ? counts.duration : null, chartDuration: source === "rest" ? String(Math.round(Number(counts.duration))) : null,
      durationUnit: "vendor_unspecified", availability: partial ? "partial" : "complete",
      observedAt: iso(new Date(stop.getTime() - (source === "export" ? 30 : 4) * HOUR_MS)), observationId: 64_000 + page.id * 100 + (at / DAY_MS) % 97,
    });
  }
  return {
    pageId: page.id,
    days,
    note: `Источник — ${source === "export" ? "выгрузка CSV" : "дневной график"} OnlyFans API. С ${stopDay} сбор OnlyFans API выключен: эти дни не собирались и остаются неизвестными.`,
  };
}

export function exportInventory(now: Date): KernelOperationResponse<"ofapiExportInventoryGet"> {
  const accounts = OF_PAGES.map(ofAccountId);
  const rows = OF_PAGES.flatMap((page) => jobsOf(now, page)).filter((job) => job.vendorExportId !== null).map((job) => ({
    id: job.vendorExportId ?? "",
    type: job.profile,
    status: job.vendorStatus ?? "pending",
    totalRows: job.totalRows,
    deliveredRows: job.deliveredRows,
    creditCost: job.creditCost,
    accounts: [accounts[OF_PAGES.findIndex((page) => page.id === job.pageId)] ?? ""],
  }));
  return { rows, currentPage: 1, lastPage: 1, observedAt: iso(new Date(ofStop(now).getTime() - 8 * HOUR_MS)), observationId: 88_231 };
}

// --- Account actions -------------------------------------------------------------

function intentsOf(now: Date, page: DemoPage): Intent[] {
  const stop = ofStop(now).getTime();
  const fans = demoFans(page.label);
  const blockedFan = fans[fans.length - 3]?.platformUserId ?? "200001";
  const base = (index: number, state: Intent["state"], command: Intent["command"], ageHours: number, extra: Partial<Intent> = {}): Intent => ({
    id: demoUuid(`ofaction:${page.label}:${index}`), pageId: page.id, pageLabel: page.label, accountId: ofAccountId(page),
    action: command.action, command, state, estimatedCredits: 1, actualCredits: state === "confirmed" ? 1 : null,
    remoteId: null, responseData: null, responseMeta: null, errorCode: null,
    responseObservationId: state === "confirmed" || state === "rejected" ? 95_000 + index * 17 + page.id : null,
    accountingState: "complete", createdAt: iso(new Date(stop - ageHours * HOUR_MS)), ...extra,
  });
  const list: Intent[] = [
    base(0, "cancelled", { action: "saved_post_autopost_update", pageId: page.id, period: 24 }, -10),
    base(1, "indeterminate", { action: "user_block", pageId: page.id, userId: blockedFan }, 20, { errorCode: "vendor_timeout", accountingState: "pending" }),
    base(2, "confirmed", { action: "account_settings_read", pageId: page.id }, 31, {
      responseData: { username: page.username, name: page.displayName, subscribePrice: page.label === "mia-vip-of" ? 14.99 : 0, isPrivate: false, showPostsTip: true, timezone: "Europe/London" },
    }),
    base(3, "confirmed", { action: "user_list_create", pageId: page.id, name: "Купили на Хэллоуин" }, 56, { remoteId: demoDigits(`list:${page.label}`, 7), responseData: { id: demoDigits(`list:${page.label}`, 7), name: "Купили на Хэллоуин", usersCount: 0 } }),
    base(4, "rejected", { action: "user_list_add_users", pageId: page.id, listId: demoDigits(`list:${page.label}`, 7), ids: fans.slice(0, 4).map((fan) => fan.platformUserId) }, 55, { errorCode: "vendor_422_users_not_subscribed" }),
    base(5, "confirmed", { action: "payout_eligibility_read", pageId: page.id }, 98, { responseData: { canWithdraw: true, minimumAmount: 20, nextPayoutDate: isoDay(new Date(stop + 4 * DAY_MS)) } }),
    base(6, "confirmed", { action: "saved_messages_read", pageId: page.id, limit: 10, offset: 0 }, 140, {
      actualCredits: 1,
      responseData: [{ id: "3301", text: "Hey you 💕 thanks for subscribing! What brought you here?" }, { id: "3302", text: "New set dropping tonight, want a sneak peek?" }],
      responseMeta: { hasMore: true, nextOffset: 10 },
    }),
  ];
  // The cancelled one was prepared after the stop and never sent.
  const cancelled = list[0];
  if (cancelled) cancelled.createdAt = iso(new Date(stop + 10 * HOUR_MS));
  return list.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function ofapiIntents(now: Date, page: DemoPage): Intent[] {
  return intentsOf(now, page);
}

export function findIntent(now: Date, id: string): Intent | undefined {
  for (const page of OF_PAGES) {
    const found = intentsOf(now, page).find((item) => item.id === id);
    if (found) return found;
  }
  return undefined;
}
