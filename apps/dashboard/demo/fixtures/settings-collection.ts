import {
  OFAPI_COLLECTION_REGISTRY,
  OFAPI_READ_CATALOG,
  OFAPI_SCHEDULED_READ_COLLECTION_CATEGORIES,
  type OfapiCollectionCategory,
} from "@agency_hub_core/shared";
import { between, daysAgo, hoursAgo, intBetween, iso, queryNumber, queryString, rng, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_OFAPI_OFF_AT, DEMO_PAGES, demoUserByRole, type DemoPage } from "../world.ts";
import { ownerOnly, prefixFrom, uuidFrom } from "./settings-common.ts";

/**
 * OnlyFans collection through the vendor API. The agency stopped it on
 * 2026-11-01 (two days before "now" in the demo): the owner paused all
 * background collection, the vendor accounts were disconnected, and the
 * screen shows the settings, spend and runs as they stood at the pause.
 */

type Mode = "off" | "on_demand" | "scheduled";

interface Settings {
  mode: Mode;
  intervalMinutes: number;
  dailyCreditLimit: number;
  maxCallsPerRun: number;
  includeDetails: boolean;
}

/** The background collection was paused with the key's end. */
const PAUSED_AT = new Date(DEMO_OFAPI_OFF_AT);
function daysSincePause(now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - DEMO_OFAPI_OFF_AT) / 86_400_000));
}

const OF_PAGES = DEMO_PAGES.filter((page) => page.platform === "onlyfans").sort((a, b) => a.label.localeCompare(b.label));

const BASELINE: Settings = { mode: "scheduled", intervalMinutes: 1440, dailyCreditLimit: 200, maxCallsPerRun: 10, includeDetails: false };
const OFF: Settings = { mode: "off", intervalMinutes: 1440, dailyCreditLimit: 200, maxCallsPerRun: 10, includeDetails: false };

/** The agency-wide settings the owner applied, by category. Missing = never applied. */
const DEFAULTS: Partial<Record<OfapiCollectionCategory, Settings>> = {
  core_messages: { mode: "scheduled", intervalMinutes: 30, dailyCreditLimit: 900, maxCallsPerRun: 40, includeDetails: true },
  core_payments: { mode: "scheduled", intervalMinutes: 60, dailyCreditLimit: 300, maxCallsPerRun: 20, includeDetails: false },
  posts_comments: { mode: "scheduled", intervalMinutes: 360, dailyCreditLimit: 150, maxCallsPerRun: 20, includeDetails: false },
  visitors: { mode: "scheduled", intervalMinutes: 1440, dailyCreditLimit: 60, maxCallsPerRun: 30, includeDetails: false },
  tracking_links: { mode: "on_demand", intervalMinutes: 1440, dailyCreditLimit: 100, maxCallsPerRun: 20, includeDetails: false },
  vault_catalog: { mode: "on_demand", intervalMinutes: 1440, dailyCreditLimit: 80, maxCallsPerRun: 25, includeDetails: false },
  balances: { mode: "scheduled", intervalMinutes: 720, dailyCreditLimit: 30, maxCallsPerRun: 6, includeDetails: false },
  profile_notifications: { mode: "scheduled", intervalMinutes: 1440, dailyCreditLimit: 40, maxCallsPerRun: 12, includeDetails: false },
  content_history: { mode: "on_demand", intervalMinutes: 1440, dailyCreditLimit: 60, maxCallsPerRun: 20, includeDetails: false },
  media_previews: { mode: "on_demand", intervalMinutes: 1440, dailyCreditLimit: 120, maxCallsPerRun: 10, includeDetails: false },
  account_settings: { mode: "scheduled", intervalMinutes: 1440, dailyCreditLimit: 10, maxCallsPerRun: 2, includeDetails: false },
  smart_links: { mode: "off", intervalMinutes: 1440, dailyCreditLimit: 50, maxCallsPerRun: 10, includeDetails: false },
};

/** Page overrides: the big page's paid fan sweep under tracking links. */
const OVERRIDES: Record<string, Partial<Record<OfapiCollectionCategory, Settings>>> = {
  "mia-of": {
    tracking_links: { mode: "scheduled", intervalMinutes: 1440, dailyCreditLimit: 250, maxCallsPerRun: 50, includeDetails: false },
  },
};

const BASELINE_CATEGORIES = new Set(OFAPI_COLLECTION_REGISTRY.filter((row) => row.baseline).map((row) => row.id));

