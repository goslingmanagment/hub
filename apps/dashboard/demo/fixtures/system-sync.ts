/**
 * System → «Fansly» and «OnlyFans»: how each page is collected.
 *
 * The Fansly pages are the Fansly Sync Engine's (mode `live`, each with its
 * server browser): their five blocks say what each stream last read, what is
 * due and what stops it; `/sync/pages` adds the pause record, the hour's
 * requests, the queue and the browser; `/sync/history-requests` the chats'
 * history asked for. The OnlyFans pages are the legacy executor's, parked
 * since collection through the vendor stopped on 2026-11-01.
 *
 * The world's exceptions show here too: nova-1's subscriber list has not been
 * read for nine hours (a 429 holds the route, a row is in quarantine); mia-3
 * has one chat Fansly no longer serves; the owner paused ivy-2's history reads.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { between, demoError, hashString, intBetween, iso, queryNumber, queryString, rng, type DemoReply, type DemoRequest } from "../core.ts";
import { DEMO_PAGES, demoPage, type DemoPage } from "../world.ts";

type BlocksPage = KernelOperationResponse<"syncOverview">["pages"][number];
type Block = BlocksPage["blocks"]["connection"];
type BlockKey = Block["block"];
type Substream = Block["substreams"][number];
type Stop = NonNullable<Block["engine"]>["stops"][number];
type PageStatus = KernelOperationResponse<"syncPages">["pages"][number];
type HistoryRequest = KernelOperationResponse<"syncHistoryRequests">["requests"][number];
type Stream = Substream["stream"];

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Collection of the OnlyFans pages through the vendor stopped here. */
const OF_STOP = Date.UTC(2026, 10, 1, 0, 0);
/** The owner's pause between two requests of a page (S). */
const PAUSE_MS = 2500;

const at = (ms: number) => new Date(ms).toISOString();

// ── the engine's vocabulary (apps/runtime/src/sync/fansly/registry.ts) ───────

const STREAM_KEYS: Record<string, readonly string[]> = {
  light: ["account.poll"],
  transactions: ["transactions.head", "transactions.insurance", "transactions.rescan", "transactions.backfill"],
  top_spenders: ["top-spenders.window", "top-spenders.bootstrap"],
  subscribers: ["subscribers.poll", "subscribers.history", "fan-profiles.lookup"],
  followers: ["followers.head", "fan-profiles.lookup"],
  followers_reconcile: ["followers.reconcile", "fan-profiles.lookup"],
  dm_conversations: [
    "dm-conversations.head", "dm-conversations.full", "dm-conversations.find", "dm-conversations.detail",
    "dm-conversations.ws-down", "fan-profiles.probe",
  ],
  dm_messages: ["dm-messages.head", "dm-messages.catchup", "dm-messages.history"],
};

const POLL_KEYS = new Set([
  "account.poll", "transactions.insurance", "transactions.rescan", "top-spenders.window", "subscribers.poll",
  "followers.head", "dm-conversations.head", "dm-conversations.full",
]);

/** A stream's poll period: its first poll key's (0: no poll). */
const STREAM_POLL_SECONDS: Record<string, number> = {
  light: 3600, transactions: 900, top_spenders: 21_600, subscribers: 3600, followers: 3600,
  followers_reconcile: 0, dm_conversations: 1800, dm_messages: 0,
};

const ENGINE_BLOCK_STREAMS: Record<BlockKey, ReadonlyArray<{ stream: Stream; role: "primary" | "supporting" }>> = {
  connection: [{ stream: "light", role: "primary" }],
  financials: [{ stream: "transactions", role: "primary" }, { stream: "top_spenders", role: "supporting" }],
  audience: [
    { stream: "subscribers", role: "primary" },
    { stream: "followers", role: "primary" },
    { stream: "followers_reconcile", role: "supporting" },
  ],
  messages_live: [{ stream: "dm_conversations", role: "primary" }],
  messages_history: [{ stream: "dm_messages", role: "primary" }],
};

function blockKeys(block: BlockKey): string[] {
  return [...new Set(ENGINE_BLOCK_STREAMS[block].flatMap(({ stream }) => STREAM_KEYS[stream] ?? []))];
}

// ── what the engine knows of a Fansly page now ───────────────────────────────

interface StreamFacts {
  succeededAt: number | null;
  nextDueAt: number | null;
  activeWork: number;
  waiting: { resource: string; reason: string; until: number | null } | null;
  quarantined: Record<string, number>;
  blocked: Record<string, number>;
}

