/**
 * System → the developer's screens: the sync runs' event log and its
 * anomalies, one run in detail, the background job queue, the database and
 * the chat extension's health reports.
 *
 * Runs are laid on a fixed clock (every page's streams at their cadence), so a
 * run keeps its id from one reload to the next and a row of «Журнал» opens the
 * same run in «Запуск синка». Messages are the hub's own (English, as the
 * runtime writes them).
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import {
  between,
  demoError,
  hoursAgo,
  intBetween,
  iso,
  pick,
  queryNumber,
  queryString,
  rng,
  type DemoReply,
  type DemoRequest,
} from "../core.ts";
import { DEMO_DATA_PAGES, DEMO_OFAPI_OFF_AT, DEMO_PAGES, type DemoPage } from "../world.ts";
import { DEMO_MIGRATIONS } from "./system-migrations.ts";

type LogItem = KernelOperationResponse<"adminLogs">[number];
type RunDetail = KernelOperationResponse<"adminSyncRunDetail">;
type QueueJob = KernelOperationResponse<"adminQueueJobs">[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Run ids count minutes from here (2026-01-01T00:00Z). */
const ID_EPOCH = Date.UTC(2026, 0, 1);
/** Collection of the OnlyFans pages through the vendor stopped here. */
const OF_STOP = DEMO_OFAPI_OFF_AT;

// ── the runs ─────────────────────────────────────────────────────────────────

interface StreamPlan {
  stream: string;
  cadenceMin: number;
  endpoint: string;
  operation: string;
}

const FANSLY_STREAMS: readonly StreamPlan[] = [
  { stream: "light", cadenceMin: 30, endpoint: "/api/v1/account/me", operation: "account.me" },
  { stream: "transactions", cadenceMin: 60, endpoint: "/api/v1/payments/transactions", operation: "transactions.list" },
  { stream: "subscribers", cadenceMin: 60, endpoint: "/api/v1/subscriptions", operation: "subscribers.list" },
  { stream: "followers", cadenceMin: 60, endpoint: "/api/v1/account/{id}/followers", operation: "followers.list" },
  { stream: "dm_conversations", cadenceMin: 30, endpoint: "/api/v1/messaging/groups", operation: "groups.list" },
  { stream: "top_spenders", cadenceMin: 360, endpoint: "/api/v1/stats/topspenders", operation: "topspenders.window" },
];

const OF_STREAMS: readonly StreamPlan[] = [
  { stream: "light", cadenceMin: 60, endpoint: "/api/{account}/me", operation: "ofapi.me" },
  { stream: "transactions", cadenceMin: 60, endpoint: "/api/{account}/payouts/transactions", operation: "ofapi.transactions" },
  { stream: "subscribers", cadenceMin: 240, endpoint: "/api/{account}/fans/active", operation: "ofapi.fans.active" },
];

/** Index of a page in the run id (stable: the order of DEMO_PAGES). */
function pageIndex(page: DemoPage): number {
  return DEMO_PAGES.indexOf(page);
}

function streamsOf(page: DemoPage): readonly StreamPlan[] {
  return page.platform === "fansly" ? FANSLY_STREAMS : OF_STREAMS;
}

function offsetMin(page: DemoPage, streamIdx: number, cadence: number): number {
  return (pageIndex(page) * 4 + streamIdx * 7 + 2) % cadence;
}

interface DemoEvent {
  kind: string;
  severity: "info" | "warn" | "error";
  message: string;
  details: Record<string, unknown>;
  offsetMs: number;
}

interface DemoRun {
  runId: number;
  page: DemoPage;
  plan: StreamPlan;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "success" | "partial" | "failed";
  trigger: string;
  errorSummary: string | null;
  events: DemoEvent[];
  stats: Record<string, unknown>;
  attempts: Array<{ state: string; httpStatus: number | null; durationMs: number | null; failureKind: string | null; errorMessage: string | null; retryDelayMs: number | null }>;
}

function runIdOf(page: DemoPage, streamIdx: number, startedAt: number): number {
  const minute = Math.floor((startedAt - ID_EPOCH) / MINUTE);
  return minute * 64 + pageIndex(page) * 8 + streamIdx;
}