function hasScheduledReads(category: OfapiCollectionCategory) {
  return category === "visitors" || OFAPI_READ_CATALOG.some((row) => row.category === category && row.defaultCollect);
}

function noScheduledReads(category: OfapiCollectionCategory) {
  return OFAPI_SCHEDULED_READ_COLLECTION_CATEGORIES.includes(category) && !BASELINE_CATEGORIES.has(category) && !hasScheduledReads(category);
}

/** Categories whose scheduled runs are jobs on this screen. */
function runsOnSchedule(category: OfapiCollectionCategory, settings: Settings) {
  return settings.mode === "scheduled" && OFAPI_SCHEDULED_READ_COLLECTION_CATEGORIES.includes(category)
    && !BASELINE_CATEGORIES.has(category) && hasScheduledReads(category);
}

function effective(page: DemoPage, category: OfapiCollectionCategory) {
  const override = OVERRIDES[page.label]?.[category];
  if (override) return { settings: override, source: "page" as const, state: "applied" as const };
  const fallback = DEFAULTS[category];
  if (fallback) return { settings: fallback, source: "default" as const, state: "applied" as const };
  const baseline = BASELINE_CATEGORIES.has(category) ? BASELINE : OFF;
  return { settings: baseline, source: baseline.mode === "off" ? "default_off" as const : "legacy_baseline" as const, state: "baseline" as const };
}

// --- Runs and one-off jobs ---

interface Job {
  id: string;
  pageId: number;
  category: OfapiCollectionCategory;
  state: string;
  purpose: "background" | "one_off";
  maxCredits: number;
  maxCalls: number;
  maxBytes: number;
  usedCredits: number;
  usedCalls: number;
  usedBytes: number;
  createdAt: Date;
  updatedAt: Date;
  reason: string | null;
  stepsDone: number | null;
  stepsTotal: number | null;
}

const MB = 1024 * 1024;

/** Steps a scheduled pass of the category walks. */
const PLAN_STEPS: Partial<Record<OfapiCollectionCategory, number>> = {
  posts_comments: 7, visitors: 3, tracking_links: 12, balances: 4, profile_notifications: 5, account_settings: 1,
};

function buildJobs(now: Date): Job[] {
  const pausedAt = PAUSED_AT.getTime();
  const jobs: Job[] = [];
  for (const page of OF_PAGES) {
    const size = page.label === "mia-of" ? 1 : 0.55;
    for (const row of OFAPI_COLLECTION_REGISTRY) {
      const { settings } = effective(page, row.id);
      if (!runsOnSchedule(row.id, settings) && !(row.id === "tracking_links" && settings.mode === "scheduled")) continue;
      const step = settings.intervalMinutes * 60_000;
      const steps = PLAN_STEPS[row.id] ?? 3;
      // 30 days of passes up to the pause.
      for (let at = pausedAt - 30 * 24 * 60 * 60_000; at <= pausedAt; at += step) {
        const random = rng(`run:${page.label}:${row.id}:${at}`);
        const createdAt = new Date(at - intBetween(random, 2, 11) * 60_000);
        // The pause caught two passes mid-way; every other last pass had finished.
        const atPause = at + step > pausedAt && (
          (row.id === "posts_comments" && page.label === "mia-of") || (row.id === "balances" && page.label === "mia-vip-of"));
        const callsNeeded = Math.max(1, Math.round(steps * size * between(random, 1.2, 2.6)));
        const maxCalls = settings.maxCallsPerRun;
        const maxCredits = Math.max(1, Math.round(settings.dailyCreditLimit / Math.max(1, Math.round(1440 / settings.intervalMinutes))));
        // The visitors pass of the big page outgrew its call ceiling for a few days in October.
        const outgrew = row.id === "visitors" && page.label === "mia-of" && at > pausedAt - 9 * 86_400_000 && at < pausedAt - 5 * 86_400_000;
        const usedCalls = outgrew ? maxCalls : Math.min(maxCalls, callsNeeded);
        const usedCredits = Math.min(maxCredits, usedCalls * (row.id === "tracking_links" ? 2 : 1));
        const state = atPause ? "paused" : outgrew ? "failed" : random() < 0.015 ? "failed" : "completed";
        const reason = atPause
          ? "background_paused"
          : outgrew
            ? "scheduled_run_exhausted:job_limit"
            : state === "failed" ? "vendor_timeout" : null;
        const stepsDone = state === "completed" ? steps : atPause ? Math.max(1, Math.floor(steps / 2)) : Math.max(1, steps - 1);
        jobs.push({
          id: uuidFrom(`job:${page.label}:${row.id}:${at}`),
          pageId: page.id,
          category: row.id,
          state,
          purpose: "background",
          maxCredits,
          maxCalls,
          maxBytes: 50 * MB,
          usedCredits: atPause ? Math.round(usedCredits / 2) : usedCredits,
          usedCalls: atPause ? Math.round(usedCalls / 2) : usedCalls,
          usedBytes: Math.round(usedCalls * between(random, 18, 64) * 1024),
          createdAt,
          updatedAt: new Date(createdAt.getTime() + intBetween(random, 1, 14) * 60_000),
          reason,
          stepsDone,
          stepsTotal: steps,
        });
      }
    }
  }
  // One-off reads the owner started by hand.
  const oneOff = (label: string, category: OfapiCollectionCategory, days: number, used: number, max: number, state = "completed", reason: string | null = null) => {
    const page = OF_PAGES.find((item) => item.label === label)!;
    const random = rng(`oneoff:${label}:${category}:${days}`);
    const createdAt = daysAgo(now, days, 11);
    jobs.push({
      id: uuidFrom(`oneoff:${label}:${category}:${days}`),
      pageId: page.id,
      category,
      state,
      purpose: "one_off",
      maxCredits: max,
      maxCalls: max,
      maxBytes: 100 * MB,
      usedCredits: used,
      usedCalls: used,
      usedBytes: Math.round(used * between(random, 30, 90) * 1024),
      createdAt,
      updatedAt: hoursAgo(createdAt, -0.4),
      reason,
      stepsDone: state === "completed" ? 1 : 0,
      stepsTotal: 1,
    });
  };
  oneOff("mia-of", "vault_catalog", 3, 38, 50);
  oneOff("mia-vip-of", "vault_catalog", 3, 21, 50);
  oneOff("mia-of", "content_history", 6, 44, 50);
  oneOff("mia-vip-of", "tracking_links", 9, 12, 30);
  oneOff("mia-of", "posts_comments", 14, 50, 50, "failed", "job_limit");
  oneOff("mia-vip-of", "content_history", 22, 17, 50);
  return jobs;
}