interface PageFacts {
  page: DemoPage;
  streams: Record<string, StreamFacts>;
  pausedKeys: string[];
  /** Stops other than the owner's pauses. */
  holds: Stop[];
  chatsUnavailable: number;
  /** How busy the page is: scales the hour's requests and the queue. */
  load: number;
}

function busy(page: DemoPage): number {
  if (page.label === "nova-1") return 1.3;
  if (page.modelSlug === "mia-hart") return page.label === "mia-3" ? 0.7 : 1;
  return 0.35;
}

function pageFacts(page: DemoPage, now: number): PageFacts {
  // Facts move every five minutes, not on every 10-second poll of the screen.
  const tick = Math.floor(now / (5 * MINUTE));
  const random = rng(`engine:${page.label}:${tick}`);
  const load = busy(page);
  const ago = (minMin: number, maxMin: number) => now - between(random, minMin, maxMin) * MINUTE;
  const poll = (stream: string, minAgo: number, maxAgo: number, active: number, resource: string): StreamFacts => {
    const succeededAt = ago(minAgo, maxAgo);
    const period = (STREAM_POLL_SECONDS[stream] ?? 3600) * SECOND;
    const nextDueAt = Math.max(now + 20 * SECOND, succeededAt + period);
    return {
      succeededAt,
      nextDueAt,
      activeWork: active,
      waiting: { resource, reason: "not_due", until: nextDueAt },
      quarantined: {},
      blocked: {},
    };
  };
  const threads = Math.max(1, Math.round(between(random, 6, 22) * load));
  const streams: Record<string, StreamFacts> = {
    light: poll("light", 4, 52, 1, "account.poll"),
    transactions: poll("transactions", 1, 13, 2, "transactions.insurance"),
    top_spenders: poll("top_spenders", 40, 330, 1, "top-spenders.window"),
    subscribers: poll("subscribers", 3, 55, 1, "subscribers.poll"),
    followers: poll("followers", 3, 55, 1, "followers.head"),
    followers_reconcile: {
      succeededAt: now - between(random, 1.5, 4) * DAY, nextDueAt: null, activeWork: 0, waiting: null, quarantined: {}, blocked: {},
    },
    dm_conversations: poll("dm_conversations", 1, 24, Math.max(1, Math.round(3 * load)), "dm-conversations.head"),
    dm_messages: {
      succeededAt: now - between(random, 5, 90) * SECOND,
      nextDueAt: now + between(random, 1, 6) * SECOND,
      activeWork: threads,
      waiting: { resource: "dm-messages.head", reason: "pacer", until: now + PAUSE_MS },
      quarantined: {},
      blocked: {},
    },
  };
  const facts: PageFacts = { page, streams, pausedKeys: [], holds: [], chatsUnavailable: 0, load };

  if (page.label === "nova-1") {
    // Fansly answers 429 on the subscriptions route: the route is held, and one history row of the list is in quarantine.
    const until = now + (38 - (Math.floor(now / MINUTE) % 30)) * MINUTE;
    facts.holds.push({ reason: "route_hold", by: ["/api/v1/subscriptions"], resources: ["subscribers.poll", "subscribers.history"], until: at(until) });
    streams.subscribers = {
      succeededAt: now - 9 * HOUR - 4 * MINUTE,
      nextDueAt: until,
      activeWork: 2,
      waiting: { resource: "subscribers.poll", reason: "route_hold", until },
      quarantined: { "subscribers.history": 1 },
      blocked: {},
    };
  }
  if (page.label === "mia-3") facts.chatsUnavailable = 1;
  if (page.label === "ivy-2") {
    facts.pausedKeys = ["dm-messages.history"];
  }
  return facts;
}

function stopsOf(keys: readonly string[], facts: PageFacts): { stops: Stop[]; stopped: "none" | "some" | "all"; paused: boolean } {
  const stops: Stop[] = [];
  const pausedHere = keys.filter((key) => facts.pausedKeys.includes(key));
  if (pausedHere.length > 0) stops.push({ reason: "paused", by: ["keys"], resources: pausedHere, until: null });
  for (const hold of facts.holds) {
    const here = hold.resources.filter((key) => keys.includes(key));
    if (here.length > 0) stops.push({ ...hold, resources: here });
  }
  const stoppedKeys = new Set(stops.flatMap((stop) => stop.resources));
  const stopped = stoppedKeys.size === 0 ? "none" : stoppedKeys.size >= keys.length ? "all" : "some";
  return { stops, stopped, paused: pausedHere.length === keys.length && keys.length > 0 };
}

