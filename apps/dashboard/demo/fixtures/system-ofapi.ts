/**
 * System → «OnlyFans API»: the vendor's webhook (its optional event groups,
 * the event catalog, the delivery attempts the hub read back), the banned-words
 * dictionary, and what the hub kept of the two OnlyFans pages — mass-message
 * queue progress, post likes and stored read responses.
 *
 * Everything here is stored evidence: collection through the vendor stopped on
 * 2026-11-01, so the newest of it is from that night.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { OFAPI_READ_CATALOG } from "@agency_hub_core/shared";

import { between, demoError, hashString, intBetween, mills, pick, queryNumber, queryString, rng, type DemoReply, type DemoRequest } from "../core.ts";
import { DEMO_OFAPI_OFF_AT, DEMO_PAGES, demoFans, type DemoPage } from "../world.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Collection of the OnlyFans pages through the vendor stopped here. */
const OF_STOP = DEMO_OFAPI_OFF_AT;
const at = (ms: number) => new Date(ms).toISOString();

function uuidOf(seed: string): string {
  const random = rng(seed);
  const hex = (length: number) => Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(random() * 4)]}${hex(3)}-${hex(12)}`;
}

// ── the webhook ──────────────────────────────────────────────────────────────

const OPTIONAL_GROUPS: ReadonlyArray<{ id: string; events: string[] }> = [
  { id: "subscription_expiry", events: ["subscriptions.expired"] },
  { id: "account_lifecycle", events: ["accounts.disconnected"] },
  { id: "media_uploads", events: ["media_uploads.completed", "media_uploads.failed"] },
  {
    id: "data_exports",
    events: [
      "data_exports.calculating_credits", "data_exports.calculating_credits_completed", "data_exports.calculating_credits_failed",
      "data_exports.in_progress", "data_exports.completed", "data_exports.failed", "data_exports.cancelled",
    ],
  },
  { id: "engagement", events: ["posts.liked"] },
];

const APPLIED_GROUPS = ["subscription_expiry", "account_lifecycle", "engagement"];
const WEBHOOK_ID = "wh_01JB7Q2XK4M9T6V3R8N5D2C1FZ";

export function demoWebhookPolicy(): KernelOperationResponse<"adminOfapiWebhookCollectionPolicy"> {
  return {
    version: 4,
    desiredGroups: APPLIED_GROUPS,
    appliedGroups: APPLIED_GROUPS,
    historyEnabled: true,
    applyState: "applied",
    errorCode: null,
    appliedAt: at(Date.UTC(2026, 9, 22, 14, 6)),
    groups: OPTIONAL_GROUPS.map((group) => ({ id: group.id, events: [...group.events] })),
  };
}

/** The vendor's catalog: [event, description, the hub handles it]. */
const CATALOG: ReadonlyArray<[string, string, boolean]> = [
  ["messages.received", "A fan sent a message to the account", true],
  ["messages.sent", "The account sent a message", true],
  ["messages.ppv.unlocked", "A fan unlocked a paid message", true],
  ["messages.deleted", "A message was deleted", true],
  ["subscriptions.new", "A fan subscribed", true],
  ["subscriptions.renewed", "A subscription renewed", true],
  ["subscriptions.expired", "A subscription expired", true],
  ["transactions.new", "A new transaction was recorded", true],
  ["tips.received", "A fan sent a tip", true],
  ["posts.liked", "A fan liked a post", true],
  ["users.online", "A fan came online", true],
  ["users.offline", "A fan went offline", true],
  ["users.typing", "A fan is typing", true],
  ["accounts.connected", "The account was connected", true],
  ["accounts.reconnected", "The account was reconnected", true],
  ["accounts.disconnected", "The account was disconnected", true],
  ["accounts.session_expired", "The account session expired", true],
  ["accounts.authentication_failed", "Authentication of the account failed", true],
  ["accounts.otp_code_required", "The account needs a one-time code", true],
  ["accounts.face_otp_required", "The account needs a face verification", true],
  ["media_uploads.completed", "A media upload finished", true],
  ["media_uploads.failed", "A media upload failed", true],
  ["data_exports.calculating_credits", "Credits of a data export are being calculated", true],
  ["data_exports.calculating_credits_completed", "Credits of a data export were calculated", true],
  ["data_exports.calculating_credits_failed", "Credits of a data export could not be calculated", true],
  ["data_exports.in_progress", "A data export is running", true],
  ["data_exports.completed", "A data export finished", true],
  ["data_exports.failed", "A data export failed", true],
  ["data_exports.cancelled", "A data export was cancelled", true],
  ["queue.updated", "Progress of a mass-message queue", true],
  ["queue.finished", "A mass-message queue finished", true],
  ["streams.started", "The account started a live stream", false],
  ["streams.ended", "The account ended a live stream", false],
  ["stories.viewed", "A fan viewed a story", false],
];

const BASE_EVENTS = new Set([
  "messages.received", "messages.sent", "messages.ppv.unlocked", "messages.deleted", "subscriptions.new",
  "subscriptions.renewed", "transactions.new", "tips.received", "users.online", "users.offline", "accounts.connected",
  "accounts.reconnected", "accounts.session_expired", "accounts.authentication_failed", "accounts.otp_code_required",
  "accounts.face_otp_required", "queue.updated", "queue.finished",
]);

export function demoWebhookCatalog(): KernelOperationResponse<"adminOfapiWebhookEventCatalog"> {
  const groupOf = new Map(OPTIONAL_GROUPS.flatMap((group) => group.events.map((event) => [event, group.id] as const)));
  return {
    source: "onlyfansapi",
    state: "captured",
    observedAt: at(Date.UTC(2026, 9, 20, 11, 42)),
    observationId: "obs_8114203",
    events: CATALOG.map(([value, description, supported]) => {
      const optionalGroup = groupOf.get(value) ?? null;
      return {
        value,
        description,
        requested: BASE_EVENTS.has(value) || (optionalGroup !== null && APPLIED_GROUPS.includes(optionalGroup)),
        supported,
        optionalGroup,
      };
    }),
  };
}

type Attempt = KernelOperationResponse<"adminOfapiWebhookDeliveries">["attempts"][number];

const DELIVERY_EVENTS: ReadonlyArray<[string, number]> = [
  ["messages.received", 0.34], ["messages.sent", 0.22], ["users.online", 0.12], ["users.offline", 0.1],
  ["transactions.new", 0.06], ["tips.received", 0.03], ["subscriptions.renewed", 0.04], ["subscriptions.new", 0.02],
  ["posts.liked", 0.04], ["messages.ppv.unlocked", 0.02], ["queue.updated", 0.01],
];

function deliveries(): Attempt[] {
  // The last day the vendor delivered: newest first, ending just after collection stopped.
  const out: Attempt[] = [];
  let time = OF_STOP + 14 * MINUTE;
  for (let index = 0; index < 140; index += 1) {
    const random = rng(`delivery:${index}`);
    time -= Math.round(between(random, 0.2, 14) * MINUTE);
    let roll = random();
    let eventType = DELIVERY_EVENTS[0]![0];
    for (const [event, weight] of DELIVERY_EVENTS) {
      if (roll < weight) { eventType = event; break; }
      roll -= weight;
    }
    const attemptId = 4_812_000 - index * 3;
    const localEventId = 9_201_400 - index;
    const failed = index === 7 || index === 23 || index === 61;
    const recovered = index === 23 || index === 61;
    // Lost while the hub's endpoint answered 502 during a deploy: no local record, a paid redelivery is still possible.
    const lost = index === 7;
    const base: Attempt = {
      attemptId,
      deliveryUuid: uuidOf(`delivery-uuid:${index}`),
      eventType,
      attemptNumber: 1,
      succeeded: !failed,
      statusCode: failed ? (index === 61 ? null : 502) : 200,
      errorType: failed ? (index === 61 ? "timeout" : "http_error") : null,
      redeliveredFrom: null,
      createdAt: at(time),
      deliveryRecovered: recovered,
      localEventId: lost ? null : localEventId,
      captureState: lost ? null : "accepted",
      localStatus: lost ? null : "processed",
      projectionStatus: lost ? null : eventType.startsWith("users.") ? "none" : "projected",
      canonicalVersion: lost ? null : 2,
      redeliveryState: null,
      redeliveryUuid: null,
      redeliverySucceeded: null,
    };
    out.push(base);
  }
  return out;
}

export function demoWebhookDeliveries(request: DemoRequest): KernelOperationResponse<"adminOfapiWebhookDeliveries"> {
  const limit = Math.min(100, Math.max(1, queryNumber(request, "limit", 25)));
  const offset = Math.max(0, queryNumber(request, "offset", 0));
  const failedOnly = queryString(request, "failedOnly") === "true";
  const attempts = deliveries().filter((attempt) => !failedOnly || !attempt.succeeded).slice(offset, offset + limit);
  return {
    webhookId: WEBHOOK_ID,
    latestScan: {
      id: uuidOf("scan:last"),
      webhookId: WEBHOOK_ID,
      state: "complete",
      from: at(OF_STOP - DAY + 20 * MINUTE),
      to: at(OF_STOP + 20 * MINUTE),
      nextOffset: 412,
      capturedAttempts: 37,
      errorCode: null,
      coverageScope: "credential-visible",
      completedAt: at(OF_STOP + 21 * MINUTE),
    },
    attempts,
  };
}

// ── the banned-words dictionary ──────────────────────────────────────────────

const BANNED: ReadonlyArray<[word: string, risk: string, category: string, alternatives: string | null]> = [
  ["paypal", "high", "payments", "tip me here"],
  ["venmo", "high", "payments", "tip me here"],
  ["cashapp", "high", "payments", "tip me here"],
  ["zelle", "high", "payments", null],
  ["wire transfer", "high", "payments", null],
  ["crypto", "medium", "payments", null],
  ["bitcoin", "medium", "payments", null],
  ["gift card", "high", "payments", null],
  ["snapchat", "high", "off_platform", "my DMs here"],
  ["telegram", "high", "off_platform", "my DMs here"],
  ["whatsapp", "high", "off_platform", "my DMs here"],
  ["kik", "high", "off_platform", null],
  ["my number", "high", "off_platform", "message me here"],
  ["text me", "medium", "off_platform", "message me here"],
  ["email me", "medium", "off_platform", "message me here"],
  ["meet up", "high", "meeting", "chat with me here"],
  ["meetup", "high", "meeting", "chat with me here"],
  ["in person", "high", "meeting", null],
  ["hotel", "medium", "meeting", null],
  ["escort", "high", "meeting", null],
  ["teen", "high", "age", "young at heart"],
  ["schoolgirl", "high", "age", "student"],
  ["underage", "high", "age", null],
  ["minor", "high", "age", null],
  ["daddy's girl", "medium", "age", null],
  ["drunk", "medium", "substances", "tipsy"],
  ["wasted", "low", "substances", "tipsy"],
  ["high af", "medium", "substances", null],
  ["weed", "low", "substances", null],
  ["blood", "medium", "violence", null],
  ["choke", "medium", "violence", null],
  ["unconscious", "high", "consent", null],
  ["asleep", "medium", "consent", null],
  ["forced", "high", "consent", null],
  ["hypnosis", "medium", "consent", null],
  ["incest", "high", "family", null],
  ["stepbro", "medium", "family", "roommate"],
  ["stepsis", "medium", "family", "roommate"],
  ["refund", "low", "payments", null],
  ["chargeback", "medium", "payments", null],
];

export function demoBannedWords(): KernelOperationResponse<"ofapiBannedWordsAdminGet"> {
  return {
    version: "2026-10-14.1",
    observedAt: at(Date.UTC(2026, 9, 16, 9, 18)),
    complete: false,
    pages: 3,
    entries: BANNED.map(([word, riskLevel, category, alternatives]) => ({ word, riskLevel, category, alternatives })),
  };
}

// ── what the hub kept of an OnlyFans page ────────────────────────────────────

function onlyFansPage(pageId: number): DemoPage | undefined {
  return DEMO_PAGES.find((page) => page.id === pageId && page.platform === "onlyfans");
}

export function demoContentEvents(request: DemoRequest): KernelOperationResponse<"ofapiContentEventsGet"> | DemoReply {
  const pageId = queryNumber(request, "pageId", 0);
  const page = onlyFansPage(pageId);
  if (!page) return demoError(400, "Bad Request", "pageId must name an OnlyFans page");
  const limit = Math.min(100, Math.max(1, queryNumber(request, "limit", 50)));
  const random = rng(`content-events:${page.label}`);
  const fans = demoFans(page.label);

  const queues: KernelOperationResponse<"ofapiContentEventsGet">["queues"] = [];
  // Mass messages of the last week before the stop: each sends to the page's subscribers over an hour or two.
  for (let index = 0; index < 6; index += 1) {
    const started = index === 0 ? OF_STOP - 70 * MINUTE : OF_STOP - (index * 26 + intBetween(random, 2, 20)) * HOUR;
    const total = Math.round(page.subscribers * between(random, 0.55, 0.9));
    const queueId = String(30_211_870 + hashString(page.label) % 9000 - index * 137);
    const cancelled = index === 3;
    const steps: Array<[phase: "updated" | "finished", pending: number, minutes: number]> = cancelled
      ? [["updated", Math.round(total * 0.7), 14], ["finished", Math.round(total * 0.55), 22]]
      : [["updated", Math.round(total * 0.62), 12], ["updated", Math.round(total * 0.18), 48], ["finished", 0, 96]];
    // One row a queue: its latest event. The newest queue's finish never came: the vendor stopped first.
    for (const [phase, pending, minutes] of index === 0 && !cancelled ? steps.slice(1, 2) : steps.slice(-1)) {
      queues.push({
        queueId,
        phase,
        queueDate: at(started),
        state: { total, pending, isCanceled: cancelled && phase === "finished", hasError: false, sentCount: total - pending },
        observedAt: at(started + minutes * MINUTE),
        sourceEventId: `evt_${(started / 1000 + minutes).toString(36)}`,
        sourceObservationId: String(8_100_000 + Math.round((started + minutes * MINUTE - Date.UTC(2026, 9, 1)) / MINUTE)),
        timeBasis: "receipt",
      });
    }
  }
  queues.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));

  const likes: KernelOperationResponse<"ofapiContentEventsGet">["likes"] = [];
  for (let index = 0; index < 70; index += 1) {
    const fan = pick(random, fans.slice(0, 120));
    const post = 1_840_000_000 + (hashString(`${page.label}:post:${index % 9}`) % 9_000_000);
    const sourceAt = OF_STOP - Math.round(between(random, 0.1, 6.5) * DAY);
    likes.push({
      postRef: `post:${post}`,
      fanRef: `fan:${fan.platformUserId}`,
      state: random() < 0.04 ? "undone" : "active",
      sourceAt: at(sourceAt),
      observedAt: at(sourceAt + intBetween(random, 2, 40) * 1000),
      sourceEventId: `evt_${(sourceAt / 1000).toString(36)}`,
      sourceObservationId: String(8_000_000 + index * 7 + hashString(page.label) % 1000),
      timeBasis: "provider",
    });
  }
  const unique = new Map(likes.map((like) => [`${like.postRef}:${like.fanRef}`, like]));
  const sortedLikes = [...unique.values()].sort((left, right) => Date.parse(right.sourceAt) - Date.parse(left.sourceAt));
  return {
    pageId: page.id,
    source: "onlyfansapi",
    coverage: "observed_events_only",
    queues: queues.slice(0, limit),
    likes: sortedLikes.slice(0, limit),
    unattributedLikes: intBetween(random, 2, 9),
    queuesHasMore: queues.length > limit,
    likesHasMore: sortedLikes.length > limit,
  };
}


type Snapshot = KernelOperationResponse<"ofapiReadCollectionsGet">["snapshots"][number];

const LISTS: ReadonlyArray<[id: string, name: string, share: number]> = [
  ["fans", "Fans", 1],
  ["following", "Following", 0.02],
  ["1093342", "VIP", 0.03],
  ["1093351", "Big spenders", 0.06],
  ["1102874", "Renew off", 0.21],
  ["1117309", "Custom requests", 0.015],
];

function snapshotsOf(page: DemoPage): Snapshot[] {
  const random = rng(`stored-reads:${page.label}`);
  const accountId = `acct_${page.username.replace(/[^a-z]/g, "")}${page.id}`;
  const fans = demoFans(page.label);
  const snapshots: Snapshot[] = [];
  const base = (operation: string, path: string, query: Record<string, string>, observedAt: number, items: unknown[], coverage: Snapshot["coverage"], window: Snapshot["window"] = { from: null, to: null }): Snapshot => ({
    id: uuidOf(`snapshot:${page.label}:${operation}:${observedAt}`),
    source: "onlyfansapi",
    operation,
    category: OFAPI_READ_CATALOG.find((row) => row.operation === operation)?.category ?? "profile_notifications",
    pathname: `/${accountId}/${path}`,
    query,
    window,
    observedAt: at(observedAt),
    ageSeconds: 0,
    observationId: String(7_900_000 + Math.round((observedAt - Date.UTC(2026, 9, 1)) / MINUTE)),
    granularity: "entity",
    coverage,
    items,
  });

  // The lists, with a preview of their first members.
  for (let day = 0; day < 3; day += 1) {
    const observedAt = OF_STOP - day * DAY - intBetween(random, 20, 200) * MINUTE;
    snapshots.push(base("ofapi_read_user_lists", "user-lists", { limit: "50", offset: "0" }, observedAt, LISTS.map(([id, name, share]) => ({
      nativeId: id,
      listId: id,
      name,
      usersCount: Math.max(1, Math.round(page.subscribers * share)),
      previewUsers: fans.slice(0, 3).map((fan) => ({ id: fan.platformUserId, username: fan.username })),
    })), { state: "complete", reason: null, indexComplete: true, omitted: null, nextQuery: null }));
  }

  // The VIP and big-spender lists' members: their spend and whether the page can write to them.
  for (const [listId, , share] of LISTS.slice(2, 4)) {
    const members = fans.slice(0, Math.max(4, Math.round(fans.length * share * 2)));
    const observedAt = OF_STOP - intBetween(random, 6, 18) * MINUTE;
    const pageSize = 50;
    snapshots.push(base("ofapi_read_user_list_users", `user-lists/${listId}/users`, { limit: String(pageSize), offset: "0" }, observedAt,
      members.slice(0, pageSize).map((fan) => ({
        nativeId: fan.platformUserId,
        username: fan.username,
        name: fan.displayName,
        listId,
        membershipScope: "members",
        contactability: random() < 0.06 ? "restricted" : random() < 0.03 ? "blocked" : "contactable",
        lastReplyAt: at(OF_STOP - fan.lastMessageDaysAgo * DAY - intBetween(random, 1, 600) * MINUTE),
        priorSpendMills: String(mills(fan.totalSpent)),
      })),
      members.length > pageSize
        ? { state: "partial", reason: "has_more", indexComplete: null, omitted: null, nextQuery: { limit: String(pageSize), offset: String(pageSize) } }
        : { state: "complete", reason: null, indexComplete: true, omitted: null, nextQuery: null }));
  }
  snapshots.push(base("ofapi_read_user_list_pinned_users", "user-lists/1093342/users/pinned", { limit: "10", offset: "0" }, OF_STOP - 5 * HOUR,
    fans.slice(0, 4).map((fan) => ({
      nativeId: fan.platformUserId,
      username: fan.username,
      name: fan.displayName,
      listId: "1093342",
      membershipScope: "pinned_only",
      contactability: "contactable",
      lastReplyAt: at(OF_STOP - fan.lastMessageDaysAgo * DAY),
      priorSpendMills: String(mills(fan.totalSpent)),
    })), { state: "complete", reason: null, indexComplete: true, omitted: null, nextQuery: null }));

  // Profile visitors of the last week: one row per day with its counts.
  const from = OF_STOP - 7 * DAY;
  snapshots.push(base("ofapi_read_profile_visitors", "statistics/reach/profile-visitors", { startDate: at(from).slice(0, 10), endDate: at(OF_STOP).slice(0, 10) }, OF_STOP - 10 * HOUR,
    Array.from({ length: 7 }, (_, index) => {
      const day = at(from + index * DAY).slice(0, 10);
      const visitors = Math.round(page.subscribers * between(random, 0.04, 0.09));
      return {
        nativeId: day,
        name: day,
        metrics: [
          { path: "visitors.total", unit: "provider_number", value: String(visitors), valueMills: null },
          { path: "visitors.guests", unit: "provider_number", value: String(Math.round(visitors * 0.38)), valueMills: null },
          { path: "visitors.users", unit: "provider_number", value: String(Math.round(visitors * 0.62)), valueMills: null },
          { path: "subscribers.new", unit: "provider_number", value: String(Math.round(visitors * between(random, 0.02, 0.06))), valueMills: null },
        ],
      };
    }), { state: "complete", reason: null, indexComplete: true, omitted: null, nextQuery: null }, { from: at(from), to: at(OF_STOP) }));

  // The page's top fans by spend, as the vendor ranks them.
  snapshots.push(base("ofapi_read_fans_top", "fans/top", { limit: "25", offset: "0" }, OF_STOP - 9 * HOUR,
    fans.slice(0, 25).map((fan) => ({
      nativeId: fan.platformUserId,
      username: fan.username,
      name: fan.displayName,
      metrics: [
        { path: "spending.total", unit: "mills", value: String(mills(fan.totalSpent)), valueMills: String(mills(fan.totalSpent)) },
        { path: "spending.last30Days", unit: "mills", value: String(mills(fan.spent30d)), valueMills: String(mills(fan.spent30d)) },
      ],
      contactability: "contactable",
      priorSpendMills: String(mills(fan.totalSpent)),
    })), { state: "partial", reason: "bounded_ranking", indexComplete: null, omitted: null, nextQuery: null }));

  return snapshots.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
}

export function demoStoredReads(request: DemoRequest): KernelOperationResponse<"ofapiReadCollectionsGet"> | DemoReply {
  const pageId = queryNumber(request, "pageId", 0);
  const page = onlyFansPage(pageId);
  if (!page) return demoError(400, "Bad Request", "pageId must name an OnlyFans page");
  const operation = queryString(request, "operation");
  const limit = Math.min(100, Math.max(1, queryNumber(request, "limit", 25)));
  const now = request.now.getTime();
  return {
    pageId: page.id,
    catalog: OFAPI_READ_CATALOG.map((row) => ({
      id: row.id,
      operation: row.operation,
      path: row.path,
      category: row.category,
      detail: row.detail,
      defaultCollect: row.defaultCollect,
      granularity: row.granularity,
      query: { ...row.query },
    })),
    snapshots: snapshotsOf(page)
      .filter((snapshot) => operation === undefined || snapshot.operation === operation)
      .slice(0, limit)
      .map((snapshot) => ({ ...snapshot, ageSeconds: Math.round((now - Date.parse(snapshot.observedAt)) / 1000) })),
  };
}