/** Newest first, with what the owner must look at (paused) on top. */
function orderJobs(jobs: Job[]) {
  return [...jobs].sort((a, b) => Number(b.state === "paused") - Number(a.state === "paused") || b.createdAt.getTime() - a.createdAt.getTime());
}

function exhaustedCap(job: Job): "calls" | "credits" | "bytes" | null {
  if (!job.reason?.endsWith("job_limit")) return null;
  const spent = [
    job.usedCalls >= job.maxCalls ? "calls" as const : null,
    job.usedCredits >= job.maxCredits ? "credits" as const : null,
    job.usedBytes >= job.maxBytes ? "bytes" as const : null,
  ].filter((value) => value !== null);
  return spent.length === 1 ? spent[0]! : null;
}

function runSummary(job: Job) {
  const prefix = "scheduled_run_exhausted:";
  return {
    id: job.id,
    state: job.state,
    reason: job.reason,
    exhaustedLimit: job.reason?.startsWith(prefix) ? job.reason.slice(prefix.length) : null,
    exhaustedCap: exhaustedCap(job),
    usedCalls: job.usedCalls,
    maxCalls: job.maxCalls,
    usedCredits: job.usedCredits,
    maxCredits: job.maxCredits,
    usedBytes: job.usedBytes,
    maxBytes: job.maxBytes,
    stepsDone: job.stepsDone,
    stepsTotal: job.stepsTotal,
    createdAt: iso(job.createdAt),
    updatedAt: iso(job.updatedAt),
  };
}

/** Requests that are not jobs: the baseline sync of messages, payments and fans. */
const BASELINE_CREDITS_PER_DAY: Partial<Record<OfapiCollectionCategory, number>> = {
  core_messages: 310, core_payments: 64, core_audience: 38, media_previews: 9,
};