/** Builds one run from its slot. Everything about it follows from its id. */
function buildRun(page: DemoPage, streamIdx: number, startedAt: number, now: number): DemoRun {
  const plan = streamsOf(page)[streamIdx]!;
  const runId = runIdOf(page, streamIdx, startedAt);
  const random = rng(`run:${runId}`);
  const durationMs = Math.round(between(random, 1.2, 9) * 1000) + (plan.stream === "transactions" ? 6000 : 0);
  const running = startedAt + durationMs > now;
  const events: DemoEvent[] = [
    { kind: "run_started", severity: "info", message: "Sync run started", details: { trigger: "scheduled" }, offsetMs: 0 },
  ];
  let status: DemoRun["status"] = "success";
  let errorSummary: string | null = null;
  const pages = intBetween(random, 1, plan.stream === "transactions" ? 4 : 2);
  const items = plan.stream === "light" ? 1 : intBetween(random, page.dailyNet < 20 ? 0 : 3, Math.max(4, Math.round(page.dailyNet / 6)));
  const attempts: DemoRun["attempts"] = [];
  const ivy = page.modelSlug === "ivy-rose";
  const roll = random();

  const anomaly = (code: string, severity: "info" | "warn" | "error", message: string, details: Record<string, unknown> = {}) => {
    events.push({ kind: "anomaly", severity, message, details: { code, ...details }, offsetMs: Math.round(durationMs * 0.6) });
  };

  // nova-1's subscribers list: Fansly answers 429 for the last nine hours (world: "attention").
  const novaSubscribersDown = page.label === "nova-1" && plan.stream === "subscribers" && now - startedAt < 9 * HOUR;

  if (novaSubscribersDown) {
    status = "failed";
    errorSummary = "HTTP 429 on /api/v1/subscriptions";
    anomaly("rate_limited", "error", "Fansly answered 429 Too Many Requests; the stream backs off until the route recovers", {
      httpStatus: 429, route: "/api/v1/subscriptions", backoffSeconds: 1800,
    });
    attempts.push(
      { state: "retry", httpStatus: 429, durationMs: 412, failureKind: "rate_limited", errorMessage: "429 Too Many Requests", retryDelayMs: 30_000 },
      { state: "failed", httpStatus: 429, durationMs: 388, failureKind: "rate_limited", errorMessage: "429 Too Many Requests", retryDelayMs: null },
    );
  } else {
    if (plan.stream === "transactions" && ivy && roll < 0.3) {
      anomaly("checkpoint_stalled", "info", "No new operations since the last checkpoint", { checkpointAgeHours: intBetween(random, 6, 40) });
    } else if (plan.stream === "transactions" && roll < 0.05) {
      anomaly("after_ineffective", "error", "The source ignored the lower bound of the filter; older operations were scanned again", {
        earlyStoppedBeyondBoundary: true, scannedPages: intBetween(random, 2, 5), boundaryAgeMinutes: intBetween(random, 50, 70),
      });
    } else if (plan.stream === "followers" && roll < 0.03) {
      const hub = (page.followers ?? 0) + intBetween(random, -40, 40);
      anomaly("follower_count_mismatch", "warn", "Follower count from the platform differs from the hub's; reconcile queued", {
        platformCount: page.followers, hubCount: hub,
      });
      status = "partial";
    } else if (plan.stream === "light" && roll < 0.01) {
      anomaly("rate_limited", "warn", "Fansly answered 429; the stream retries next cycle", { httpStatus: 429, route: plan.endpoint });
      status = "partial";
    } else if (plan.stream === "dm_conversations" && roll < 0.015) {
      anomaly("timeout", "warn", "Request timed out after 30000 ms", { timeoutMs: 30_000, route: plan.endpoint });
      status = "partial";
    } else if (plan.stream === "top_spenders" && roll < 0.08) {
      anomaly("top_spenders_missing_identity", "warn", "Skipped top spender rows missing both correlationAccountId and accountId", {
        skippedCount: intBetween(random, 1, 3),
      });
    } else if (roll > 0.996) {
      anomaly("high_retry_volume", "warn", "Run exceeded the retry volume threshold", { retryAttempts: intBetween(random, 4, 7) });
      status = "partial";
    }
    for (let index = 0; index < pages; index += 1) {
      const retry = status === "partial" && index === 0;
      attempts.push({
        state: retry ? "retry" : "success",
        httpStatus: retry ? (plan.stream === "dm_conversations" ? null : 429) : 200,
        durationMs: retry && plan.stream === "dm_conversations" ? 30_000 : Math.round(between(random, 180, 1400)),
        failureKind: retry ? (plan.stream === "dm_conversations" ? "timeout" : "rate_limited") : null,
        errorMessage: retry ? (plan.stream === "dm_conversations" ? "Request timed out after 30000 ms" : "429 Too Many Requests") : null,
        retryDelayMs: retry ? 15_000 : null,
      });
      if (retry) attempts.push({ state: "success", httpStatus: 200, durationMs: Math.round(between(random, 200, 900)), failureKind: null, errorMessage: null, retryDelayMs: null });
    }
    if (plan.stream === "transactions" && items > 0) {
      events.push({ kind: "checkpoint_advanced", severity: "info", message: "Advanced transactions checkpoint", details: { inserted: items }, offsetMs: Math.round(durationMs * 0.8) });
    }
  }

  if (!running) {
    events.push({
      kind: "run_finished",
      severity: status === "failed" ? "error" : status === "partial" ? "warn" : "info",
      message: `Sync run finished with status ${status}`,
      details: status === "failed"
        ? { status, health: "failed", error: { code: "rate_limited", httpStatus: 429 } }
        : { status, health: status === "partial" ? "degraded" : "healthy" },
      offsetMs: durationMs,
    });
  }

  return {
    runId,
    page,
    plan,
    startedAt,
    finishedAt: running ? null : startedAt + durationMs,
    status: running ? "running" : status,
    trigger: random() < 0.08 ? "event" : "scheduled",
    errorSummary,
    events,
    stats: {
      pagesFetched: attempts.filter((attempt) => attempt.state === "success").length,
      itemsSeen: novaSubscribersDown ? 0 : items,
      requests: attempts.length,
      retryAttempts: attempts.filter((attempt) => attempt.state === "retry").length,
    },
    attempts,
  };
}