function count(record: Record<string, number>): { count: number; resources: string[] } {
  const resources = Object.keys(record).filter((key) => (record[key] ?? 0) > 0);
  return { count: resources.reduce((sum, key) => sum + (record[key] ?? 0), 0), resources };
}

function engineSubstream(stream: Stream, role: "primary" | "supporting", facts: PageFacts): Substream {
  const own = facts.streams[stream]!;
  const keys = STREAM_KEYS[stream] ?? [];
  const { stops, stopped, paused } = stopsOf(keys, facts);
  const quarantined = count(own.quarantined);
  const blocked = count(own.blocked);
  const needsAttention = quarantined.count > 0 || blocked.count > 0;
  const statusReason = needsAttention
    ? {
      code: quarantined.count > 0 ? "engine_quarantined" : "engine_blocked_by_vendor",
      summary: `${quarantined.count} quarantined (${quarantined.resources.join(", ")}); pnpm cli sync work list --page ${facts.page.label} --state quarantined`,
      waitingFor: null,
    }
    : own.waiting === null
      ? null
      : {
        code: own.waiting.reason,
        summary: `${own.waiting.resource}: ${own.waiting.reason}${own.waiting.until === null ? "" : ` until ${at(own.waiting.until)}`}`,
        waitingFor: null,
      };
  return {
    stream,
    role,
    state: "engine",
    succeededAt: own.succeededAt === null ? null : at(own.succeededAt),
    nextDueAt: own.nextDueAt === null ? null : at(own.nextDueAt),
    nextRetryAt: null,
    cadenceSeconds: STREAM_POLL_SECONDS[stream] ?? 0,
    isFresh: !needsAttention,
    needsAttention,
    statusReason,
    error: needsAttention && statusReason !== null
      ? { stream, code: statusReason.code, summary: statusReason.summary, failedAt: null, consecutiveFailures: 3 }
      : null,
    engine: { stopped, stops, paused, activeWork: own.activeWork },
  };
}

function engineBlock(block: BlockKey, facts: PageFacts): Block {
  const substreams = ENGINE_BLOCK_STREAMS[block].map(({ stream, role }) => engineSubstream(stream, role, facts));
  const keys = blockKeys(block);
  const { stops, stopped, paused } = stopsOf(keys, facts);
  const attention = substreams.find((substream) => substream.needsAttention) ?? null;
  const times = (pick: (substream: Substream) => string | null) =>
    substreams.map(pick).filter((value): value is string => value !== null).map(Date.parse);
  const succeeded = times((substream) => substream.succeededAt);
  const due = times((substream) => substream.nextDueAt);
  const merge = (pick: (stream: StreamFacts) => Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const { stream } of ENGINE_BLOCK_STREAMS[block]) {
      for (const [key, value] of Object.entries(pick(facts.streams[stream]!))) out[key] = (out[key] ?? 0) + value;
    }
    return count(out);
  };
  const activeWork = [...new Set(ENGINE_BLOCK_STREAMS[block].map(({ stream }) => stream))]
    .reduce((sum, stream) => sum + facts.streams[stream]!.activeWork, 0);
  return {
    block,
    state: "engine",
    engineMode: "live",
    engine: {
      mode: "live",
      ownerRunning: true,
      keys,
      pollKeys: keys.filter((key) => POLL_KEYS.has(key)),
      pausedKeys: keys.filter((key) => facts.pausedKeys.includes(key)),
      pausedAll: false,
      stopped,
      stops,
      paused,
      activeWork,
      quarantined: merge((stream) => stream.quarantined),
      blockedByVendor: merge((stream) => stream.blocked),
      ...(block === "messages_history" ? { chatsUnavailable: facts.chatsUnavailable } : {}),
    },
    succeededAt: succeeded.length === 0 ? null : at(Math.max(...succeeded)),
    progress: null,
    progressStream: null,
    progressRole: null,
    error: attention?.error ?? null,
    statusReason: attention?.statusReason ?? { code: "fansly_sync_engine", summary: "Managed by the Fansly Sync Engine", waitingFor: null },
    primaryFresh: attention === null,
    needsAttention: attention !== null,
    nextDueAt: due.length === 0 ? null : at(Math.min(...due)),
    nextRetryAt: null,
    intervals: substreams.filter((substream) => substream.cadenceSeconds > 0)
      .map((substream) => ({ stream: substream.stream, cadenceSeconds: substream.cadenceSeconds })),
    metrics: {},
    connectionStatus: block === "connection" ? "connected" : null,
    substreams,
  };
}

