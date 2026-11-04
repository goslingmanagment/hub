/**
 * «Требует внимания» of the demo agency — held chat-extension sends, the
 * agents' history requests, incidents — and the Telegram notifications: their
 * settings, the next daily report and the reports sent.
 */
import { AGENT_PLANE_NAMES, type KernelOperationResponse } from "@agency_hub_core/contracts";

import { between, daysAgo, demoError, hashString, hoursAgo, intBetween, iso, queryNumber, queryString, rng, type DemoReply, type DemoRequest } from "../core.ts";
import { DEMO_DATA_PAGES, DEMO_MODELS, DEMO_OFAPI_OFF_AT, DEMO_PAGES, DEMO_USERS, demoDailyNet, demoFans, demoPage, demoUserByRole } from "../world.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Collection of the OnlyFans pages through the vendor stopped here. */
const OF_OFF_AT = new Date(DEMO_OFAPI_OFF_AT).toISOString();

function uuid(seed: string): string {
  const hex = Array.from({ length: 4 }, (_, index) => hashString(`${seed}:${index}`).toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${"89ab"[hashString(seed) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sha256Like(seed: string): string {
  return Array.from({ length: 8 }, (_, index) => hashString(`${seed}#${index}`).toString(16).padStart(8, "0")).join("");
}

function paginate<T>(items: readonly T[], request: DemoRequest, defaultLimit: number, maxLimit: number) {
  const limit = Math.min(maxLimit, Math.max(1, Math.round(queryNumber(request, "limit", defaultLimit))));
  const offset = Math.max(0, Math.round(queryNumber(request, "offset", 0)));
  return { limit, offset, page: items.slice(offset, offset + limit) };
}

// --- Held sends (clientSendCustodyList) ------------------------------------------

type Custody = KernelOperationResponse<"clientSendCustodyList">;
type CustodyItem = Custody["items"][number];

const OLYA = DEMO_USERS.find((user) => user.username === "olya.m")!;
const MARTA = DEMO_USERS.find((user) => user.username === "lead.marta")!;
const OWNER = DEMO_USERS.find((user) => user.role === "owner")!;
const INSTALL_OLYA = uuid("install:olya");
const INSTALL_OLYA_LAPTOP = uuid("install:olya-laptop");
const INSTALL_MARTA = uuid("install:marta");

function fanOf(label: string, index: number): string {
  const fans = demoFans(label).filter((fan) => fan.totalSpent > 0 || index > 30);
  return fans[index % fans.length]!.platformUserId;
}

interface HeldSeed {
  page: string;
  fan: number;
  user: typeof OLYA;
  install: string;
  purpose: "greeting" | "preview-reply";
  partIndex: number;
  partCount: number;
  variant: number;
  minutesAgo: number;
  greeting?: { source: string; minutesAfter: number; thisAttempt: boolean };
}

const HELD: readonly HeldSeed[] = [
  { page: "mia-of", fan: 7, user: MARTA, install: INSTALL_MARTA, purpose: "greeting", partIndex: 0, partCount: 1, variant: 0, minutesAgo: 28 * 60 + 14, greeting: { source: "native-register", minutesAfter: 3, thisAttempt: true } },
  { page: "mia-vip-of", fan: 3, user: OLYA, install: INSTALL_OLYA, purpose: "preview-reply", partIndex: 0, partCount: 1, variant: 0, minutesAgo: 3 * 60 + 12 },
  { page: "mia-of", fan: 41, user: OLYA, install: INSTALL_OLYA_LAPTOP, purpose: "greeting", partIndex: 1, partCount: 2, variant: 2, minutesAgo: 47 },
];

const NOTES_SENT = [
  "В чате есть, ушло в то же время. Фан ответил через пару минут.",
  "Проверила чат: сообщение на месте, второе отправлять не надо.",
  "Есть в чате, прочитано фаном.",
  "Сообщение видно в переписке, отметила как ушедшее.",
  "Ушло, фан уже купил PPV после него.",
];
const NOTES_NOT_SENT = [
  "В чате пусто — вкладка зависла. Отправили заново вручную.",
  "Не ушло: OnlyFans показал ошибку при отправке, в чате ничего нет.",
  "Сообщения нет в переписке, браузер перезапустился во время отправки.",
];

function custodyItems(state: "held" | "resolved", now: Date): CustodyItem[] {
  if (state === "held") {
    return HELD.map((seed, index) => {
      const createdAt = new Date(now.getTime() - seed.minutesAgo * MINUTE_MS);
      return {
        attemptId: uuid(`held:${index}`),
        fanRef: fanOf(seed.page, seed.fan),
        userId: seed.user.id,
        purpose: seed.purpose,
        state: "uncertain-held",
        generationRef: uuid(`held-gen:${index}`),
        partIndex: seed.partIndex,
        partCount: seed.partCount,
        createdAt: iso(createdAt),
        ticketExpiresAt: iso(new Date(createdAt.getTime() + 10_000)),
        pageLabel: seed.page,
        variant: seed.variant,
        username: seed.user.username,
        instanceId: seed.install,
        updatedAt: iso(createdAt),
        greeting: seed.greeting
          ? { state: "confirmed", at: iso(new Date(createdAt.getTime() + seed.greeting.minutesAfter * MINUTE_MS)), source: seed.greeting.source, firstPartIsThisAttempt: seed.greeting.thisAttempt }
          : { state: "none", at: null, source: null, firstPartIsThisAttempt: false },
        resolution: null,
      };
    }).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  const items: CustodyItem[] = [];
  for (let index = 0; index < 17; index += 1) {
    const random = rng(`resolved:${index}`);
    const page = random() < 0.6 ? "mia-of" : "mia-vip-of";
    const purpose = random() < 0.45 ? "greeting" : "preview-reply";
    const createdAt = new Date(now.getTime() - (6 + index * 19 + between(random, 0, 12)) * HOUR_MS);
    const resolvedAt = new Date(createdAt.getTime() + between(random, 0.3, 9) * HOUR_MS);
    const sent = random() < 0.78;
    const resolver = random() < 0.7 ? MARTA : OWNER;
    const dispatcher = random() < 0.85 ? OLYA : MARTA;
    const partCount = purpose === "greeting" ? intBetween(random, 1, 2) : 1;
    const messageId = sent && random() < 0.55 ? String(5_210_000_000 + (hashString(`msg:${index}`) % 90_000_000)) : null;
    items.push({
      attemptId: uuid(`resolved:${index}`),
      fanRef: fanOf(page, 3 + index * 5),
      userId: dispatcher.id,
      purpose,
      state: sent ? "resolved-sent" : "resolved-not-sent",
      generationRef: uuid(`resolved-gen:${index}`),
      partIndex: 0,
      partCount,
      createdAt: iso(createdAt),
      ticketExpiresAt: iso(new Date(createdAt.getTime() + 10_000)),
      pageLabel: page,
      variant: purpose === "greeting" ? intBetween(random, 0, 2) : 0,
      username: dispatcher.username,
      instanceId: dispatcher === OLYA ? INSTALL_OLYA : INSTALL_MARTA,
      updatedAt: iso(resolvedAt),
      greeting: purpose === "greeting" && sent
        ? { state: "confirmed", at: iso(resolvedAt), source: "resolve", firstPartIsThisAttempt: true }
        : { state: purpose === "greeting" ? "none" : "confirmed", at: purpose === "greeting" ? null : iso(new Date(createdAt.getTime() - 9 * DAY_MS)), source: purpose === "greeting" ? null : "preview-send", firstPartIsThisAttempt: false },
      resolution: {
        outcome: sent ? "sent" : "not_sent",
        at: iso(resolvedAt),
        userId: resolver.id,
        username: resolver.username,
        note: sent ? NOTES_SENT[index % NOTES_SENT.length]! : NOTES_NOT_SENT[index % NOTES_NOT_SENT.length]!,
        platformMessageId: messageId,
      },
    });
  }
  return items.sort((left, right) => (right.resolution?.at ?? "").localeCompare(left.resolution?.at ?? ""));
}

export function clientSendCustodyList(request: DemoRequest): Custody | DemoReply {
  const state = queryString(request, "state") === "resolved" ? "resolved" : "held";
  const pageLabel = queryString(request, "pageLabel");
  const viewer = demoUserByRole(request.role);
  if (pageLabel !== undefined) {
    if (!demoPage(pageLabel)) return demoError(404, "not_found", `Page ${pageLabel} not found`);
    if (!viewer.pages.includes(pageLabel)) return demoError(403, "forbidden", `No access to page ${pageLabel}`);
  }
  const items = custodyItems(state, request.now).filter((item) =>
    viewer.pages.includes(item.pageLabel) && (pageLabel === undefined || item.pageLabel === pageLabel));
  const { limit, offset, page } = paginate(items, request, 50, 100);
  return { items: page, limit, offset, total: items.length, serverNow: iso(request.now) };
}

// --- Agents' history requests (agentHydrationRequestList) --------------------------

type Hydration = KernelOperationResponse<"agentHydrationRequestList">;
type HydrationItem = Hydration["items"][number];

interface HydrationSeed {
  state: HydrationItem["state"];
  page: string;
  fan: number;
  hoursAgo: number;
  beforeDays: number | null;
  key: string;
  decidedAfterHours?: number;
  progress?: Partial<HydrationItem["progress"]>;
}

const HYDRATION: readonly HydrationSeed[] = [
  { state: "requested", page: "mia-vip-of", fan: 2, hoursAgo: 1.4, beforeDays: 120, key: "ahk_live_3f9a" },
  { state: "requested", page: "mia-of", fan: 11, hoursAgo: 5.2, beforeDays: null, key: "ahk_live_3f9a" },
  { state: "requested", page: "nova-1", fan: 4, hoursAgo: 20.5, beforeDays: 200, key: "ahk_live_b71c" },
  { state: "dispatching", page: "mia-of", fan: 0, hoursAgo: 0.6, beforeDays: 90, key: "ahk_live_3f9a", decidedAfterHours: 0.3, progress: { dispatchCount: 1, executionRef: "ofcj_01K4PQ7R2M" } },
  { state: "failed", page: "mia-vip-of", fan: 9, hoursAgo: 52, beforeDays: 60, key: "ahk_live_3f9a", decidedAfterHours: 1.1, progress: { dispatchCount: 1, lastError: "vendor_unavailable", executionRef: "ofcj_01K48WZ3TD" } },
  { state: "completed", page: "mia-of", fan: 5, hoursAgo: 66, beforeDays: 180, key: "ahk_live_3f9a", decidedAfterHours: 2.4, progress: { dispatchCount: 1, acceptedItems: 214, acceptedPages: 4, spentCredits: 4, executionRef: "ofcj_01K45HB9QX" } },
  { state: "partially_completed", page: "mia-vip-of", fan: 0, hoursAgo: 90, beforeDays: 365, key: "ahk_live_b71c", decidedAfterHours: 0.8, progress: { dispatchCount: 1, acceptedItems: 250, acceptedPages: 5, spentCredits: 5, lastError: "budget_exhausted", executionRef: "ofcj_01K42M6E1A" } },
  { state: "completed", page: "mia-vip-of", fan: 14, hoursAgo: 118, beforeDays: 45, key: "ahk_live_3f9a", decidedAfterHours: 5.5, progress: { dispatchCount: 1, acceptedItems: 87, acceptedPages: 2, spentCredits: 2, executionRef: "ofcj_01K3ZTN4V8" } },
  { state: "rejected", page: "mia-of", fan: 23, hoursAgo: 140, beforeDays: 700, key: "ahk_live_b71c", decidedAfterHours: 3 },
  { state: "approved", page: "mia-of", fan: 31, hoursAgo: 3.1, beforeDays: 30, key: "ahk_live_3f9a", decidedAfterHours: 0.5 },
  { state: "expired", page: "mia-vip-of", fan: 19, hoursAgo: 210, beforeDays: 150, key: "ahk_live_3f9a" },
  { state: "rejected", page: "ivy-2", fan: 1, hoursAgo: 260, beforeDays: 90, key: "ahk_live_b71c", decidedAfterHours: 9 },
];

function hydrationItem(seed: HydrationSeed, index: number, now: Date): HydrationItem {
  const page = demoPage(seed.page)!;
  const fansly = page.platform === "fansly";
  const fan = demoFans(seed.page)[seed.fan]!;
  const createdAt = new Date(now.getTime() - seed.hoursAgo * HOUR_MS);
  const decidedAt = seed.decidedAfterHours === undefined ? null : new Date(createdAt.getTime() + seed.decidedAfterHours * HOUR_MS);
  const approved = seed.state !== "rejected" && decidedAt !== null;
  const random = rng(`hydration:${index}`);
  const updatedAt = seed.state === "expired"
    ? new Date(createdAt.getTime() + 72 * HOUR_MS)
    : decidedAt ?? createdAt;
  const reasonLength = intBetween(random, 64, 380);
  return {
    requestRef: uuid(`hydration:${index}`),
    state: seed.state,
    pageLabel: seed.page,
    platform: page.platform,
    conversationRef: fansly ? String(BigInt(fan.platformUserId) + 31n) : fan.platformUserId,
    target: {
      kind: "thread_backfill_before",
      beforeAt: seed.beforeDays === null ? null : iso(daysAgo(now, seed.beforeDays, 0)),
      beforeMessageRef: seed.beforeDays === null ? String(4_090_000_000_000 + (hashString(`msgref:${index}`) % 900_000_000)) : null,
    },
    admissibility: {
      orderEvaluated: ["free_local_replay", "vendor_paid_low", "vendor_paid_high"],
      selected: fansly ? null : "vendor_paid_low",
      admissible: !fansly,
      reason: fansly ? "hydration_mode_off" : null,
      costNote: fansly ? "egress_quota_and_ban_risk" : "ofapi_credits",
    },
    coverageFingerprint: sha256Like(`coverage:${index}`),
    rowVersion: decidedAt === null ? 1 : seed.state === "approved" ? 2 : 3,
    requestedBy: { principal: "agent_key", keyPrefix: seed.key },
    reasonSha256: sha256Like(`reason:${index}`),
    reasonLength,
    createdAt: iso(createdAt),
    updatedAt: iso(updatedAt),
    expiresAt: iso(new Date(createdAt.getTime() + 72 * HOUR_MS)),
    decision: decidedAt === null
      ? null
      : {
        decidedAt: iso(decidedAt),
        decisionSource: "owner",
        policyVersion: null,
        approved,
        allowMarkReadSideEffect: approved ? false : null,
        maxCalls: approved ? 5 : null,
        maxCredits: approved ? 5 : null,
        maxPages: approved ? 5 : null,
        maxItems: null,
      },
    progress: {
      dispatchCount: 0,
      acceptedItems: 0,
      acceptedPages: 0,
      spentCredits: 0,
      lastError: "none",
      executionRef: null,
      ...seed.progress,
    },
  };
}

export function agentHydrationRequestList(request: DemoRequest): Hydration {
  const state = queryString(request, "state");
  const limit = Math.min(200, Math.max(1, Math.round(queryNumber(request, "limit", 50))));
  const all = HYDRATION.map((seed, index) => hydrationItem(seed, index, request.now))
    .filter((item) => state === undefined || item.state === state)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const items = all.slice(0, limit);
  return {
    items,
    delivery: {
      returned: items.length,
      matchedInScope: { value: all.length, exact: true, countBasis: "post_dedup" },
      cappedBy: all.length > items.length ? "limit" : null,
      nextCursor: null,
      snapshotExhausted: false,
      caveats: ["no_frozen_snapshot"],
    },
    capture: {
      planes: AGENT_PLANE_NAMES.map((plane) => ({ plane, state: "not_applicable" as const, reason: "not_queried_by_this_operation" as const })),
      observedRowFloor: null,
      gaps: [],
      sourceErrors: [],
      scopeNarrowing: { keyGrantExcludedPages: 0, totalPagesForQuery: DEMO_PAGES.length },
      scopeFieldStates: {},
    },
    conclusion: { blockers: [] },
  };
}

// --- Incidents (notificationsIncidents) ---------------------------------------------

type Incidents = KernelOperationResponse<"notificationsIncidents">;
type Incident = Incidents["items"][number];

interface IncidentSeed {
  kind: Incident["kind"];
  page: string | null;
  stream: string | null;
  openedHoursAgo: number;
  /** Null: still open. */
  durationHours: number | null;
  error: string | null;
  code: string | null;
  outbox?: Pick<Incident, "outboxState" | "outboxAttemptCount" | "outboxLastError" | "outboxSuppressionReason">;
  manual?: boolean;
  /** The end of the failure's key, as the hub writes it. */
  tail?: string;
}

function incidentSeeds(now: Date): IncidentSeed[] {
  const sinceOff = Math.max(1, (now.getTime() - Date.parse(OF_OFF_AT)) / HOUR_MS);
  const seeds: IncidentSeed[] = [
    { kind: "stream_failed_threshold", page: "ivy-1", stream: "followers", openedHoursAgo: 8.7, durationHours: null, error: "followers: HTTP 429 from apiv3.fansly.com, 3 failed runs in a row", code: "rate_limited" },
    { kind: "auth_blocked", page: "nova-1", stream: null, openedHoursAgo: 5.2, durationHours: null, error: "Fansly signed the page's browser out", code: "login_required" },
    { kind: "ofapi_webhook_silence", page: null, stream: null, openedHoursAgo: sinceOff - 6.1, durationHours: null, error: "No OnlyFans webhook events for 6 h (last at 2026-11-01 10:20 UTC)", code: "webhook_silence" },
    { kind: "golden_signal_lag", page: null, stream: null, tail: "ofapi_delivery_history_age", openedHoursAgo: sinceOff - 0.5, durationHours: null, error: "ofapi delivery history age is over its threshold", code: "lag" },
    { kind: "ofapi_platform_notice", page: "mia-vip-of", stream: null, openedHoursAgo: sinceOff - 2.5, durationHours: null, error: "OnlyFans notice: «Updated Terms of Service» — effective 1 November 2026", code: "platform_notice" },
    { kind: "ai_provider_billing", page: null, stream: null, openedHoursAgo: 12 * 24 + 3.2, durationHours: 0.2, error: "Anthropic 400: Your credit balance is too low to access the Anthropic API (account main)", code: "credit_balance_too_low" },
    { kind: "proxy_failed", page: "ivy-2", stream: null, openedHoursAgo: 4 * 24 + 7, durationHours: 1.6, error: "SOCKS5 handshake timed out after 15 s", code: "proxy_timeout" },
    { kind: "publication_not_published", page: "mia-2", stream: null, openedHoursAgo: 2 * 24 + 5.5, durationHours: 0.4, error: "Post «Sunday mood ☀️» was due at 18:00 MSK and is not on the wall", code: "not_published", manual: true },
    { kind: "db_disk_usage", page: null, stream: null, openedHoursAgo: 9 * 24 + 1.3, durationHours: 26, error: "Disk usage 86% on /var/lib/postgresql (alert at 85%)", code: "disk_usage_high" },
    { kind: "scheduler_silent", page: null, stream: null, openedHoursAgo: 15 * 24 + 4, durationHours: 0.3, error: "No scheduler tick for 11 min", code: "scheduler_silent" },
    { kind: "fansly_sync_engine", page: "mia-1", stream: "dm_messages", openedHoursAgo: 6 * 24 + 22, durationHours: 0.7, error: "Chat list cursor did not move for 45 min", code: "cursor_stalled" },
    { kind: "sync_silent", page: "mia-3", stream: null, openedHoursAgo: 11 * 24 + 2, durationHours: 0.9, error: "No sync runs for the page for 32 min", code: "sync_silent" },
    { kind: "ai_provider_failed", page: null, stream: null, openedHoursAgo: 17 * 24 + 9, durationHours: 0.25, error: "Anthropic 529: overloaded_error (12 calls in 5 min)", code: "overloaded", outbox: { outboxState: "suppressed", outboxAttemptCount: 0, outboxLastError: null, outboxSuppressionReason: "ai_critical_alerts_disabled" } },
    { kind: "ofapi_low_credit", page: null, stream: null, openedHoursAgo: 19 * 24 + 14, durationHours: 3.9, error: "OnlyFans API balance 38 412 credits: less than 10 days left", code: "low_credit" },
    { kind: "observations_partitions", page: null, stream: null, openedHoursAgo: 23 * 24 + 1, durationHours: 1.2, error: "Next month's observations partition was not created", code: "partition_missing" },
  ];
  // Fansly streams that tripped over a run of failures and recovered on their own.
  const streams = ["dm_messages", "followers", "transactions", "subscribers", "media_stats", "top_spenders", "stats_snapshot", "dm_conversations"];
  const errors: Record<string, string> = {
    dm_messages: "HTTP 429 from apiv3.fansly.com, 3 failed runs in a row",
    followers: "HTTP 429 from apiv3.fansly.com, 3 failed runs in a row",
    transactions: "HTTP 502 from apiv3.fansly.com, 3 failed runs in a row",
    subscribers: "Timeout after 30 s, 3 failed runs in a row",
    media_stats: "HTTP 429 from apiv3.fansly.com, 3 failed runs in a row",
    top_spenders: "HTTP 503 from apiv3.fansly.com, 3 failed runs in a row",
    stats_snapshot: "Unexpected response shape: account.stats missing, 3 runs",
    dm_conversations: "Page browser restarted mid-run, 3 failed runs in a row",
  };
  const fansly = DEMO_PAGES.filter((page) => page.platform === "fansly");
  for (let index = 0; index < 22; index += 1) {
    const random = rng(`incident:${index}`);
    const stream = streams[index % streams.length]!;
    const page = fansly[Math.floor(random() * fansly.length)]!;
    seeds.push({
      kind: "stream_failed_threshold",
      page: page.label,
      stream,
      openedHoursAgo: 14 + index * 31 + between(random, 0, 18),
      durationHours: between(random, 0.15, 2.4),
      error: errors[stream] ?? null,
      code: stream === "subscribers" ? "timeout" : "upstream_error",
    });
  }
  return seeds;
}

function incident(seed: IncidentSeed, index: number, now: Date): Incident {
  const page = seed.page ? demoPage(seed.page) : undefined;
  const openedAt = new Date(now.getTime() - seed.openedHoursAgo * HOUR_MS);
  const resolvedAt = seed.durationHours === null ? null : new Date(openedAt.getTime() + seed.durationHours * HOUR_MS);
  const lastSeenAt = resolvedAt ?? new Date(now.getTime() - (3 + (index % 9)) * MINUTE_MS);
  const open = resolvedAt === null;
  const outbox = seed.outbox ?? { outboxState: "delivered" as const, outboxAttemptCount: 1, outboxLastError: null, outboxSuppressionReason: null };
  const global = seed.kind === "ofapi_webhook_silence" || seed.kind === "ai_provider_billing" || seed.kind === "ofapi_low_credit";
  return {
    id: 9_400 + index,
    incidentKey: `${seed.kind}:${page?.id ?? "global"}${seed.stream ? `:${seed.stream}` : ""}${seed.tail ? `:${seed.tail}` : ""}`,
    kind: seed.kind,
    pageLabel: seed.page,
    platform: page?.platform ?? (seed.kind.startsWith("ofapi_") && global ? "onlyfans" : null),
    stream: seed.stream,
    status: open ? "open" : "resolved",
    openedAt: iso(openedAt),
    lastSeenAt: iso(lastSeenAt),
    resolvedAt: resolvedAt === null ? null : iso(resolvedAt),
    errorCode: seed.code,
    errorSummary: seed.error,
    notificationCount: outbox.outboxState === "suppressed" ? 0 : open ? 1 : seed.manual ? 1 : 2,
    ...outbox,
  };
}

export function notificationsIncidents(request: DemoRequest): Incidents {
  const status = queryString(request, "status");
  const kind = queryString(request, "kind");
  const pageLabel = queryString(request, "pageLabel");
  const all = incidentSeeds(request.now)
    .map((seed, index) => incident(seed, index, request.now))
    .filter((item) =>
      (status === undefined || item.status === status)
      && (kind === undefined || item.kind === kind)
      && (pageLabel === undefined || item.pageLabel === pageLabel))
    .sort((left, right) => right.openedAt.localeCompare(left.openedAt));
  const { page } = paginate(all, request, 50, 200);
  return { items: page, total: all.length };
}

// --- Telegram settings (notificationsSettings) ---------------------------------------

const REPORT_HOUR_UTC = 6;

export function notificationsSettings(request: DemoRequest): KernelOperationResponse<"notificationsSettings"> {
  return {
    configured: true,
    botTokenSet: true,
    chatId: "-1002318457702",
    botTokenSource: "db",
    chatIdSource: "db",
    enabled: true,
    dailyReportEnabled: true,
    syncFailureAlertsEnabled: true,
    aiCriticalAlertsEnabled: true,
    reportHourUtc: REPORT_HOUR_UTC,
    connectionStatus: "connected",
    lastMessageAt: iso(hoursAgo(request.now, 8.6)),
    lastMessageError: null,
  };
}

// --- The daily report (notificationsReportPreview, notificationsReportHistory) ---------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function usd(dollars: number): string {
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function usdWhole(dollars: number): string {
  return `$${Math.round(dollars).toLocaleString("en-US")}`;
}

function delta(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? "new" : "—";
  const ratio = current / previous;
  if (ratio >= 3) return `${Math.round(ratio)}x`;
  const pct = Math.round((ratio - 1) * 100);
  return pct === 0 ? "0%" : `${pct > 0 ? "+" : "-"}${Math.abs(pct)}%`;
}

function dot(current: number, previous: number): string {
  if (previous === 0) return "⚪";
  const pct = (current / previous - 1) * 100;
  return Math.abs(pct) < 0.05 ? "⚪" : pct > 0 ? "🟢" : "🔴";
}

/** "mia-vip-of" → "mia-vip", "mia-of" → "mia-free", as the hub's report names pages. */
function reportPageLabel(label: string): string {
  if (!label.endsWith("-of")) return label;
  const stripped = label.slice(0, -3);
  return stripped.includes("-") ? stripped : `${stripped}-free`;
}

function pageRank(label: string): number {
  const number = label.match(/-(\d+)$/);
  if (number) return Number(number[1]);
  if (label.includes("vip")) return 100;
  return 200;
}

/** A page's net over `days` days ending `endAgo` days before today. */
function net(label: string, now: Date, days: number, endAgo: number): number {
  return demoDailyNet(label, new Date(now.getTime() - endAgo * DAY_MS), days).reduce((sum, item) => sum + item.net, 0);
}

export function notificationsReportPreview(request: DemoRequest): KernelOperationResponse<"notificationsReportPreview"> {
  const now = request.now;
  const reportDay = new Date(now.getTime() + 3 * HOUR_MS - 2 * HOUR_MS - DAY_MS);
  const reportDate = reportDay.toISOString().slice(0, 10);
  const pages = DEMO_DATA_PAGES.map((page) => ({
    page,
    yesterday: net(page.label, now, 1, 1),
    dayBefore: net(page.label, now, 1, 2),
    week: net(page.label, now, 7, 1),
    weekBefore: net(page.label, now, 7, 8),
    month: net(page.label, now, 30, 1),
    monthBefore: net(page.label, now, 30, 31),
  }));
  const sum = (key: "yesterday" | "dayBefore" | "week" | "weekBefore" | "month" | "monthBefore", list = pages) =>
    list.reduce((total, item) => total + item[key], 0);
  const lines: string[] = [];
  const date = new Date(`${reportDate}T00:00:00Z`);
  lines.push(`📊 <b>Revenue · ${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}</b>`);
  lines.push(`${dot(sum("yesterday"), sum("dayBefore"))} <b>${usd(sum("yesterday"))}</b> ${delta(sum("yesterday"), sum("dayBefore"))}`);
  lines.push(`<i>7d</i> ${usdWhole(sum("week"))} ${delta(sum("week"), sum("weekBefore"))}  ·  <i>30d</i> ${usdWhole(sum("month"))} ${delta(sum("month"), sum("monthBefore"))}`);
  const models = DEMO_MODELS.map((model) => {
    const own = pages.filter((item) => item.page.modelSlug === model.slug);
    return { model, own, yesterday: sum("yesterday", own), dayBefore: sum("dayBefore", own) };
  }).sort((left, right) => right.yesterday - left.yesterday);
  const agency = sum("yesterday");
  for (const entry of models) {
    const share = agency > 0 ? Math.round((entry.yesterday / agency) * 100) : 0;
    lines.push("");
    lines.push(`${dot(entry.yesterday, entry.dayBefore)} <b>${entry.model.name}</b> ${usd(entry.yesterday)} ${delta(entry.yesterday, entry.dayBefore)} · ${share === 0 && entry.yesterday > 0 ? "&lt;1%" : `${share}%`}`);
    for (const item of [...entry.own].sort((left, right) => pageRank(left.page.label) - pageRank(right.page.label))) {
      lines.push(`   ${reportPageLabel(item.page.label)} ${usd(item.yesterday)} ${delta(item.yesterday, item.dayBefore)}`);
    }
  }
  const random = rng(`report-team:${reportDate}`);
  const shifts = intBetween(random, 8, 11);
  lines.push("");
  lines.push("👥 <b>Команда</b>");
  lines.push(`Смены за сутки: ${shifts} · подтверждено ${shifts - intBetween(random, 0, 2)}`);
  lines.push(`Кастомы не отданы: 2 · самый старый оплачен 3 дн назад`);
  lines.push(`Ждут ответа 6+ ч: 14 (платили 5) · mia-1 6, nova-1 5, mia-2 3`);
  lines.push(`Вернуть, 14 дн: 38 попыток · ответили 11 из 31 · купили 4 из 24`);
  lines.push("");
  lines.push("<i>Windows: 02:00-02:00 MSK · excl. current day</i>");
  return { text: lines.join("\n"), reportDate };
}

export function notificationsReportHistory(request: DemoRequest): KernelOperationResponse<"notificationsReportHistory"> {
  const now = request.now;
  const items: KernelOperationResponse<"notificationsReportHistory">["items"] = [];
  for (let ago = 0; ago < 21; ago += 1) {
    const sentAt = daysAgo(now, ago, REPORT_HOUR_UTC);
    sentAt.setUTCMinutes(0, 4 + (ago % 5), 0);
    if (sentAt.getTime() > now.getTime()) continue;
    const reportDate = new Date(sentAt.getTime() - DAY_MS).toISOString().slice(0, 10);
    // That night the messages were off: the scheduled report was skipped («Пропущен», settings §9.4).
    if (ago === 5) {
      items.push({ id: 3_100 - ago * 2, kind: "daily_report_scheduled", status: "skipped", reportDate, error: "disabled", createdAt: iso(sentAt) });
      continue;
    }
    const failed = ago === 9;
    items.push({
      id: 3_100 - ago * 2,
      kind: "daily_report_scheduled",
      status: failed ? "failed" : "sent",
      reportDate,
      error: failed ? "Telegram 429: Too Many Requests: retry after 31" : null,
      createdAt: iso(sentAt),
    });
    if (failed) {
      items.push({
        id: 3_100 - ago * 2 + 1,
        kind: "daily_report_manual",
        status: "sent",
        reportDate,
        error: null,
        createdAt: iso(new Date(sentAt.getTime() + 47 * MINUTE_MS)),
      });
    }
  }
  return { items: items.sort((left, right) => right.createdAt.localeCompare(left.createdAt)) };
}