function policies(pages: DemoPage[], jobs: Job[], now: Date, revision: number) {
  const pausedAt = PAUSED_AT;
  const since30d = now.getTime() - 30 * 86_400_000;
  return pages.flatMap((page) => OFAPI_COLLECTION_REGISTRY.map((row) => {
    const { settings, source, state } = effective(page, row.id);
    const own = jobs.filter((job) => job.pageId === page.id && job.category === row.id);
    const background = own.filter((job) => job.purpose === "background");
    const completed = background.filter((job) => job.state === "completed");
    const lastCompleted = completed.reduce<Job | null>((best, job) => (!best || job.updatedAt > best.updatedAt ? job : best), null);
    const lastRun = background.reduce<Job | null>((best, job) => (!best || job.createdAt > best.createdAt ? job : best), null);
    const size = page.label === "mia-of" ? 1 : 0.5;
    const daysCollected = Math.max(0, 30 - daysSincePause(now));
    const jobCredits = own.filter((job) => job.createdAt.getTime() > since30d).reduce((sum, job) => sum + job.usedCredits, 0);
    const baselineCredits = Math.round((BASELINE_CREDITS_PER_DAY[row.id] ?? 0) * size * daysCollected);
    const collected = jobCredits + baselineCredits > 0;
    return {
      pageId: page.id,
      category: row.id,
      ...settings,
      revision,
      source,
      state,
      backgroundPaused: true,
      usage: { callsToday: 0, reservedCreditsToday: 0, credits30d: jobCredits + baselineCredits, actualCreditsToday: null },
      lastCapturedAt: collected
        ? iso(row.baseline || row.id === "media_previews" ? hoursAgo(pausedAt, row.id === "media_previews" ? 7 : 0.3) : (lastCompleted?.updatedAt ?? own[0]?.updatedAt ?? pausedAt))
        : null,
      inFlight: 0,
      // The pause takes every category out of the schedule's promise: nothing is expected, nothing is stale.
      scheduleHealth: {
        expected: false,
        stale: false,
        staleAt: null,
        lastCompletedAt: lastCompleted ? iso(lastCompleted.updatedAt) : null,
        lastRun: lastRun ? runSummary(lastRun) : null,
      },
    };
  }));
}

// --- The settings journal ---

function audit(now: Date, owner: number) {
  const page = (label: string) => OF_PAGES.find((item) => item.label === label)!.id;
  const change = (pageId: number | null, category: OfapiCollectionCategory, settings: Settings) => ({ pageId, category, ...settings });
  const rows: { revision: number; days: number; hour: number; changes: unknown }[] = [
    { revision: 14, days: daysSincePause(now), hour: 10, changes: { changes: [], backgroundPaused: true } },
    { revision: 13, days: 9, hour: 14, changes: { changes: [change(page("mia-of"), "tracking_links", OVERRIDES["mia-of"]!.tracking_links!)] } },
    { revision: 12, days: 12, hour: 10, changes: { changes: [change(null, "visitors", DEFAULTS.visitors!)] } },
    { revision: 11, days: 15, hour: 16, changes: { changes: [change(null, "balances", DEFAULTS.balances!)] } },
    { revision: 10, days: 15, hour: 15, changes: { changes: [change(null, "smart_links", DEFAULTS.smart_links!), change(null, "content_history", DEFAULTS.content_history!)] } },
    { revision: 9, days: 21, hour: 12, changes: { changes: [change(null, "posts_comments", DEFAULTS.posts_comments!)] } },
    { revision: 8, days: 24, hour: 18, changes: { changes: [], backgroundPaused: false } },
    { revision: 7, days: 24, hour: 11, changes: { changes: [], backgroundPaused: true } },
    { revision: 6, days: 33, hour: 13, changes: { changes: [change(null, "core_messages", DEFAULTS.core_messages!), change(null, "core_payments", DEFAULTS.core_payments!)] } },
    { revision: 5, days: 33, hour: 12, changes: { changes: [change(null, "profile_notifications", DEFAULTS.profile_notifications!), change(null, "account_settings", DEFAULTS.account_settings!)] } },
    { revision: 4, days: 40, hour: 17, changes: { changes: [change(null, "vault_catalog", DEFAULTS.vault_catalog!), change(null, "media_previews", DEFAULTS.media_previews!)] } },
    { revision: 3, days: 40, hour: 16, changes: { changes: [change(null, "tracking_links", DEFAULTS.tracking_links!)] } },
  ];
  return rows.map((row) => ({ revision: row.revision, actorUserId: owner, createdAt: iso(daysAgo(now, row.days, row.hour)), changes: row.changes }));
}

const REVISION = 14;

function allowedPages(request: DemoRequest): DemoPage[] {
  if (request.role === "owner") return OF_PAGES;
  const user = demoUserByRole(request.role);
  return OF_PAGES.filter((page) => user.pages.includes(page.label));
}

const UNBOUNDED = new Set(["unfinished", "queued", "running", "paused"]);

// --- The webhook ---