// ── an OnlyFans page: the legacy executor, parked since 2026-11-01 ───────────

function legacySubstream(
  stream: Stream,
  role: "primary" | "supporting",
  state: Exclude<Substream["state"], "engine">,
  succeededAt: number | null,
  cadenceSeconds: number,
  statusReason: Substream["statusReason"] = null,
): Substream {
  return {
    stream,
    role,
    state,
    succeededAt: succeededAt === null ? null : at(succeededAt),
    nextDueAt: null,
    nextRetryAt: null,
    cadenceSeconds,
    isFresh: false,
    needsAttention: false,
    statusReason,
    error: null,
  };
}

function legacyBlock(
  block: BlockKey,
  state: Block["state"],
  fields: Partial<Block> & Pick<Block, "succeededAt" | "substreams">,
): Block {
  return {
    block,
    state,
    progress: null,
    progressStream: null,
    progressRole: null,
    error: null,
    statusReason: null,
    primaryFresh: false,
    needsAttention: false,
    nextDueAt: null,
    nextRetryAt: null,
    intervals: fields.substreams.map((substream) => ({ stream: substream.stream, cadenceSeconds: substream.cadenceSeconds })),
    metrics: {},
    connectionStatus: null,
    ...fields,
  };
}

function onlyFansBlocks(page: DemoPage): BlocksPage["blocks"] {
  const random = rng(`of-blocks:${page.label}`);
  const lastLight = OF_STOP - between(random, 8, 40) * MINUTE;
  const lastTransaction = OF_STOP - between(random, 2, 25) * MINUTE;
  const lastSubscribers = OF_STOP - between(random, 30, 200) * MINUTE;
  const lastWebhook = OF_STOP + between(random, 1, 14) * MINUTE;
  const transactionCount = Math.round(page.dailyNet * between(random, 410, 470));
  return {
    connection: legacyBlock("connection", "paused", {
      succeededAt: at(lastLight),
      connectionStatus: "connected",
      substreams: [legacySubstream("light", "primary", "paused", lastLight, 3600)],
      metrics: { ofapiAuthStatus: "connected", ofapiAuthChangedAt: at(OF_STOP - 41 * DAY) },
    }),
    financials: legacyBlock("financials", "up_to_date", {
      succeededAt: at(lastTransaction),
      primaryFresh: true,
      statusReason: { code: "ofapi_financials_live", summary: "Financials are fed by OFAPI transactions.", waitingFor: null },
      substreams: [
        legacySubstream("transactions", "primary", "paused", lastTransaction, 3600),
        legacySubstream("fan_identities", "supporting", "paused", lastTransaction - 2 * HOUR, 21_600),
        legacySubstream("top_spenders", "supporting", "paused", lastTransaction - 3 * HOUR, 21_600),
      ],
      metrics: { ofapiFinancials: true, transactionCount, lastOfapiTransactionAt: at(lastTransaction) },
    }),
    audience: legacyBlock("audience", "paused", {
      succeededAt: at(lastSubscribers),
      substreams: [legacySubstream("subscribers", "primary", "paused", lastSubscribers, 3600)],
    }),
    messages_live: legacyBlock("messages_live", "delayed", {
      succeededAt: at(lastWebhook),
      needsAttention: true,
      statusReason: { code: "webhook_silent", summary: "No OFAPI message events have been received recently.", waitingFor: null },
      substreams: [legacySubstream("dm_conversations", "primary", "paused", lastWebhook, 1800)],
      metrics: { webhookIngest: true, lastWebhookEventAt: at(lastWebhook) },
    }),
    messages_history: legacyBlock("messages_history", "not_available", {
      succeededAt: null,
      substreams: [],
      intervals: [],
    }),
  };
}

function blocksPage(page: DemoPage, now: number): BlocksPage {
  let blocks: BlocksPage["blocks"];
  if (page.platform === "fansly") {
    const facts = pageFacts(page, now);
    blocks = {
      connection: engineBlock("connection", facts),
      financials: engineBlock("financials", facts),
      audience: engineBlock("audience", facts),
      messages_live: engineBlock("messages_live", facts),
      messages_history: engineBlock("messages_history", facts),
    };
  } else {
    blocks = onlyFansBlocks(page);
  }
  return {
    pageId: page.id,
    pageLabel: page.label,
    platform: page.platform,
    modelSlug: page.modelSlug,
    modelName: page.modelName,
    username: page.username,
    displayName: page.displayName,
    diagnosis: null,
    blocks,
  };
}