/** Every run that started in [from, to), newest first. */
function runsBetween(from: number, to: number, now: number): DemoRun[] {
  const runs: DemoRun[] = [];
  // The log of the old collection holds only the OnlyFans pages, frozen with the API (as on production).
  for (const page of DEMO_DATA_PAGES.filter((item) => item.platform === "onlyfans")) {
    const plans = streamsOf(page);
    plans.forEach((plan, streamIdx) => {
      const cadence = plan.cadenceMin * MINUTE;
      const offset = offsetMin(page, streamIdx, plan.cadenceMin) * MINUTE;
      const end = page.platform === "onlyfans" ? Math.min(to, OF_STOP) : to;
      let start = Math.floor((end - offset) / cadence) * cadence + offset;
      if (start >= end) start -= cadence;
      for (let t = start; t >= from; t -= cadence) runs.push(buildRun(page, streamIdx, t, now));
    });
  }
  return runs.sort((left, right) => right.startedAt - left.startedAt);
}

function logItems(run: DemoRun): LogItem[] {
  return run.events.map((event, index) => ({
    id: run.runId * 8 + index + 1,
    syncRunId: run.runId,
    provider: run.page.platform,
    stream: run.plan.stream,
    eventType: event.kind,
    severity: event.severity,
    message: event.message,
    details: event.details,
    emittedAt: iso(new Date(run.startedAt + event.offsetMs)),
    pageLabel: run.page.label,
  }));
}

/** The incidents read's severity: a benign after-filter anomaly reads as a warning. */
function incidentSeverity(item: LogItem): string {
  return item.details.code === "after_ineffective" && item.severity === "error" && item.details.earlyStoppedBeyondBoundary === true
    ? "warn"
    : item.severity;
}

/** The newest events that pass `keep`, widening the window until `limit` are found (at most two weeks). */
function newestEvents(now: number, limit: number, keep: (item: LogItem) => boolean): LogItem[] {
  for (const windowMs of [12 * HOUR, 3 * DAY, 14 * DAY]) {
    const items = runsBetween(now - windowMs, now, now)
      .flatMap(logItems)
      .filter((item) => Date.parse(item.emittedAt) <= now && keep(item))
      .sort((left, right) => Date.parse(right.emittedAt) - Date.parse(left.emittedAt) || right.id - left.id);
    if (items.length >= limit || windowMs === 14 * DAY) return items.slice(0, limit);
  }
  return [];
}

export function demoAdminLogs(request: DemoRequest): LogItem[] {
  const severity = queryString(request, "severity");
  const limit = Math.min(500, Math.max(1, queryNumber(request, "limit", 100)));
  return newestEvents(request.now.getTime(), limit, (item) => severity === undefined || item.severity === severity);
}