const WEBHOOK_EVENTS = [
  "messages.received", "messages.sent", "messages.ppv.unlocked", "messages.deleted",
  "transactions.new",
  "subscriptions.new", "subscriptions.renewed", "subscriptions.expired",
  "users.online", "users.offline", "users.typing",
  "posts.liked", "posts.tips",
  "accounts.connected", "accounts.disconnected", "accounts.reconnected", "accounts.session_expired",
  "accounts.authentication_failed", "accounts.otp_code_required",
];

export const collectionHandlers: DemoHandlers = {
  ofapiCollectionGet: (request) => {
    const owner = demoUserByRole("owner").id;
    const scoped = allowedPages(request);
    const pageId = queryNumber(request, "pageId", 0);
    const pages = pageId > 0 ? scoped.filter((page) => page.id === pageId) : scoped;
    const all = buildJobs(request.now);
    const ids = new Set(pages.map((page) => page.id));
    const jobState = queryString(request, "jobState");
    const matching = orderJobs(all.filter((job) => ids.has(job.pageId) && (
      jobState === undefined ? true
        : jobState === "unfinished" ? ["queued", "running", "paused"].includes(job.state)
          : job.state === jobState
    )));
    const listed = jobState !== undefined && UNBOUNDED.has(jobState) ? matching : matching.slice(0, 100);
    return {
      revision: REVISION,
      backgroundPaused: true,
      catalog: OFAPI_COLLECTION_REGISTRY.map((row) => ({
        ...row,
        modes: [...row.modes],
        consumers: [...row.consumers],
        prerequisites: [...row.prerequisites],
        legacyOperations: [...row.legacyOperations],
        noScheduledReads: noScheduledReads(row.id),
      })),
      pages: pages.map((page) => ({ id: page.id, label: page.label, accountId: `acct_${prefixFrom(`ofapi:${page.label}`, 10).toLowerCase()}` })),
      policies: policies(pages, all, request.now, REVISION),
      jobs: listed.map((job) => ({
        id: job.id,
        pageId: job.pageId,
        category: job.category,
        state: job.state,
        maxCredits: job.maxCredits,
        maxCalls: job.maxCalls,
        maxBytes: job.maxBytes,
        usedCredits: job.usedCredits,
        usedCalls: job.usedCalls,
        usedBytes: job.usedBytes,
        createdAt: iso(job.createdAt),
        reason: job.reason,
        // Only the owner may close an interrupted scheduled read.
        canFinishIncomplete: request.role === "owner" && job.purpose === "background" && job.state === "paused",
        exhaustedCap: exhaustedCap(job),
        stepsDone: job.stepsDone,
        stepsTotal: job.stepsTotal,
      })),
      jobsTotal: matching.length,
      audit: request.role === "owner" ? audit(request.now, owner) : [],
      limitDescription: "Limits apply to new managed physical requests. Vendor events, external clients, accepted operations and variable prices can charge separately. Legacy operations retain existing configuration until a category policy is applied.",
    };
  },

  adminOfapiWebhookStatus: (request) => {
    const refused = ownerOnly(request);
    if (refused) return refused;
    const pausedAt = PAUSED_AT;
    const lastEvent = hoursAgo(pausedAt, 0.02);
    return {
      configured: true,
      registrationState: "stable" as const,
      registrationError: null,
      pendingRegistration: null,
      endpointUrl: "https://hub.demo.invalid/api/v1/ofapi/webhook",
      externalWebhookId: `wh_${prefixFrom("ofapi:webhook", 16).toLowerCase()}`,
      accountScope: "global",
      events: WEBHOOK_EVENTS,
      signingSecretMask: "whsec_••••••••3f9a",
      updatedAt: iso(hoursAgo(request.now, 0.5)),
      pages: OF_PAGES.map((page, index) => ({
        bindingGeneration: index === 0 ? 3 : 2,
        pageId: page.id,
        label: page.label,
        username: page.username,
        ofapiAccountId: `acct_${prefixFrom(`ofapi:${page.label}`, 10).toLowerCase()}`,
        // The vendor sessions were disconnected when the agency stopped collection.
        ofapiAuthStatus: "accounts.disconnected",
        ofapiAuthChangedAt: iso(hoursAgo(pausedAt, -0.5 - index * 0.1)),
        lastEventAt: iso(hoursAgo(lastEvent, index * 0.4)),
        lastEventAgeSeconds: Math.round((request.now.getTime() - hoursAgo(lastEvent, index * 0.4).getTime()) / 1000),
      })),
      credit: { lastBalance: 3120, lastBalanceAt: iso(hoursAgo(pausedAt, 0.2)), spentToday: 0 },
    };
  },
};