export function demoSyncOverview(request: DemoRequest): KernelOperationResponse<"syncOverview"> {
  const now = request.now.getTime();
  return { generatedAt: at(now), diagnosis: null, pages: DEMO_PAGES.map((page) => blocksPage(page, now)) };
}

export function demoPageSyncBlocks(request: DemoRequest): KernelOperationResponse<"pageSyncBlocks"> | DemoReply {
  const page = demoPage(request.params.pageLabel ?? "");
  if (!page) return demoError(404, "Not Found", `Page ${request.params.pageLabel} not found`);
  const now = request.now.getTime();
  return { generatedAt: at(now), page: blocksPage(page, now) };
}

// ── /sync/pages: the engine's own status of every Fansly page ────────────────

const OPERATOR_VERSION = "4b7e2c91d0a3";
const CHROME_VERSION = "156.0.8110.62";

function exitIp(page: DemoPage): string {
  return `203.0.113.${20 + (hashString(page.label) % 200)}`;
}

function sendsByResource(facts: PageFacts, total: number, random: () => number): Record<string, number> {
  const weights: Array<[string, number]> = [
    ["dm-messages.head", 0.34],
    ["dm-conversations.detail", 0.14],
    ["dm-messages.history", facts.pausedKeys.includes("dm-messages.history") ? 0 : 0.16],
    ["dm-conversations.head", 0.07],
    ["transactions.insurance", 0.06],
    ["transactions.head", 0.05],
    ["fan-profiles.probe", 0.05],
    ["followers.head", 0.03],
    ["subscribers.poll", facts.page.label === "nova-1" ? 0 : 0.03],
    ["posts.engagement", 0.03],
    ["stats.hourly", 0.02],
    ["account.poll", 0.01],
    ["notifications.forward", 0.01],
  ];
  const sum = weights.reduce((acc, [, weight]) => acc + weight, 0);
  const out: Record<string, number> = {};
  let left = total;
  weights.forEach(([key, weight], index) => {
    if (weight === 0) return;
    const value = index === weights.length - 1 ? left : Math.min(left, Math.round((total * weight) / sum * between(random, 0.85, 1.15)));
    if (value > 0) out[key] = value;
    left -= value;
  });
  if (left > 0) out["dm-messages.head"] = (out["dm-messages.head"] ?? 0) + left;
  return out;
}