export function demoAdminIncidents(request: DemoRequest): KernelOperationResponse<"adminIncidents"> {
  const now = request.now.getTime();
  const severity = queryString(request, "severity");
  const code = queryString(request, "code");
  const limit = Math.min(500, Math.max(1, queryNumber(request, "limit", 100)));
  const isIncident = (item: LogItem) => item.severity === "warn" || item.severity === "error" || item.eventType === "anomaly";
  const items = newestEvents(now, limit, (item) =>
    isIncident(item)
    && (severity === undefined || incidentSeverity(item) === severity)
    && (code === undefined || item.details.code === code))
    .map((item) => ({ ...item, severity: incidentSeverity(item) }));
  const counts = new Map<string, { code: string | null; severity: string; count: number }>();
  for (const item of runsBetween(now - 7 * DAY, now, now).flatMap(logItems)) {
    if (!isIncident(item) || Date.parse(item.emittedAt) > now) continue;
    const itemCode = typeof item.details.code === "string" ? item.details.code : null;
    const itemSeverity = incidentSeverity(item);
    const key = `${itemCode}|${itemSeverity}`;
    const entry = counts.get(key) ?? { code: itemCode, severity: itemSeverity, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const summary = [...counts.values()].sort((left, right) => right.count - left.count).slice(0, 20);
  return { summary, items };
}

/** A run id names its page, stream and minute: the run is rebuilt from it, or it never ran. */
export function demoSyncRunDetail(request: DemoRequest): RunDetail | DemoReply {
  const runId = Number(request.params.runId);
  const now = request.now.getTime();
  const notFound = demoError(404, "Not Found", `Sync run ${request.params.runId} not found`);
  if (!Number.isInteger(runId) || runId <= 0) return notFound;
  const streamIdx = runId % 8;
  const page = DEMO_PAGES[Math.floor(runId / 8) % 8];
  const startedAt = ID_EPOCH + Math.floor(runId / 64) * MINUTE;
  if (!page) return notFound;
  const plan = streamsOf(page)[streamIdx];
  if (!plan || startedAt > now || startedAt < now - 30 * DAY) return notFound;
  if (page.platform === "onlyfans" && startedAt >= OF_STOP) return notFound;
  const offset = offsetMin(page, streamIdx, plan.cadenceMin) * MINUTE;
  if ((startedAt - offset) % (plan.cadenceMin * MINUTE) !== 0) return notFound;
  const run = buildRun(page, streamIdx, startedAt, now);
  const accountId = 1000 + page.id;
  return {
    run: {
      runId: run.runId,
      platformAccountId: accountId,
      pageLabel: page.label,
      platform: page.platform,
      stream: plan.stream,
      trigger: run.trigger,
      status: run.status,
      startedAt: iso(new Date(run.startedAt)),
      finishedAt: run.finishedAt === null ? null : iso(new Date(run.finishedAt)),
      errorSummary: run.errorSummary,
      stats: run.stats,
    },
    events: logItems(run).map((item) => ({
      id: item.id,
      runId: run.runId,
      platformAccountId: accountId,
      pageLabel: item.pageLabel,
      provider: item.provider,
      stream: item.stream,
      eventType: item.eventType,
      severity: item.severity,
      message: item.message,
      details: item.details,
      emittedAt: item.emittedAt,
    })),
    attempts: (() => {
      let at = run.startedAt + 120;
      let logical = 1;
      return run.attempts.map((attempt, index) => {
        const attemptNumber = index > 0 && run.attempts[index - 1]!.state === "retry" ? 2 : 1;
        if (attemptNumber === 1 && index > 0) logical += 1;
        const startedAt = at;
        at += (attempt.durationMs ?? 0) + (attempt.retryDelayMs ?? 0) + 40;
        return {
          attemptId: run.runId * 16 + index + 1,
          runId: run.runId,
          platformAccountId: accountId,
          pageLabel: page.label,
          provider: page.platform,
          stream: plan.stream,
          operation: plan.operation,
          logicalRequestId: `${run.runId.toString(36)}-${logical}`,
          attemptNumber,
          state: attempt.state,
          failureKind: attempt.failureKind,
          httpStatus: attempt.httpStatus,
          retryDelayMs: attempt.retryDelayMs,
          durationMs: attempt.durationMs,
          requestShape: { method: "GET", endpointTemplate: plan.endpoint, egressKey: `page:${page.label}`, limit: 25, offset: (logical - 1) * 25 },
          responseShape: attempt.httpStatus === 200 ? { items: intBetween(rng(`items:${run.runId}:${index}`), 3, 25), hasMore: index < run.attempts.length - 1 } : {},
          errorMessage: attempt.errorMessage,
          startedAt: iso(new Date(startedAt)),
          finishedAt: iso(new Date(startedAt + (attempt.durationMs ?? 0))),
        };
      });
    })(),
  };
}

/** The newest run of the log, for a link that opens a run. */
export function demoLatestRunId(now: Date): number {
  const run = runsBetween(now.getTime() - 2 * HOUR, now.getTime(), now.getTime()).find((item) => item.page.label === "mia-of");
  return run?.runId ?? 0;
}

// ── the job queue (pg-boss) ──────────────────────────────────────────────────

interface JobPlan {
  name: string;
  everyMin: number;
  /** Seconds a run takes. */
  seconds: [number, number];
  data: (random: () => number, at: number) => unknown;
  output: (random: () => number, at: number) => unknown;
  /** A failure, sometimes. */
  fail?: (random: () => number, at: number) => string | null;
}

const fanslyLabels = DEMO_PAGES.filter((page) => page.platform === "fansly").map((page) => page.label);

const JOBS: readonly JobPlan[] = [
  {
    name: "sync.planner", everyMin: 1, seconds: [0.3, 1.4],
    data: () => null,
    output: (random) => ({ pagesPlanned: 2, rowsDue: intBetween(random, 0, 4), skipped: "onlyfans_collection_off" }),
  },
  {
    name: "ops.metrics.sample", everyMin: 1, seconds: [0.2, 0.8],
    data: () => null,
    output: (random) => ({ samples: 14, dbConnections: intBetween(random, 11, 24), diskUsedPercent: 63 }),
  },
  {
    name: "notifications.delivery-outbox.sweep", everyMin: 1, seconds: [0.1, 0.5],
    data: () => null,
    output: (random) => ({ delivered: random() < 0.12 ? 1 : 0, pending: 0 }),
  },
  {
    name: "projections.message-archive.sweep", everyMin: 2, seconds: [0.6, 3.5],
    data: () => ({ batchSize: 500 }),
    output: (random) => ({ projected: intBetween(random, 8, 160), lagSeconds: intBetween(random, 1, 40) }),
  },
  {
    name: "canonicalize.sweep", everyMin: 5, seconds: [1, 6],
    data: () => ({ batchSize: 1000 }),
    output: (random) => ({ canonicalized: intBetween(random, 20, 400), cursor: `obs:${intBetween(random, 8_100_000, 8_200_000)}` }),
  },
  {
    name: "ai.media.describe.sweep", everyMin: 5, seconds: [2, 18],
    data: () => ({ pages: ["mia-1", "nova-1"] }),
    output: (random) => ({ described: intBetween(random, 0, 6), skippedPpvBodies: intBetween(random, 0, 2), spentMicroUsd: intBetween(random, 0, 42_000) }),
  },
  {
    name: "chat-memory.fan-facts", everyMin: 10, seconds: [4, 40],
    data: () => ({ pages: ["mia-1", "nova-1"] }),
    output: (random) => ({ conversations: intBetween(random, 2, 14), factsAdded: intBetween(random, 0, 22), spentMicroUsd: intBetween(random, 30_000, 420_000) }),
  },
  {
    name: "voice.provider.health", everyMin: 10, seconds: [0.4, 1.2],
    data: () => null,
    output: (random) => ({ provider: "elevenlabs", ok: true, latencyMs: intBetween(random, 180, 420), charactersLeft: 412_300 }),
  },
  {
    name: "chat-memory.history.top-up", everyMin: 15, seconds: [1, 5],
    data: () => null,
    output: (random) => ({ requestsFiled: random() < 0.3 ? 1 : 0, chatsChecked: intBetween(random, 40, 120) }),
  },
  {
    name: "fan-marks.blocklist.read", everyMin: 30, seconds: [2, 7],
    data: () => null,
    output: (random) => ({ handles: 1_000 + intBetween(random, 180, 240), newSince: intBetween(random, 0, 3) }),
  },
  {
    name: "db.disk-usage.check", everyMin: 60, seconds: [0.2, 0.6],
    data: () => null,
    output: () => ({ usedPercent: 63, freeGb: 71.4, alertPercent: 80 }),
  },
  {
    name: "ai.provider-reports.sync", everyMin: 60, seconds: [1, 3],
    data: () => ({ accounts: ["main", "second", "third"] }),
    output: (random) => ({ daysSynced: 1, linesImported: intBetween(random, 30, 90) }),
    fail: (random) => (random() < 0.18 ? "Anthropic Admin API answered 401: no admin key for account \"third\"" : null),
  },
  {
    name: "observations.partitions.ensure", everyMin: 24 * 60, seconds: [0.4, 1.1],
    data: () => null,
    output: () => ({ created: ["observations_2026_11_10"], existing: 7 }),
  },
  {
    name: "telegram.daily-report", everyMin: 24 * 60, seconds: [1.5, 4],
    data: () => ({ day: "yesterday" }),
    output: () => ({ sent: true, pages: 8, chat: "owner" }),
  },
];

/** A page's engine work that the worker hands to the sync process, queued by an owner's «Синк сейчас». */
function syncExecuteJob(at: number, random: () => number): Pick<QueueJob, "data" | "output"> {
  return { data: { pageLabel: pick(random, fanslyLabels), resources: ["transactions"] }, output: { bumped: intBetween(random, 1, 3) } };
}

function job(plan: JobPlan | null, at: number, now: number): QueueJob {
  const name = plan?.name ?? "sync.page.execute";
  const random = rng(`job:${name}:${at}`);
  const startDelay = between(random, 0.05, 1.5) * 1000;
  const runMs = plan ? between(random, plan.seconds[0], plan.seconds[1]) * 1000 : between(random, 0.4, 2) * 1000;
  const started = at + startDelay;
  const completed = started + runMs;
  const failure = plan?.fail?.(random, at) ?? null;
  const id = `${(hashHex(`${name}:${at}`))}`;
  const content = plan ? { data: plan.data(random, at), output: plan.output(random, at) } : syncExecuteJob(at, random);
  let state: string;
  if (now < started) state = "created";
  else if (now < completed) state = "active";
  else state = failure ? "failed" : "completed";
  const retryLimit = plan?.fail ? 2 : 0;
  return {
    id,
    name,
    state,
    data: content.data ?? null,
    createdOn: iso(new Date(at)),
    startedOn: state === "created" ? null : iso(new Date(started)),
    completedOn: state === "completed" || state === "failed" ? iso(new Date(completed)) : null,
    output: state === "completed" ? content.output ?? null : state === "failed" ? { message: failure, name: "Error" } : null,
    retryLimit,
    retryCount: state === "failed" ? retryLimit : 0,
  };
}

function hashHex(seed: string): string {
  const random = rng(seed);
  const part = () => Math.floor(random() * 0x10000).toString(16).padStart(4, "0");
  return `${part()}${part()}-${part()}-4${part().slice(1)}-a${part().slice(1)}-${part()}${part()}${part()}`;
}

export function demoQueueJobs(request: DemoRequest): QueueJob[] {
  const now = request.now.getTime();
  const state = queryString(request, "state");
  const name = queryString(request, "name");
  const limit = Math.min(200, Math.max(1, queryNumber(request, "limit", 50)));
  const out: QueueJob[] = [];
  for (const windowMs of [3 * HOUR, 2 * DAY, 7 * DAY]) {
    out.length = 0;
    for (const plan of JOBS) {
      const every = plan.everyMin * MINUTE;
      // Daily jobs run at 06:00 UTC, the rest on their minute grid.
      const shift = plan.everyMin >= 24 * 60 ? 6 * HOUR : 0;
      let at = Math.floor((now - shift) / every) * every + shift;
      // The current minute's job is already created.
      for (; at > now - windowMs; at -= every) out.push(job(plan, at, now));
    }
    // A few «Синк сейчас» from the owner over the day.
    for (let hour = 0; hour < windowMs / HOUR; hour += 1) {
      const slot = Math.floor(now / HOUR) - hour;
      const random = rng(`sync-now:${slot}`);
      if (random() < 0.12) out.push(job(null, slot * HOUR + intBetween(random, 1, 58) * MINUTE, now));
    }
    // Right now: the facts lane is mid-run, and the planner's next tick is queued.
    out.push(
      {
        ...job(JOBS.find((plan) => plan.name === "chat-memory.fan-facts")!, now - 34_000, now + 3_600_000),
        state: "active",
        startedOn: iso(new Date(now - 33_200)),
        completedOn: null,
        output: null,
      },
      { ...job(JOBS[0]!, now - 1_500, now), state: "created", startedOn: null, completedOn: null, output: null },
    );
    const filtered = out
      .filter((item) => Date.parse(item.createdOn) <= now)
      .filter((item) => state === undefined || item.state === state)
      .filter((item) => name === undefined || item.name === name);
    if (filtered.length >= limit || windowMs === 7 * DAY) {
      return filtered.sort((left, right) => Date.parse(right.createdOn) - Date.parse(left.createdOn)).slice(0, limit);
    }
  }
  return [];
}

// ── the database ─────────────────────────────────────────────────────────────

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** The largest tables of the hub, as pg_stat_user_tables reads them. */
const TABLES: ReadonlyArray<[table: string, rows: number, totalBytes: number, indexShare: number]> = [
  ["observations", 41_820_000, 18.6 * GB, 0.22],
  ["dm_messages", 6_940_000, 7.9 * GB, 0.31],
  ["sync_http_attempts", 12_310_000, 4.1 * GB, 0.28],
  ["message_archive", 6_880_000, 3.7 * GB, 0.46],
  ["sync_attempts", 9_450_000, 2.6 * GB, 0.34],
  ["domain_events", 5_120_000, 1.9 * GB, 0.25],
  ["sync_run_events", 4_380_000, 1.4 * GB, 0.29],
  ["fan_transactions", 1_204_000, 1.1 * GB, 0.38],
  ["dm_live_messages", 1_960_000, 0.92 * GB, 0.33],
  ["ofapi_read_snapshots", 186_000, 0.84 * GB, 0.08],
  ["ai_usage_events", 742_000, 0.61 * GB, 0.27],
  ["fan_facts", 1_310_000, 0.52 * GB, 0.35],
  ["sync_work", 1_870_000, 0.47 * GB, 0.52],
  ["page_browser_transitions", 2_240_000, 0.39 * GB, 0.3],
  ["ai_generation_content", 211_000, 0.36 * GB, 0.06],
  ["fan_identities", 402_000, 0.29 * GB, 0.41],
  ["sync_observed_site_requests", 1_520_000, 0.27 * GB, 0.37],
  ["fansly_creator_stats_media_hourly", 980_000, 0.21 * GB, 0.32],
  ["ops_metric_samples", 1_430_000, 0.18 * GB, 0.3],
  ["ai_media_descriptions", 48_200, 0.15 * GB, 0.05],
  ["chatter_activity_minutes", 1_110_000, 0.12 * GB, 0.44],
  ["followers", 61_400, 96 * MB, 0.4],
  ["subscribers", 9_840, 41 * MB, 0.42],
  ["posts", 14_600, 38 * MB, 0.21],
  ["fansly_creator_stats_revenue", 51_300, 33 * MB, 0.36],
  ["page_fan_list_members", 118_000, 31 * MB, 0.48],
  ["client_health_perf_hourly", 64_200, 27 * MB, 0.31],
  ["history_request_items", 88_700, 24 * MB, 0.45],
  ["ofapi_webhook_delivery_attempts", 41_900, 19 * MB, 0.3],
  ["publication_files", 2_310, 9 * MB, 0.18],
  ["shift_report_lines", 21_400, 7 * MB, 0.33],
  ["fan_queue_items", 12_900, 5.4 * MB, 0.4],
  ["ai_personas", 14, 400 * 1024, 0.25],
  ["pages", 8, 96 * 1024, 0.5],
  ["users", 9, 80 * 1024, 0.6],
  ["models", 3, 48 * 1024, 0.5],
];

export function demoDbStats(request: DemoRequest): KernelOperationResponse<"adminDbStats"> {
  const now = request.now;
  const first = Date.UTC(2025, 8, 14, 10);
  // The last migrations came with the deploy 31 h ago; the rest spread over a year of deploys.
  const lastDeploy = hoursAgo(now, 31.15).getTime();
  const count = DEMO_MIGRATIONS.length;
  let previous = first;
  const migrations = DEMO_MIGRATIONS.map((name, index) => {
    const tail = count - index <= 3;
    const fraction = index / Math.max(1, count - 4);
    const random = rng(`migration:${name}`);
    let at = tail ? lastDeploy + (index - (count - 3)) * 180 : first + fraction ** 0.85 * (lastDeploy - 2 * DAY - first) + between(random, 0, 3) * HOUR;
    at = Math.max(at, previous + 90);
    previous = at;
    return { name, appliedAt: iso(new Date(Math.round(at))) };
  });
  return {
    tables: TABLES.map(([table, rows, totalBytes, indexShare]) => ({
      schema: "public",
      table,
      rowEstimate: rows < 1000 ? rows : Math.round(rows * between(rng(`table:${table}`), 0.985, 1.015)),
      totalBytes: Math.round(totalBytes),
      indexBytes: Math.round(totalBytes * indexShare),
    })),
    migrations,
  };
}

// ── the chat extension's health reports ──────────────────────────────────────

type ClientHealth = KernelOperationResponse<"adminClientHealth">;

interface VersionPlan {
  version: string;
  /** Share of the reports of a day. */
  share: number;
  build: string;
  /** Slower or faster than the newest. */
  speed: number;
}

const VERSIONS: readonly VersionPlan[] = [
  { version: "3.6.2", share: 0.71, build: "index-B7xQ2kLm", speed: 1 },
  { version: "3.6.1", share: 0.22, build: "index-B7xQ2kLm", speed: 1.06 },
  { version: "3.5.4", share: 0.07, build: "index-Dq81fWzA", speed: 1.24 },
];

const PERF_METRICS: ReadonlyArray<[metric: string, p50: number, perReport: number]> = [
  ["routeToDockMs", 84, 22],
  ["panelOpenMs", 38, 9],
  ["requestOverheadMs", 11, 14],
  ["ttfcMs", 1840, 6],
  ["firstChunkPaintMs", 16, 6],
  ["insertMs", 27, 5],
  ["boardOpenMs", 142, 1.2],
  ["searchMs", 6.4, 3],
  ["handlerMs", 2.1, 40],
  ["eventLatencyMs", 31, 60],
  ["composerInputDelayMs", 4.2, 80],
];

/** Reports a day: eight chatters' extensions report every 15 minutes while open. */
const REPORTS_PER_DAY = 310;

export function demoClientHealth(request: DemoRequest): ClientHealth | DemoReply {
  const clientName = queryString(request, "clientName");
  const from = queryString(request, "from");
  const to = queryString(request, "to");
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    return demoError(400, "Bad Request", "`from` must be on or before `to`");
  }
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
  // Today counts only the hours so far (Moscow is UTC+3).
  const hoursToday = ((request.now.getUTCHours() + 3) % 24) + request.now.getUTCMinutes() / 60;
  const dayWeight = days - 1 + Math.max(0.15, hoursToday / 24);
  const random = rng(`client-health:${from}:${to}`);
  const minGroupSize = 20;
  const metricFilter = queryString(request, "metric");

  const reportsOf = (plan: VersionPlan) => {
    // The oldest version left the fleet a week ago: only wide ranges see it.
    const weight = plan.version === "3.5.4" ? Math.max(0, dayWeight - 7) / Math.max(1, dayWeight) : 1;
    return Math.round(REPORTS_PER_DAY * dayWeight * plan.share * weight * between(random, 0.92, 1.08));
  };

  const perf: ClientHealth["perf"] = [];
  for (const plan of VERSIONS) {
    const reports = reportsOf(plan);
    if (reports === 0) continue;
    for (const [metric, p50Base, perReport] of PERF_METRICS) {
      if (metricFilter !== undefined && metric !== metricFilter) continue;
      const count = Math.round(reports * perReport * between(random, 0.8, 1.2));
      if (count === 0) continue;
      const suppressed = count < minGroupSize;
      const p50 = round1(p50Base * plan.speed * between(random, 0.9, 1.1));
      const p95 = round1(p50 * (metric === "ttfcMs" ? 2.1 : between(random, 2.6, 4.2)));
      perf.push({
        clientName: "chat-extension",
        clientVersion: plan.version,
        hostKind: "chatspace",
        hostBuild: plan.build,
        metric,
        schemaVersion: 1,
        count,
        mean: suppressed ? null : round1(p50 * 1.35),
        max: suppressed ? null : round1(p95 * between(random, 2.5, 6)),
        p50: suppressed ? null : p50,
        p95: suppressed ? null : p95,
        suppressed,
      });
    }
  }

  // ChatSpace rolled a new build yesterday evening; the newest version still finds most anchors on it.
  const newBuildReports = days >= 2 || hoursToday > 0 ? Math.round(REPORTS_PER_DAY * Math.min(dayWeight, 1.6) * 0.38) : 0;
  // Few measurements on ChatSpace's new build yet: the board was opened there only a handful of times.
  if (newBuildReports > 0 && (metricFilter === undefined || metricFilter === "boardOpenMs")) {
    perf.push({
      clientName: "chat-extension", clientVersion: "3.6.2", hostKind: "chatspace", hostBuild: "index-Kp3sV9qe",
      metric: "boardOpenMs", schemaVersion: 1, count: Math.min(17, 3 + Math.round(newBuildReports / 20)),
      mean: null, max: null, p50: null, p95: null, suppressed: true,
    });
  }
  const contract: ClientHealth["contract"] = [];
  for (const plan of VERSIONS) {
    const reports = reportsOf(plan);
    if (reports === 0) continue;
    const onNew = plan.version === "3.5.4" ? 0 : Math.round(newBuildReports * plan.share);
    contract.push({ clientVersion: plan.version, hostBuild: plan.build, reports: Math.max(0, reports - onNew), failedReports: 0, missing: [] });
    if (onNew > 0) {
      const failed = plan.version === "3.6.2" ? Math.round(onNew * 0.04) : Math.round(onNew * 0.31);
      contract.push({
        clientVersion: plan.version,
        hostBuild: "index-Kp3sV9qe",
        reports: onNew,
        failedReports: failed,
        missing: failed === 0 ? [] : plan.version === "3.6.2"
          ? [{ anchor: "composer.attach-menu", reports: failed }]
          : [{ anchor: "composer.attach-menu", reports: failed }, { anchor: "chat.header.badges", reports: Math.max(1, Math.round(failed / 3)) }],
      });
    }
  }
  if (days >= 7) contract.push({ clientVersion: "3.6.2", hostBuild: null, reports: 4, failedReports: 4, missing: [{ anchor: "host.build", reports: 4 }] });

  const scale = (perDay: number) => Math.round(perDay * dayWeight * between(random, 0.7, 1.3));
  const counters: ClientHealth["counters"] = [
    { code: "p1.insert-misplaced", total: 0 },
    { code: "p1.send-without-human", total: 0 },
    { code: "p1.read-without-human", total: 0 },
    // One error of the gravest class, a week ago: the tile and the row of «Ждут вас» show it.
    ...(days >= 7 ? [{ code: "p1.other", total: 1 }] : []),
    { code: "insert.prevented", total: scale(1.4) },
    { code: "send.held", total: scale(2.2) },
    { code: "send.uncertain", total: days >= 7 ? 1 : 0 },
    { code: "error.network", total: scale(6.5) },
    { code: "error.hub-5xx", total: scale(0.6) },
    { code: "error.dom-observer", total: scale(1.1) },
    { code: "perf.capped", total: scale(48) },
    { code: "perf.invalid", total: scale(0.4) },
  ];

  const footprint: ClientHealth["footprint"] = VERSIONS.filter((plan) => reportsOf(plan) > 0).map((plan) => {
    const few = reportsOf(plan) < minGroupSize;
    return {
      clientVersion: plan.version,
      cachesKBp95: few ? null : Math.round(between(random, 2100, 2900) * (plan.version === "3.5.4" ? 1.4 : 1)),
      logsKBp95: few ? null : Math.round(between(random, 310, 520)),
      domNodesP95: few ? null : Math.round(between(random, 880, 1150)),
    };
  });

  // Only the chat extension reports; another client's name has no rows.
  const other = clientName !== undefined && clientName !== "chat-extension";
  return {
    range: { from, to, timeZone: "Europe/Moscow" },
    minGroupSize,
    perf: other ? [] : perf,
    contract: other ? [] : contract,
    counters: other ? [] : counters,
    footprint: other ? [] : footprint,
    asOf: iso(new Date(request.now.getTime() - 40_000)),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