function pageStatus(page: DemoPage, now: number, open: HistoryRequest[]): PageStatus {
  const facts = pageFacts(page, now);
  const random = rng(`status:${page.label}:${Math.floor(now / (5 * MINUTE))}`);
  const total = Math.round(between(random, 520, 760) * facts.load);
  const urgent = Math.round(total * 0.38);
  const requests = page.label === "ivy-2" ? 0 : Math.round(total * between(random, 0.12, 0.2));
  const planned = Math.max(0, total - urgent - requests);
  const byResource = sendsByResource(facts, total, random);
  const quarantined = Object.values(facts.streams).reduce((sum, stream) => sum + count(stream.quarantined).count, 0);
  const lastSendAt = now - between(random, 0.4, 2.4) * SECOND;
  const ip = exitIp(page);
  const started = now - (31 * HOUR + 9 * MINUTE);
  return {
    pageLabel: page.label,
    mode: "live",
    owner: {
      generation: String(40 + (hashString(page.label) % 9)),
      host: "agency-de/sync-5d20e7f9",
      acquiredAt: at(started + 50 * SECOND),
      heartbeatAt: at(now - between(random, 1, 9) * SECOND),
      running: true,
    },
    pause: {
      settingMs: PAUSE_MS,
      lastSendAt: at(lastSendAt),
      minGapLastHourMs: PAUSE_MS + intBetween(random, 4, 60),
      violationsLastDay: 0,
      siteCloseLastDay: intBetween(random, 2, 30),
    },
    sendsLastHour: { urgent, requests, planned, byResource },
    queue: {
      urgent: {
        runnable: intBetween(random, 0, Math.round(4 * facts.load)),
        waitingByReason: page.label === "nova-1" ? { pacer: 2, route_hold: 1 } : { pacer: intBetween(random, 0, 3) },
      },
      requests: {
        runnable: open.length > 0 ? intBetween(random, 1, 6) : 0,
        waitingByReason: page.label === "ivy-2" ? { paused: 4 } : open.length > 0 ? { class_share: intBetween(random, 2, 14), route_budget: intBetween(random, 0, 3) } : {},
      },
      planned: {
        runnable: intBetween(random, 1, 5),
        waitingByReason: {
          not_due: intBetween(random, 26, 34),
          class_share: intBetween(random, 0, 6),
          ...(page.label === "nova-1" ? { route_hold: 1, quarantined: 1 } : {}),
        },
      },
    },
    holds: { page: null, resources: [] },
    breakers: { open: 0, blockedByVendor: 0 },
    quarantined,
    requests: open.map((request) => ({
      ref: request.ref,
      itemsReady: request.counts.ready,
      itemsTotal: request.counts.total,
      readsDone: request.reads.done,
      readsRemainingMin: request.reads.remainingMin,
      etaEstimateSeconds: request.eta.estimateSeconds,
    })),
    ws: {
      connected: true,
      since: at(now - between(random, 2, 20) * HOUR),
      gapSince: null,
      decodeDebt: 0,
    },
    shadow: null,
    browser: {
      profileId: uuidOf(`profile:${page.label}`),
      container: `pb-${page.label}`,
      transport: "browser",
      leavePendingSince: null,
      link: { lastStateAt: at(now - between(random, 2, 14) * SECOND), stateAgeMs: intBetween(random, 2000, 14_000), error: null },
      state: {
        step: "ready",
        stopReason: null,
        retryAt: null,
        exitOpen: true,
        mode: "automation",
        downSince: null,
        stopSince: null,
      },
      ownerStop: null,
      halt: null,
      login: { needed: false, why: null },
      session: { present: true, accountId: `3${String(hashString(page.username)).padStart(10, "0")}${String(page.id).padStart(7, "0")}` },
      proxy: { pinnedExitIp: ip, pinnedAt: at(now - 11 * DAY), exitIp: ip, matches: true, problem: null },
      buffer: {
        bytes: intBetween(random, 8_000, 260_000),
        oldestAgeMs: intBetween(random, 300, 4_000),
        percent: round1(between(random, 0.1, 2.4)),
        capBytes: 64 * 1024 * 1024,
        capAgeMs: 10 * MINUTE,
        haltedReason: null,
        haltedAt: null,
        undrainedSince: null,
      },
      delivery: {
        lastEventAt: at(now - between(random, 1, 9) * SECOND),
        lastCommitAt: at(now - between(random, 1, 9) * SECOND),
        p50Ms: intBetween(random, 140, 260),
        p95Ms: intBetween(random, 520, 980),
        at: at(now - 30 * SECOND),
      },
      versions: { chrome: CHROME_VERSION, operator: OPERATOR_VERSION },
      selfTest: { ok: true, at: at(started + 3 * MINUTE), failed: null },
      hubSend: { allowed: true, reason: null, since: at(started + 4 * MINUTE), forMs: null },
      crashDumps: {
        completed: { count: page.label === "mia-1" ? 1 : 0, newestAt: page.label === "mia-1" ? at(now - 6 * DAY) : null },
        pending: { count: 0, newestAt: null },
        countedAt: at(started + 2 * MINUTE),
      },
      egressFailures: {
        since: at(started + 2 * MINUTE),
        socks: page.label === "mia-2"
          ? [{ kind: "unavailable", step: "connect", rep: 1, cls: "site", count: 2, lastAt: at(now - 3 * HOUR - 12 * MINUTE), lastHost: "apiv3.fansly.com" }]
          : [],
        dnr: [
          { cls: "telemetry", probe: false, count: intBetween(random, 30, 140), lastAt: at(now - between(random, 1, 30) * MINUTE), lastHost: "metrics.fansly.com" },
          { cls: "telemetry", probe: true, count: 1, lastAt: at(started + 3 * MINUTE), lastHost: "metrics.fansly.com" },
        ],
      },
      lastAlarm: page.label === "mia-2"
        ? { kind: "socks_unavailable", at: at(now - 3 * HOUR - 12 * MINUTE), ageMs: 3 * HOUR + 12 * MINUTE, detail: { host: "apiv3.fansly.com", count: 2 } }
        : null,
      siteObserved: {
        unconfirmed: intBetween(random, 0, 3),
        oldestAt: at(now - between(random, 2, 20) * SECOND),
        oldestAgeMs: intBetween(random, 2000, 20_000),
        dropped: 0,
        lastHour: (() => {
          const sent = Math.round(between(random, 140, 320) * facts.load);
          return { sent, ended: sent, unended: 0, responses: sent - intBetween(random, 0, 2), responsesWithoutSend: 0, lastRecordedAt: at(now - between(random, 1, 20) * SECOND) };
        })(),
      },
      alerts: [],
    },
  };
}

export function demoSyncPages(request: DemoRequest): KernelOperationResponse<"syncPages"> {
  const now = request.now.getTime();
  const all = historyRequests(now);
  return {
    pages: DEMO_PAGES.filter((page) => page.platform === "fansly").map((page) =>
      pageStatus(page, now, all.filter((item) => item.pageLabel === page.label && item.state === "open"))),
  };
}

// ── history requests ────────────────────────────────────────────────────────

interface RequestPlan {
  seed: string;
  page: string;
  state: HistoryRequest["state"];
  depth: HistoryRequest["depth"];
  requester: HistoryRequest["requesterKind"];
  /** Hours since it was filed. */
  filedHoursAgo: number;
  /** Hours it took (closed ones). */
  tookHours?: number;
  fans: number;
  readsPerFan: number;
  /** Share of fans ready (open ones). */
  readyShare?: number;
}

const REQUEST_PLANS: readonly RequestPlan[] = [
  { seed: "mia-1:reactivation", page: "mia-1", state: "open", depth: { kind: "all" }, requester: "agent_key", filedHoursAgo: 3.2, fans: 40, readsPerFan: 13, readyShare: 0.65 },
  { seed: "mia-1:vip-latest", page: "mia-1", state: "open", depth: { kind: "latest", count: 200 }, requester: "owner_session", filedHoursAgo: 0.45, fans: 12, readsPerFan: 4, readyShare: 0.17 },
  { seed: "nova-1:top", page: "nova-1", state: "open", depth: { kind: "latest", count: 500 }, requester: "agent_key", filedHoursAgo: 1.1, fans: 8, readsPerFan: 9, readyShare: 0.62 },
  { seed: "nova-1:facts", page: "nova-1", state: "done", depth: { kind: "all" }, requester: "owner_cli", filedHoursAgo: 7.5, tookHours: 1.6, fans: 26, readsPerFan: 11 },
  { seed: "mia-2:spenders", page: "mia-2", state: "done", depth: { kind: "all" }, requester: "agent_key", filedHoursAgo: 27, tookHours: 4.2, fans: 120, readsPerFan: 8 },
  { seed: "mia-3:winback", page: "mia-3", state: "cancelled", depth: { kind: "latest", count: 100 }, requester: "owner_session", filedHoursAgo: 49, tookHours: 0.3, fans: 30, readsPerFan: 2 },
  { seed: "mia-1:boundary", page: "mia-1", state: "done", depth: { kind: "before_boundary" }, requester: "legacy_hydration_wrapper", filedHoursAgo: 53, tookHours: 2.4, fans: 64, readsPerFan: 6 },
  { seed: "ivy-1:all", page: "ivy-1", state: "done", depth: { kind: "all" }, requester: "owner_cli", filedHoursAgo: 75, tookHours: 0.9, fans: 9, readsPerFan: 5 },
  { seed: "mia-2:latest", page: "mia-2", state: "done", depth: { kind: "latest", count: 300 }, requester: "agent_key", filedHoursAgo: 98, tookHours: 1.2, fans: 18, readsPerFan: 6 },
  { seed: "nova-1:switch", page: "nova-1", state: "done", depth: { kind: "all" }, requester: "switch_migration", filedHoursAgo: 312, tookHours: 19, fans: 410, readsPerFan: 12 },
];

function uuidOf(seed: string): string {
  const random = rng(seed);
  const hex = (length: number) => Array.from({ length }, () => Math.floor(random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(random() * 4)]}${hex(3)}-${hex(12)}`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function historyRequest(plan: RequestPlan, now: number, openOnPage: number, positionOnPage: number): HistoryRequest {
  const random = rng(`history:${plan.seed}`);
  const createdAt = now - plan.filedHoursAgo * HOUR;
  const fans = plan.fans;
  const totalReads = fans * plan.readsPerFan;
  const depth = plan.depth.kind === "before_boundary"
    ? { kind: "before_boundary" as const, boundaryAt: at(createdAt - 40 * DAY), boundaryMessageRef: `8${String(hashString(plan.seed)).padStart(17, "0")}` }
    : plan.depth;
  if (plan.state !== "open") {
    const closedAt = createdAt + (plan.tookHours ?? 1) * HOUR;
    const refused = plan.state === "done" ? Math.round(fans * between(random, 0, 0.05)) : 0;
    const cancelled = plan.state === "cancelled" ? fans - Math.round(fans * 0.2) : 0;
    const ready = fans - refused - cancelled;
    return {
      ref: uuidOf(`ref:${plan.seed}`),
      pageLabel: plan.page,
      state: plan.state,
      depth,
      requesterKind: plan.requester,
      createdAt: at(createdAt),
      doneAt: plan.state === "done" ? at(closedAt) : null,
      cancelledAt: plan.state === "cancelled" ? at(closedAt) : null,
      counts: { total: fans, ready, queued: 0, loading: 0, blocked: 0, refused, cancelled },
      reads: { done: plan.state === "done" ? totalReads : Math.round(totalReads * 0.2), remainingMin: 0, remainingEstimate: 0 },
      eta: { lowerBoundSeconds: 0, estimateSeconds: 0, basis: "estimate", ratePerHour: 0, sharePercent: 30, limitedBy: "page", slowdown: null, hold: null },
      queuePosition: null,
      waitingReason: null,
      waitingUntil: null,
    };
  }
  const ready = Math.round(fans * (plan.readyShare ?? 0.5));
  const blocked = plan.page === "mia-1" && fans > 20 ? 1 : 0;
  const refused = fans > 20 ? Math.round(fans * 0.07) : 0;
  const loading = Math.min(1, fans - ready - blocked - refused);
  const queued = Math.max(0, fans - ready - blocked - refused - loading);
  // Progress moves with the clock: a read every few minutes.
  const elapsedHours = plan.filedHoursAgo;
  const done = Math.min(totalReads - 10, Math.round(totalReads * (plan.readyShare ?? 0.5) + elapsedHours * 3));
  const remainingMin = Math.max(4, Math.round((queued + loading) * plan.readsPerFan * 0.75));
  const remainingEstimate = Math.round(remainingMin * between(random, 1.3, 1.6));
  const sharePercent = 30;
  // S = 2.5 s gives the page 1440 slots an hour; the requests class gets its share, shared by the open requests.
  const ratePerHour = round1((3600_000 / PAUSE_MS) * (sharePercent / 100) / Math.max(1, openOnPage) * (plan.page === "nova-1" ? 0.8 : 1));
  const routeLimited = plan.page === "nova-1";
  return {
    ref: uuidOf(`ref:${plan.seed}`),
    pageLabel: plan.page,
    state: "open",
    depth,
    requesterKind: plan.requester,
    createdAt: at(createdAt),
    doneAt: null,
    cancelledAt: null,
    counts: { total: fans, ready, queued, loading, blocked, refused, cancelled: 0 },
    reads: { done, remainingMin, remainingEstimate },
    eta: {
      lowerBoundSeconds: Math.round((remainingMin / ratePerHour) * 3600),
      estimateSeconds: Math.round((remainingEstimate / ratePerHour) * 3600),
      basis: "estimate",
      ratePerHour,
      sharePercent,
      limitedBy: routeLimited ? "family" : "page",
      slowdown: routeLimited ? { route: "/api/v1/message", effectivePerMin: 21.6, currentPerMin: 27 } : null,
      hold: null,
    },
    queuePosition: positionOnPage,
    waitingReason: positionOnPage === 1 ? "pacer" : "class_share",
    waitingUntil: at(now + (positionOnPage === 1 ? PAUSE_MS : 40 * SECOND)),
  };
}

function historyRequests(now: number): HistoryRequest[] {
  const openCount = new Map<string, number>();
  for (const plan of REQUEST_PLANS) if (plan.state === "open") openCount.set(plan.page, (openCount.get(plan.page) ?? 0) + 1);
  const position = new Map<string, number>();
  return REQUEST_PLANS
    .map((plan) => {
      let place = 0;
      if (plan.state === "open") {
        place = (position.get(plan.page) ?? 0) + 1;
        position.set(plan.page, place);
      }
      return historyRequest(plan, now, openCount.get(plan.page) ?? 0, place);
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function demoSyncHistoryRequests(request: DemoRequest): KernelOperationResponse<"syncHistoryRequests"> | DemoReply {
  const pageLabel = queryString(request, "pageLabel");
  const state = queryString(request, "state");
  if (pageLabel !== undefined && !demoPage(pageLabel)) return demoError(404, "Not Found", `Page ${pageLabel} not found`);
  const limit = Math.min(200, Math.max(1, queryNumber(request, "limit", 50)));
  const offset = Math.max(0, queryNumber(request, "offset", 0));
  const requests = historyRequests(request.now.getTime())
    .filter((item) => pageLabel === undefined || item.pageLabel === pageLabel)
    .filter((item) => state === undefined || item.state === state)
    .slice(offset, offset + limit);
  return { requests };
}
