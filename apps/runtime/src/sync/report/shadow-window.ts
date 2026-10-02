import {
  countLegacyFanslyAttempts,
  countSyncAttemptsByKey,
  listSyncAdmissions,
  listSyncRunAttempts,
  listSyncWorkOpenAt,
  readFirstShadowAdmissions,
  readLedgerTransactionsCreatedAt,
  readLegacyMessageArrivals,
  readSyncJournalMetrics,
  readSyncPollPlacements,
  type Database,
  type FanslyWsLivePayloadResolver,
  type SyncPageRow,
  type SyncRunAttempt,
} from "@agency_hub_core/db";

import { quantileOf } from "../engine/metrics.ts";
import {
  effectiveCadence,
  effectivePeriodMs,
  POLL_JITTER,
  resourceDisabled,
  runsIn,
  type CoalesceSpec,
  type DemandSignal,
} from "../engine/resource.ts";
import { FANSLY_RESOURCE_SPECS, type LegacyRef, type ResourceSpec } from "../fansly/registry.ts";
import { decodedReceiptsInWindow } from "../fansly/ws/money-frames.ts";
import { routeReceiptsOffline } from "../fansly/ws/route-receipt.ts";
import { FANSLY_PAYOUT_TRANSACTION_TYPE, FANSLY_TRANSACTION_STATUS_NEW } from "../fansly/ws/router.ts";
import type { WsItem } from "../fansly/ws/decode.ts";

// The shadow report, part A (design §3.12): the live one-hour window of all
// pages in shadow. A1 demand against a computed expectation, A2 the legacy
// engine's volume of the same hour explained through the registry's coverage
// matrix, A3 the live-path decisions (socket frame → shadow admission vs the
// legacy arrival), A4 the pacer's self-check. Reads only. Where the design's
// wording needed a rule to be measurable, the rule is named
// (`SHADOW_WINDOW_RULES`) and printed with every report.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Plan §13: the steady-state band of one page's requests per hour — an
 *  average rate (the same row reads 1–2.5 thousand per day). Its upper edge
 *  is the ceiling (rule A1.ceiling); below its lower edge a page passes only
 *  under rule A1.floor. */
export const STEADY_STATE_BAND_PER_HOUR = { min: 40, max: 100 } as const;
/** One run of a poll: its steps follow each other (a walk's next step is due
 *  at once), so a gap longer than this after a step's completion starts a new
 *  run. Below (1 − jitter) × the shortest poll period (5 min), pinned by test. */
export const POLL_RUN_GAP_MS = 120_000;
/** A run still stepping in the window ran away (rules A1.poll-schedule,
 *  A1.rate) past `factor` × the key's largest earlier run + `slackSteps`
 *  requests (a head check that found a few more pages is no runaway). */
export const RUNAWAY_RUN = { factor: 2, slackSteps: 10 } as const;
/** A due poll waits for its planned slot (the pacer, the planned round robin). */
export const POLL_DUE_SLACK_MS = 120_000;
/** Clock tolerance of the early-run check. */
const EARLY_TOLERANCE_MS = 1_000;
/** The legacy volume of a stream is compared over the legacy week (A2.rate). */
const LEGACY_WEEK_MS = 7 * DAY_MS;
/** A resource outside this ratio of its expectation is listed with its reason. */
export const EXPECTATION_RATIO_BAND = { min: 0.5, max: 2 } as const;
/** A3 targets: shadow admission after the frame, p95. */
export const LIVE_PATH_TARGET_P95_MS = { messages: 30_000, transactions: 15_000 } as const;
/** A3: fewer frames than this over all pages ⇒ the offline decision replay. */
export const LIVE_PATH_MIN_SAMPLE = { messages: 50, transactions: 5 } as const;
/** The offline decision replay reads the receipts of this long before the window. */
export const OFFLINE_DECISIONS_LOOKBACK_MS = 24 * HOUR_MS;
/** The window starts once every page has been in shadow this long (design
 *  §3.12: polls placed, backlog walks started). */
export const SHADOW_SETTLE_MS = 10 * 60_000;
/** A page's first shadow admission is looked for from this long before the window. */
export const SHADOW_START_LOOKBACK_MS = 24 * HOUR_MS;
/** A frame's shadow admission is looked for up to this long after the window. */
const ADMISSION_SEARCH_MS = 15 * 60_000;
/** One-time backlogs of a first shadow run (design §3.12 A1): the media-stats
 *  first pass of never-visited items and the vault crawl. */
const ONE_TIME_BACKLOG_KEYS: ReadonlySet<string> = new Set(["media-stats.walk", "catalog.vault"]);
/** Triggers of one-time work: a walk only these start is a backfill, not
 *  steady-state demand. */
const ONE_TIME_TRIGGERS: ReadonlySet<string> = new Set(["owner", "new_page", "legacy_import", "dependency"]);
/** Why the legacy volume of a stream or sender differs from the engine's (design §3.12 A2). */
const LEGACY_VOLUME_NOTES: Readonly<Record<string, string>> = {
  "stream:followers": "followers.head reuses pages.follower_count; the full reconcile is daily (the owner's floor)",
  "stream:followers_reconcile": "the reconcile walk runs at most daily (the owner's floor)",
  "stream:dm_conversations": "the full list sweep is daily instead of 6-hourly; the socket and .head every 30 min cover discovery (A14)",
  "stream:dm_messages": "only chats with demand are read (socket, list follow-ups); no B1 5 % cap, no history walk without a request",
  "stream:media_stats": "owner decision №6 tiers (30 / 90 days / monthly)",
  "stream:catalog": "owner decision №6: the vault walk is a daily incremental and a weekly full sweep",
  "stream:transactions": "the head is read on socket money news; the insurance poll every 5 min, the rescan hourly",
  "stream:notifications": "one forward poll every 30 min",
  "sender:ws_hint": "a socket hint is dm-messages.head demand, coalesced per chat",
  "sender:ai_accelerator": "readers' fast lanes read the chat head the engine keeps fresh; no request of their own",
  "sender:ai_fast_lane": "readers' fast lanes read the chat head the engine keeps fresh; no request of their own",
  "sender:targeted_backfill": "history is read only for history requests (none in shadow)",
};
/**
 * Legacy streams whose volume changed within the legacy week (measured on the
 * production journal): their rate is taken from the change on (rule
 * A2.legacy-regime), so the shadow meets today's legacy, not a week that holds
 * another regime. Each entry expires by itself 7 days after its date.
 */
export const LEGACY_REGIME_SINCE: Readonly<Record<string, { since: Date; why: string }>> = {
  "stream:top_spenders": {
    since: new Date("2026-10-01T00:00:00Z"),
    why: "144–148 a day (hourly) until #331 (2026-09-30 ~13:00 UTC), 24 a day (every 6 h) since",
  },
  "stream:followers_reconcile": {
    since: new Date("2026-10-01T00:00:00Z"),
    why: "1 432–4 945 a day until #330 (2026-09-30), about 500 a day since (one walk a day per page, the owner's floor)",
  },
  "stream:fan_earnings": {
    since: new Date("2026-09-30T00:00:00Z"),
    why: "legacy's one-time lifetime re-walk after #282 (2026-09-25 … 09-29, 680–4 147 a day), 52–91 a day since",
  },
  "stream:post_replies": {
    since: new Date("2026-10-01T00:00:00Z"),
    why: "264–304 a day (a backlog drained at the 100-a-day cap per page) until 2026-09-30, 5–10 a day since",
  },
};

/** An acceptance rule of part A as the report applies it (owner-visible). */
export interface AcceptanceRule {
  id: string;
  text: string;
}

/**
 * The rules part A applies where design §3.12's wording needed a rule to be
 * measurable; printed with every report (and listed as deviations of the
 * design in the PR that made them).
 */
export const SHADOW_WINDOW_RULES: readonly AcceptanceRule[] = [
  {
    id: "A1.rate",
    text: "A key that runs on a fixed period longer than the window — a poll, or a walk with a minimum interval "
      + "(followers.reconcile) — counts in the steady state as its run size × window / period, the rate the plan's "
      + "estimate is (plan §13: 40–100 an hour is the same row as 1–2.5 thousand a day). The run size is its newest "
      + "regular shadow run that finished before the window end, within 1.1 × the period + 1 h. Counted besides: the "
      + "window's attempts of a run that came early (a demand bump, an owner's walk within the interval), and those of "
      + "any other run beyond its first run-size requests (a run that never finishes or grows past the sizing run "
      + "counts as it steps). A walk still stepping inside the window with more than 2 × its largest earlier walk + 10 "
      + "requests is a runaway and fails A1 on any page. Without a sizing run the steady state is unknown and A1 fails "
      + "until the key has run.",
  },
  {
    id: "A1.ceiling",
    text: "The steady state (urgent + planned, the one-time backlog walks apart) is at most 100 an hour per page "
      + "(plan §13; unchanged).",
  },
  {
    id: "A1.floor",
    text: "Below 40 an hour a page passes only when every resource of the page with a computed expectation is at it "
      + "(no row outside, every poll on schedule) and every legacy stream or sender with traffic on the page (on its "
      + "A2 basis) has a shadow counterpart on that page: a registry key that runs in shadow there and has shadow "
      + "attempts on the page within its shadow history (from its first shadow admission, at most 7 days); other "
      + "pages' volume never counts. A page whose shadow history is still shorter than the stream's shortest key "
      + "recurrence + 2 min, without an attempt yet, is not yet judgeable and fails the exception like an unknown rate. "
      + "A stream only demand drives (the socket, an apply, an owner's or the API's request; no key recurs by itself) "
      + "needs no volume on the page: the page's own demand rows hold the reads its frames imply against the shadow's, "
      + "so it is listed. Counterparts that never run in shadow by design — live-only keys, history requests — are "
      + "listed, not required.",
  },
  {
    id: "A1.floor-scheduled",
    text: "A legacy stream that would be not yet judgeable on a page (no shadow attempt there yet, the page's shadow "
      + "history shorter than the stream's shortest key recurrence + 2 min) is scheduled instead and does not fail the "
      + "floor's exception when every key of the stream that recurs by itself has a shadow work row on the page, open at "
      + "the window end, on its schedule: due after the window end (a due row waits up to 2 min for its slot) and no later "
      + "than the row's placement + the key's recurrence + 2 min; a row whose first read came after the window end counts "
      + "when that read was admitted by the same bound. A key without such a row, a row due and not admitted by the window "
      + "end, a quarantined row, or a row due later than its bound leaves the stream not yet judgeable (and lacking once "
      + "the history passes the recurrence). Why: a one-hour window cannot observe a daily key's first run; the engine's "
      + "schedule, with rule A1.poll-schedule failing a late poll, keeps the no-missing-coverage check without waiting a day "
      + "(owner decision, 2026-10-02).",
  },
  {
    id: "A1.poll-schedule",
    text: "Polls are judged in runs, not requests (a snapshot sequence or a cursor walk is one run of many requests; "
      + "a single-request poll's run is its one request): a run starts 0.9–1.1 × the period after the previous run's "
      + "completion (+ 2 min admission), earlier only on a demand bump (a new demand_revision); the first run within one "
      + "period (+ 2 min) of the poll row's placement; no poll overdue at the window end. Every run that steps inside "
      + "the window is judged, the one that began before it included; such a run with more than 2 × the key's largest "
      + "earlier run + 10 requests, or still stepping longer after it began than the period (at most the window), is a "
      + "runaway. A poll off this schedule or with a runaway run fails A1 on any page. Demand runs are held against "
      + "the reads the window's socket frames imply: 0.5–2× where only the socket bumps the poll; where an apply or a "
      + "dependency bumps it too, at least 0.5× those reads and at most the period's runs + 2× those reads; a row "
      + "outside is listed (rule A1.floor).",
  },
  {
    id: "A2.rate",
    text: "A legacy stream or sender whose every registry key that runs in shadow recurs less often than the window "
      + "(a poll period, a walk's minimum interval, re-check or cadence) is compared as attempts per window: legacy "
      + "over its last 7 days, the shadow over each page's own shadow history (from its first shadow admission, at "
      + "most 7 days); both sides count physical attempts.",
  },
  {
    id: "A2.legacy-regime",
    text: `Where the legacy engine changed a stream's volume within its week, the legacy rate starts at the change: ${
      Object.entries(LEGACY_REGIME_SINCE).map(([ref, regime]) => `${ref} from ${regime.since.toISOString().slice(0, 10)} (${regime.why})`).join("; ")}.`,
  },
  {
    id: "A2.live-only",
    text: "A sender whose every registry key is live-only (the socket connect, the CDN download, the identity check) "
      + "is listed with its legacy volume and compared after the switch: it never runs in shadow (design §3.12).",
  },
];

type Quantiles = { p50: number; p95: number } | null;

function quantiles(values: readonly number[]): Quantiles {
  const p50 = quantileOf(values, 0.5);
  const p95 = quantileOf(values, 0.95);
  return p50 === null || p95 === null ? null : { p50, p95 };
}

/**
 * A walk outside the steady state (design §3.12 A1): a first-pass backlog, or
 * a backfill only one-time events start. Every other walk recurs (polls,
 * projection queues, applies, the socket) and counts in the steady state — at
 * its rate where it runs on a minimum interval (rule A1.rate).
 */
export function isOneTimeWalk(spec: Pick<ResourceSpec, "key" | "triggers">): boolean {
  return ONE_TIME_BACKLOG_KEYS.has(spec.key) || spec.triggers.every((trigger) => ONE_TIME_TRIGGERS.has(trigger));
}

function refKey(ref: LegacyRef): string {
  return "stream" in ref ? `stream:${ref.stream}` : `sender:${ref.sender}`;
}

// ── runs of a key (pure) ─────────────────────────────────────────────────────

/** One run of a key: a poll's read (one request, or a snapshot sequence or a
 *  cursor walk of many), or one walk of a walk key. */
export interface KeyRun {
  startMs: number;
  /** The last step's completion. */
  doneMs: number;
  lastSentMs: number;
  /** Send times of its steps. */
  sentMs: number[];
  demandRevision: number | null;
  workId: number | null;
  /** When its work row closed (a walk's row closes with the walk). */
  workClosedMs: number | null;
}

export type RunAttempt = Pick<SyncRunAttempt, "workId" | "demandRevision"> & { sentMs: number; doneMs: number; workClosedMs: number | null };

/** How a key's attempts group into runs: a poll's by the run gap, a
 *  single-request poll's (`walk: "single"`) one attempt each, a walk's by its
 *  work row. */
export type RunGrouping = "poll" | "single" | "walk";

export function runGroupingOf(spec: Pick<ResourceSpec, "kind" | "walk">): RunGrouping {
  if (spec.kind !== "poll") return "walk";
  return spec.walk === "single" ? "single" : "poll";
}

/**
 * A key's attempts (one subject, send order) as runs. A poll's run is its
 * consecutive steps: a new run starts after a gap longer than
 * `POLL_RUN_GAP_MS` or at a new demand revision (a bump is a read of its own).
 * A single-request poll's run is its one attempt: a re-run seconds later is a
 * run of its own, never merged. A walk's run is its work row (a walk closes
 * its row; the next walk is a new one); attempts without a row fall back to
 * the gap rule.
 */
export function runsOf(attempts: readonly RunAttempt[], by: RunGrouping): KeyRun[] {
  const runs: KeyRun[] = [];
  let current: KeyRun | null = null;
  for (const attempt of [...attempts].sort((a, b) => a.sentMs - b.sentMs)) {
    const gap = current === null ? Number.POSITIVE_INFINITY : attempt.sentMs - current.doneMs;
    const fresh = current === null
      || by === "single"
      || (by === "walk" && (attempt.workId !== current.workId || (attempt.workId === null && gap > POLL_RUN_GAP_MS)))
      || (by === "poll" && (gap > POLL_RUN_GAP_MS || attempt.demandRevision !== current.demandRevision));
    if (fresh) {
      current = {
        startMs: attempt.sentMs,
        doneMs: attempt.doneMs,
        lastSentMs: attempt.sentMs,
        sentMs: [attempt.sentMs],
        demandRevision: attempt.demandRevision,
        workId: attempt.workId,
        workClosedMs: attempt.workClosedMs,
      };
      runs.push(current);
      continue;
    }
    current!.doneMs = Math.max(current!.doneMs, attempt.doneMs);
    current!.lastSentMs = attempt.sentMs;
    current!.sentMs.push(attempt.sentMs);
  }
  return runs;
}

/** How a poll kept its schedule through the window (rule A1.poll-schedule). */
export interface PollSchedule {
  periodMs: number;
  /** Runs that started in the window, and the requests of each. */
  runs: number;
  attemptsPerRun: number[];
  /** Runs at a new demand revision (a bump, not the period). */
  demandRuns: number;
  /** Runs a window of this length holds at the period's jitter (display). */
  expectedRuns: { min: number; max: number };
  /** Before the window: the previous run's completion, else the row's placement. */
  previous: { doneAt: Date } | { placedAt: Date } | null;
  /** A run sooner than 0.9 × period after the previous one, at the same demand revision. */
  early: Array<{ at: Date; afterMs: number }>;
  /** A run later than 1.1 × period (+ admission) after the previous one, or than one period after placement. */
  late: Array<{ at: Date; afterMs: number }>;
  /** No run by the window end although one was due. */
  overdue: { dueBy: Date } | null;
  /** Runs still stepping in the window that ran away (`runawayRuns`). */
  runaway: RunawayRun[];
}

/** A run still stepping inside the window past its bound (rules
 *  A1.poll-schedule, A1.rate). */
export interface RunawayRun {
  at: Date;
  attempts: number;
  spanMs: number;
  /** `size`: more requests than `RUNAWAY_RUN` × the largest earlier run;
   *  `span`: still stepping longer after it began than `limitMs`. */
  bound: "size" | "span";
  limit: number;
}

function stepsInWindow(run: KeyRun, window: { startMs: number; endMs: number }): boolean {
  return run.startMs < window.endMs && run.lastSentMs >= window.startMs;
}

function attemptsInWindow(sentMs: readonly number[], window: { startMs: number; endMs: number }): number {
  return sentMs.filter((ms) => ms >= window.startMs && ms < window.endMs).length;
}

/**
 * The runs of a key that are still stepping inside the window and ran away:
 * more requests than `RUNAWAY_RUN.factor` × the key's largest earlier run +
 * `RUNAWAY_RUN.slackSteps`, or (`spanLimitMs`, a poll: its period, at most
 * the window) still stepping longer than that after the run began — a round
 * of a poll ends before the next one is due, and a re-admission loop faster
 * than the run gap is one long run. A run that began before the window counts
 * when it still steps inside it. Without an earlier run only the span bounds.
 */
export function runawayRuns(input: {
  runs: readonly KeyRun[];
  window: { startMs: number; endMs: number };
  spanLimitMs: number | null;
}): RunawayRun[] {
  const runaway: RunawayRun[] = [];
  let largest: number | null = null;
  for (const run of input.runs) {
    if (stepsInWindow(run, input.window)) {
      const attempts = run.sentMs.length;
      const spanMs = run.lastSentMs - run.startMs;
      const sizeLimit = largest === null ? null : RUNAWAY_RUN.factor * largest + RUNAWAY_RUN.slackSteps;
      if (sizeLimit !== null && attempts > sizeLimit) {
        runaway.push({ at: new Date(run.startMs), attempts, spanMs, bound: "size", limit: sizeLimit });
      } else if (input.spanLimitMs !== null && spanMs > input.spanLimitMs) {
        runaway.push({ at: new Date(run.startMs), attempts, spanMs, bound: "span", limit: input.spanLimitMs });
      }
    }
    largest = Math.max(largest ?? 0, run.sentMs.length);
  }
  return runaway;
}

/**
 * Judge a poll's runs over the window: each run that steps inside it — the
 * window's own runs and the anchor (the newest run that began before it)
 * while it still steps — against the previous run's completion (due 0.9–1.1 ×
 * period later; earlier only at a new demand revision), the first run against
 * the row's placement (due within one period), the window end against the
 * last run, and every such run against its runaway bounds (rule
 * A1.poll-schedule). `runs` are the key's runs from at least 1.1 × period +
 * slack before the window.
 */
export function judgePollRuns(input: {
  periodMs: number;
  window: { startMs: number; endMs: number };
  placementMs: number | null;
  runs: readonly KeyRun[];
}): PollSchedule {
  const { periodMs, window } = input;
  const windowMs = window.endMs - window.startMs;
  const lateAfterMs = (1 + POLL_JITTER) * periodMs + POLL_DUE_SLACK_MS;
  const earlyBeforeMs = (1 - POLL_JITTER) * periodMs - EARLY_TOLERANCE_MS;
  const started = input.runs.filter((run) => run.startMs < window.endMs);
  const inWindow = started.filter((run) => run.startMs >= window.startMs);
  const anchor = started.filter((run) => run.startMs < window.startMs).at(-1) ?? null;
  // The first run of a row placed with a random phase is due within one period.
  const placedDueBy = input.placementMs === null ? null : input.placementMs + periodMs + POLL_DUE_SLACK_MS;
  const schedule: PollSchedule = {
    periodMs,
    runs: inWindow.length,
    attemptsPerRun: inWindow.map((run) => run.sentMs.length),
    demandRuns: 0,
    expectedRuns: {
      min: Math.floor(windowMs / ((1 + POLL_JITTER) * periodMs)),
      max: Math.ceil(windowMs / ((1 - POLL_JITTER) * periodMs)),
    },
    previous: anchor !== null
      ? { doneAt: new Date(anchor.doneMs) }
      : input.placementMs === null ? null : { placedAt: new Date(input.placementMs) },
    early: [],
    late: [],
    overdue: null,
    runaway: runawayRuns({ runs: started, window, spanLimitMs: Math.min(periodMs, windowMs) }),
  };
  for (const [index, run] of started.entries()) {
    const own = run.startMs >= window.startMs;
    // The anchor is judged only while it still steps inside the window.
    if (!own && !(run === anchor && stepsInWindow(run, window))) continue;
    const previous = index === 0 ? null : started[index - 1]!;
    if (previous !== null) {
      const gap = run.startMs - previous.doneMs;
      const bumped = run.demandRevision !== previous.demandRevision;
      if (bumped) {
        if (own) schedule.demandRuns += 1;
      } else if (gap < earlyBeforeMs) {
        schedule.early.push({ at: new Date(run.startMs), afterMs: gap });
      }
      if (gap > lateAfterMs) schedule.late.push({ at: new Date(run.startMs), afterMs: gap });
    } else if (own && placedDueBy !== null && run.startMs > placedDueBy) {
      schedule.late.push({ at: new Date(run.startMs), afterMs: run.startMs - input.placementMs! });
    }
  }
  const last = started.at(-1) ?? null;
  const dueBy = last !== null ? last.doneMs + lateAfterMs : placedDueBy;
  if (dueBy !== null && dueBy < window.endMs) schedule.overdue = { dueBy: new Date(dueBy) };
  return schedule;
}

function minutesText(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** Why runs ran away (one clause per run). */
export function runawayText(runaway: readonly RunawayRun[]): string[] {
  return runaway.map((run) => run.bound === "size"
    ? `runaway: the run of ${run.at.toISOString()} still steps inside the window at ${run.attempts} requests, `
      + `more than ${run.limit} (${RUNAWAY_RUN.factor} × the largest earlier run + ${RUNAWAY_RUN.slackSteps})`
    : `runaway: the run of ${run.at.toISOString()} still steps inside the window ${minutesText(run.spanMs)} after it began `
      + `(${run.attempts} requests), longer than ${minutesText(run.limit)}`);
}

/** At most this many runs of one fault are named; the rest are counted. */
const LISTED_RUN_FAULTS = 3;

function listedFaults(faults: readonly string[], what: string): string[] {
  if (faults.length <= LISTED_RUN_FAULTS) return [...faults];
  return [...faults.slice(0, LISTED_RUN_FAULTS), `… and ${faults.length - LISTED_RUN_FAULTS} more ${what} runs`];
}

/** Why a poll is off its schedule (null: on it). */
export function pollScheduleFault(schedule: PollSchedule): string | null {
  const faults = [
    ...listedFaults(schedule.early.map((run) => `early: a run at ${run.at.toISOString()} ${minutesText(run.afterMs)} after the previous one at the same demand revision`), "early"),
    ...listedFaults(schedule.late.map((run) => `late: a run at ${run.at.toISOString()} ${minutesText(run.afterMs)} after the previous one`), "late"),
    ...(schedule.overdue === null ? [] : [`overdue: no run since one was due by ${schedule.overdue.dueBy.toISOString()}`]),
    ...runawayText(schedule.runaway),
  ];
  return faults.length === 0 ? null : `${faults.join("; ")} (period ${minutesText(schedule.periodMs)}, rule A1.poll-schedule)`;
}

/** A key's count at its rate (rule A1.rate). */
export interface RateCount {
  periodMs: number;
  /** Requests of its newest regular (not early) run that finished before the
   *  window end, within the look-back (else of its newest finished run); null
   *  without one. */
  runSize: number | null;
  runAt: Date | null;
  /** The window's attempts of runs that came early (a demand bump, an owner's
   *  walk within the interval): counted besides the rate. */
  extra: number;
  /** The window's attempts of every other run beyond its first `runSize`
   *  requests (a run still going, or grown past the sizing run — a runaway
   *  walk or poll): counted besides the rate. */
  beyond: number;
  /** runSize × window / period + extra + beyond; null without a run size. */
  counted: number | null;
}

/** How far back a key with this period is read (its anchor, its newest run). */
export function runLookbackMs(periodMs: number): number {
  return Math.ceil((1 + POLL_JITTER) * periodMs) + HOUR_MS;
}

/**
 * A key that runs on a fixed period longer than the window counted at its
 * rate: its newest regular finished run's requests × window / period (rule
 * A1.rate). A poll's run is finished once another began or no step followed
 * within the run gap before the window end (a single-request poll's at its
 * completion); a walk's once its row closed. A run is early when it began
 * sooner than 0.9 × the period after the previous one's completion (a walk:
 * than its minimum interval after the previous one's start); the window's
 * attempts of an early run count besides, and so do those of every other run
 * beyond its first `runSize` requests — a run that never finishes or grows
 * past the sizing run counts as it steps, a normal one stays
 * phase-independent. `interval`: a walk whose period is its minimum interval
 * between starts.
 */
export function rateCount(input: {
  periodMs: number;
  window: { startMs: number; endMs: number };
  runs: readonly KeyRun[];
  kind: "poll" | "interval";
  single?: boolean;
}): RateCount {
  const { periodMs, window, runs } = input;
  const early = runs.map((run, index) => {
    if (index === 0) return false;
    const previous = runs[index - 1]!;
    return input.kind === "interval"
      ? run.startMs - previous.startMs < periodMs
      : run.startMs - previous.doneMs < (1 - POLL_JITTER) * periodMs - EARLY_TOLERANCE_MS;
  });
  const finished = runs.map((run, index) => run.startMs < window.endMs && run.startMs >= window.endMs - runLookbackMs(periodMs) && (
    (index < runs.length - 1 && runs[index + 1]!.startMs < window.endMs)
    || (input.kind === "interval" && run.workId !== null
      ? run.workClosedMs !== null && run.workClosedMs <= window.endMs
      : input.single === true
        ? run.doneMs <= window.endMs
        : run.lastSentMs + POLL_RUN_GAP_MS <= window.endMs)));
  const newestIndex = (regular: boolean) => finished.findLastIndex((done, index) => done && (!regular || !early[index]));
  const sizing = newestIndex(true) >= 0 ? newestIndex(true) : newestIndex(false);
  const newest = sizing >= 0 ? runs[sizing]! : null;
  const runSize = newest === null ? null : newest.sentMs.length;
  let extra = 0;
  let beyond = 0;
  for (const [index, run] of runs.entries()) {
    if (early[index]) extra += attemptsInWindow(run.sentMs, window);
    else if (runSize !== null) beyond += attemptsInWindow(run.sentMs.slice(runSize), window);
  }
  return {
    periodMs,
    runSize,
    runAt: newest === null ? null : new Date(newest.startMs),
    extra,
    beyond,
    counted: runSize === null ? null : runSize * ((window.endMs - window.startMs) / periodMs) + extra + beyond,
  };
}

/** The period at which a key counts at its rate in a window of this length
 *  (rule A1.rate): a poll's period longer than the window, a walk's minimum
 *  interval longer than the window; else null (counted as observed). */
export function ratePeriodMs(spec: ResourceSpec, page: Pick<SyncPageRow, "registryOverrides">, windowMs: number): { periodMs: number; kind: "poll" | "interval" } | null {
  if (resourceDisabled(page, spec.key)) return null;
  if (spec.kind === "poll") {
    const periodMs = effectivePeriodMs(spec, page);
    return periodMs !== null && periodMs > windowMs ? { periodMs, kind: "poll" } : null;
  }
  if (spec.kind === "goal" && spec.minIntervalMs !== undefined && spec.minIntervalMs > windowMs) {
    return { periodMs: spec.minIntervalMs, kind: "interval" };
  }
  return null;
}

// ── the legacy comparison basis (pure) ───────────────────────────────────────

/**
 * How often a key recurs by itself on a page: a poll's period, a walk's
 * minimum interval, a standing walk's re-check, a cadence goal's period; 0
 * when the socket drives it (any hour may hold its reads); null without a
 * recurrence of its own (one-time backfills, api/owner/request, apply
 * follow-ups) or switched off on the page.
 */
export function recurrenceMs(spec: ResourceSpec, page: Pick<SyncPageRow, "registryOverrides">): number | null {
  if (resourceDisabled(page, spec.key)) return null;
  if (spec.kind === "poll") return effectivePeriodMs(spec, page);
  if (spec.minIntervalMs !== undefined) return spec.minIntervalMs;
  if (spec.standing !== undefined) return spec.standing.recheckMs;
  const cadence = effectiveCadence(spec, page);
  if (cadence !== null) return cadence.everyMs;
  return spec.triggers.some((trigger) => trigger.startsWith("ws")) ? 0 : null;
}

export type LegacyBasis = "window" | "7d_rate" | "live_only";

/**
 * A legacy stream's or sender's comparison basis (rules A2.rate, A2.live-only):
 * `live_only` when none of its keys runs in shadow; `7d_rate` when every key
 * that runs in shadow and recurs by itself does so less often than the window
 * on every page; else `window`.
 */
export function legacyComparisonBasis(
  specs: readonly ResourceSpec[],
  pages: ReadonlyArray<Pick<SyncPageRow, "registryOverrides">>,
  windowMs: number,
): { basis: LegacyBasis; liveOnlyKeys: string[] } {
  const liveOnlyKeys = specs.filter((spec) => !runsIn(spec, true)).map((spec) => spec.key);
  const running = specs.filter((spec) => runsIn(spec, true));
  if (running.length === 0) return { basis: "live_only", liveOnlyKeys };
  const recurrences = pages.flatMap((page) => running.map((spec) => recurrenceMs(spec, page))).filter((ms): ms is number => ms !== null);
  return { basis: recurrences.length > 0 && recurrences.every((ms) => ms > windowMs) ? "7d_rate" : "window", liveOnlyKeys };
}

/** One stream's or sender's legacy volume against the shadow's (design §3.12 A2). */
export function legacyVolumeRow(input: {
  ref: string;
  keys: readonly string[];
  basis: LegacyBasis;
  liveOnlyKeys: readonly string[];
  windowMs: number;
  /** Legacy attempts: of the window, and of its rate basis [from, window end). */
  legacy: { window: number; rate: { attempts: number; from: Date; ms: number } | null };
  /** Shadow attempts: of the window, and per page over its shadow history. */
  shadow: { window: number; history: ReadonlyArray<{ attempts: number; historyMs: number }> };
  note: string | null;
  regime: string | null;
}): LegacyVolumeRow {
  const round = (value: number) => Math.round(value * 100) / 100;
  if (input.basis === "live_only") {
    return {
      ref: input.ref,
      shadowKeys: [...input.keys],
      basis: "live_only",
      legacy: input.legacy.window,
      shadow: 0,
      ratio: null,
      note: input.note ?? `live-only (${input.liveOnlyKeys.join(", ")}): never runs in shadow (registry liveOnly, design §3.12); compared after the switch`,
      explained: true,
      legacyFrom: null,
      legacyRegime: null,
      shadowHours: null,
      liveOnlyKeys: [...input.liveOnlyKeys],
    };
  }
  let legacy = input.legacy.window;
  let shadow = input.shadow.window;
  let shadowHours: number | null = null;
  if (input.basis === "7d_rate" && input.legacy.rate !== null) {
    legacy = input.legacy.rate.ms > 0 ? input.legacy.rate.attempts * (input.windowMs / input.legacy.rate.ms) : 0;
    const history = input.shadow.history.filter((page) => page.historyMs > 0);
    shadow = history.reduce((total, page) => total + page.attempts * (input.windowMs / page.historyMs), 0);
    shadowHours = history.length === 0 ? 0 : round(history.reduce((total, page) => total + page.historyMs, 0) / history.length / HOUR_MS);
  }
  legacy = round(legacy);
  shadow = round(shadow);
  const ratio = legacy === 0 ? null : shadow / legacy;
  const inside = ratio !== null && ratio >= EXPECTATION_RATIO_BAND.min && ratio <= EXPECTATION_RATIO_BAND.max;
  return {
    ref: input.ref,
    shadowKeys: [...input.keys],
    basis: input.basis,
    legacy,
    shadow,
    ratio,
    note: input.note,
    explained: inside || input.note !== null || (legacy === 0 && shadow === 0),
    legacyFrom: input.basis === "7d_rate" && input.legacy.rate !== null ? input.legacy.rate.from : null,
    legacyRegime: input.basis === "7d_rate" ? input.regime : null,
    shadowHours,
    liveOnlyKeys: [...input.liveOnlyKeys],
  };
}

/** Rule A1.floor's second half: the legacy streams and senders with traffic
 *  on a page, each with a shadow counterpart or not. */
export interface CounterpartCheck {
  /** A legacy stream or sender with traffic on the page and no shadow counterpart. */
  lacking: Array<{ ref: string; why: string }>;
  /** A legacy stream whose keys have not run in shadow on the page yet while
   *  its shadow history is shorter than their shortest recurrence: not yet
   *  judgeable, so the exception fails (like an unknown rate). */
  pending: Array<{ ref: string; why: string }>;
  /** A legacy stream that would be pending, whose every self-recurring key has
   *  its shadow work row on the page on schedule at the window end, its first
   *  run not due yet (rule A1.floor-scheduled; does not fail the exception). */
  scheduled: Array<{ ref: string; why: string }>;
  /** A legacy stream only demand drives (no key recurs by itself) without a
   *  shadow attempt on the page: none was due by the page's own frames and
   *  applies, which its demand rows judge (listed, not required). */
  onDemand: Array<{ ref: string; why: string }>;
  /** Counterparts that never run in shadow by design (listed, not required). */
  notInShadow: Array<{ ref: string; why: "live_only" | "history_requests" }>;
}

/** The page's own shadow facts the counterpart check reads (rule A1.floor). */
export interface PageShadowHistory {
  /** Shadow attempts per key on the page from its first shadow admission
   *  (at most 7 days back) to the window end. */
  attempts: ReadonlyMap<string, number>;
  /** That history's length; null without a shadow admission. */
  historyMs: number | null;
  /** The page's shadow work rows open at the window end (`endMs`), per key
   *  (rule A1.floor-scheduled). Absent: no stream is judged scheduled. */
  schedule?: { endMs: number; rows: ReadonlyMap<string, readonly ScheduleRow[]> };
}

/** A key's shadow work row on a page, open at the window end (rule A1.floor-scheduled). */
export interface ScheduleRow {
  /** Its placement (`created_at`). */
  createdMs: number;
  /** Its due time as read: a read after the window end moves it. */
  dueMs: number;
  /** Its first attempt's admission; null before one. */
  firstAdmittedMs: number | null;
  quarantined: boolean;
  /** When a plan last found nothing due and set its re-check without a read
   *  (`waiting_reason` not_due; the row's `updated_at`); null otherwise. */
  recheckedMs?: number | null;
}

/** Whether a key's work on the page is on its schedule at the window end. */
export type KeySchedule = { onSchedule: true; what: string } | { onSchedule: false; fault: string };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Rule A1.floor-scheduled for one self-recurring key with no shadow attempt on
 * the page in its history: every row of the key open at the window end is on
 * its schedule — due after the window end (within the admission slack of it),
 * no later than its placement + the key's recurrence + the slack — or its
 * first read, after the window end, was admitted by that bound. No row, a row
 * due and not admitted by the window end, a quarantined row or a row due past
 * its bound is off schedule.
 */
export function keyOnSchedule(input: { key: string; rows: readonly ScheduleRow[]; recurrenceMs: number; endMs: number }): KeySchedule {
  if (input.rows.length === 0) return { onSchedule: false, fault: `${input.key}: no shadow work row on the page at the window end` };
  const what: string[] = [];
  for (const row of input.rows) {
    const dueByMs = row.createdMs + input.recurrenceMs + POLL_DUE_SLACK_MS;
    const bound = `placed ${iso(row.createdMs)} + ${durationText(input.recurrenceMs)} + 2 min = ${iso(dueByMs)}`;
    if (row.firstAdmittedMs !== null) {
      if (row.firstAdmittedMs > dueByMs) {
        return { onSchedule: false, fault: `${input.key}: its first read admitted ${iso(row.firstAdmittedMs)}, after its bound (${bound})` };
      }
      what.push(`${input.key} first read admitted ${iso(row.firstAdmittedMs)}, by its bound (${bound})`);
      continue;
    }
    if (row.quarantined) return { onSchedule: false, fault: `${input.key}: its row is quarantined` };
    if (row.dueMs + POLL_DUE_SLACK_MS < input.endMs) {
      return { onSchedule: false, fault: `${input.key}: due ${iso(row.dueMs)}, not admitted by the window end` };
    }
    if (row.dueMs > dueByMs) {
      const rechecked = row.recheckedMs === undefined || row.recheckedMs === null
        ? ""
        : `; its last plan (row updated ${iso(row.recheckedMs)}${row.recheckedMs > input.endMs ? ", after the window end" : ""}) found nothing due and set a re-check without a read`;
      return { onSchedule: false, fault: `${input.key}: due ${iso(row.dueMs)}, later than its bound (${bound})${rechecked}` };
    }
    what.push(`${input.key} due ${iso(row.dueMs)} (${bound})`);
  }
  return { onSchedule: true, what: what.join(" and ") };
}

function hoursText(ms: number): string {
  return `${roundTo2(ms / HOUR_MS)} h`;
}

/**
 * Whether every legacy stream or sender with traffic on the page (`legacy`:
 * its attempts on the page on the row's comparison basis) has a shadow
 * counterpart on the same page: a registry key that runs in shadow there (not
 * live-only, not switched off, not a history request) and has shadow attempts
 * on the page within its shadow history (rule A1.floor). Other pages' volume
 * never counts. Without an attempt yet, a page whose history is shorter than
 * the stream's shortest key recurrence (+ the admission slack) is not yet
 * judgeable — scheduled instead when every recurring key's row is on its
 * schedule at the window end (rule A1.floor-scheduled, `keyOnSchedule`) —
 * and past it lacks one. A stream only demand drives (the socket,
 * an apply, an owner's or the API's request) needs no volume: the page's
 * demand rows hold its frames' reads against the shadow's, so it is listed.
 */
export function legacyCounterparts(input: {
  page: Pick<SyncPageRow, "registryOverrides">;
  legacy: ReadonlyMap<string, number>;
  specsByRef: ReadonlyMap<string, readonly ResourceSpec[]>;
  shadow: PageShadowHistory;
}): CounterpartCheck {
  const check: CounterpartCheck = { lacking: [], pending: [], scheduled: [], onDemand: [], notInShadow: [] };
  for (const [ref, attempts] of [...input.legacy].sort(([a], [b]) => a.localeCompare(b))) {
    if (attempts <= 0) continue;
    const specs = input.specsByRef.get(ref) ?? [];
    const steady = specs.filter((spec) => runsIn(spec, true) && spec.class !== "requests" && !resourceDisabled(input.page, spec.key));
    if (steady.length === 0) {
      const byDesign = specs.length > 0 && specs.every((spec) => !runsIn(spec, true) || spec.class === "requests");
      if (byDesign) {
        check.notInShadow.push({ ref, why: specs.every((spec) => !runsIn(spec, true)) ? "live_only" : "history_requests" });
      } else {
        check.lacking.push({ ref, why: specs.length === 0 ? "no registry key" : "every key is switched off on the page" });
      }
      continue;
    }
    const shadow = steady.reduce((total, spec) => total + (input.shadow.attempts.get(spec.key) ?? 0), 0);
    if (shadow > 0) continue;
    const historyMs = input.shadow.historyMs;
    const history = historyMs === null ? "no shadow history" : `${hoursText(historyMs)} of shadow history`;
    const periodic = steady.flatMap((spec) => {
      const ms = recurrenceMs(spec, input.page);
      return ms !== null && ms > 0 ? [{ key: spec.key, ms }] : [];
    });
    if (periodic.length === 0) {
      check.onDemand.push({
        ref,
        why: `legacy ${attempts} on its A2 basis; only demand drives ${steady.map((spec) => spec.key).join(", ")}, none in ${history} on the page (its demand rows judge the page's frames)`,
      });
      continue;
    }
    const dueWithinMs = Math.min(...periodic.map((entry) => entry.ms)) + POLL_DUE_SLACK_MS;
    if (historyMs === null || historyMs < dueWithinMs) {
      // Rule A1.floor-scheduled: the engine holds every recurring key's first
      // run on its schedule, not yet due.
      const plan = input.shadow.schedule;
      const keys = historyMs === null || plan === undefined
        ? null
        : periodic.map((entry) => keyOnSchedule({ key: entry.key, rows: plan.rows.get(entry.key) ?? [], recurrenceMs: entry.ms, endMs: plan.endMs }));
      if (keys !== null && keys.every((key) => key.onSchedule)) {
        check.scheduled.push({
          ref,
          why: `legacy ${attempts} on its A2 basis, the shadow none yet in ${history} on the page; on its schedule: ${keys.map((key) => key.onSchedule ? key.what : "").join("; ")}`,
        });
        continue;
      }
      const off = keys === null ? [] : keys.flatMap((key) => key.onSchedule ? [] : [key.fault]);
      check.pending.push({
        ref,
        why: `not yet judgeable: legacy ${attempts} on its A2 basis, the shadow none in ${history} on the page; its keys' first run is due within ${hoursText(dueWithinMs)} of the shadow's start`
          + `${off.length === 0 ? "" : `; not on its schedule (rule A1.floor-scheduled): ${off.join("; ")}`}`,
      });
    } else {
      check.lacking.push({ ref, why: `legacy ${attempts} on its A2 basis, the shadow none in ${history} on the page` });
    }
  }
  return check;
}

// ── coalescing (pure) ─────────────────────────────────────────────────────────

export interface CoalescedSignal {
  resource: string;
  subject: string;
  atMs: number;
  /** An explicit due time of the signal (`dueAt`), else the coalescing rule's. */
  dueAtMs: number | null;
  fast: boolean;
}

export interface SimulatedReads {
  reads: number;
  /** Per signal: when its read became due, after the signal. */
  dueLagsMs: number[];
}

/**
 * Reads the engine would make for these signals under the registry's
 * coalescing (design §4.4): a signal joins the open read of its key while that
 * read is not yet due; a quiet window moves the due time later up to the
 * read's cap; a key without a coalescing rule reads at the signal (or its
 * explicit due time). A head walk of more than one page counts as one read.
 */
export function simulateCoalescedReads(
  signals: readonly CoalescedSignal[],
  coalesceOf: (resource: string) => CoalesceSpec | undefined,
): Map<string, SimulatedReads> {
  const byKey = new Map<string, CoalescedSignal[]>();
  for (const signal of signals) {
    const key = `${signal.resource}\u0000${signal.subject}`;
    byKey.set(key, [...(byKey.get(key) ?? []), signal]);
  }
  const reads = new Map<string, SimulatedReads>();
  for (const keySignals of byKey.values()) {
    const resource = keySignals[0]!.resource;
    const spec = coalesceOf(resource);
    const total = reads.get(resource) ?? { reads: 0, dueLagsMs: [] };
    let open: { firstMs: number; dueMs: number; fast: boolean; members: number[] } | null = null;
    const close = () => {
      if (open === null) return;
      total.reads += 1;
      for (const atMs of open.members) total.dueLagsMs.push(Math.max(0, open.dueMs - atMs));
      open = null;
    };
    for (const signal of [...keySignals].sort((a, b) => a.atMs - b.atMs)) {
      if (open !== null && signal.atMs < open.dueMs) {
        const fast: boolean = open.fast || signal.fast;
        const window = fast && spec?.fast !== undefined ? spec.fast : spec;
        let due: number = open.dueMs;
        if (window !== undefined) {
          // A further signal moves the read later (quiet window), never past
          // the cap; the first fast signal shortens it to the fast window.
          if (spec?.extendOnSignal === true) due = Math.max(due, signal.atMs + window.quietMs);
          due = Math.min(due, open.firstMs + window.maxMs);
          if (fast && !open.fast) due = Math.min(due, signal.atMs + window.quietMs);
        }
        if (signal.dueAtMs !== null) due = Math.min(due, Math.max(signal.dueAtMs, signal.atMs));
        open = { firstMs: open.firstMs, dueMs: due, fast, members: [...open.members, signal.atMs] };
        continue;
      }
      close();
      const window = signal.fast && spec?.fast !== undefined ? spec.fast : spec;
      const due = signal.dueAtMs !== null ? Math.max(signal.dueAtMs, signal.atMs) : signal.atMs + (window?.quietMs ?? 0);
      open = { firstMs: signal.atMs, dueMs: due, fast: signal.fast, members: [signal.atMs] };
    }
    close();
    reads.set(resource, total);
  }
  return reads;
}

function coalescedSignalsOf(atMs: number, signals: readonly DemandSignal[]): CoalescedSignal[] {
  return signals.map((signal) => ({
    resource: signal.resource,
    subject: signal.subject ?? "",
    atMs,
    dueAtMs: signal.dueAt === undefined ? null : signal.dueAt.getTime(),
    fast: signal.coalesce === "fast",
  }));
}

// ── part A ───────────────────────────────────────────────────────────────────

export interface ShadowWindowInput {
  window: { start: Date; end: Date };
  /** The pages the report covers (all six in shadow for the acceptance). */
  pages: readonly SyncPageRow[];
  resolvePayload?: FanslyWsLivePayloadResolver;
  maxListed: number;
}

export interface DemandRow {
  resource: string;
  class: string;
  kind: string;
  /** Attempts sent in the window. */
  observed: number;
  /** The reads the window's socket frames imply after coalescing (a poll's:
   *  its demand runs are judged against them); null when no frame models the
   *  key (a poll's periodic runs are judged by `runs`, walk steps and apply
   *  follow-ups are not modelled). */
  expected: number | null;
  ratio: number | null;
  /** A poll's schedule (rule A1.poll-schedule). */
  runs: PollSchedule | null;
  /** A key counted at its rate (rule A1.rate). */
  rate: RateCount | null;
  verdict: "ok" | "outside" | "not_modelled";
  reason: string;
}

export interface PageDemand {
  page: string;
  mode: SyncPageRow["mode"];
  attempts: { urgent: number; requests: number; planned: number };
  /** Urgent + planned per window, the keys on a fixed period longer than the
   *  window at their rate (rule A1.rate); the one-time backlog walks are left
   *  out (listed in `walks`). A lower bound while `unknownRunSize` names a key. */
  steadyState: number;
  /** The same with every key as observed in the window. */
  steadyStateRaw: number;
  /** Keys counted at their rate without a finished run to size them. */
  unknownRunSize: string[];
  band: { min: number; max: number };
  inBand: boolean;
  /** Rule A1.ceiling: at most `band.max`; unknown while a run size is. */
  ceiling: "ok" | "over" | "unknown";
  /** Rule A1.floor: below `band.min`, whether its exception holds. */
  floor: { below: boolean; holds: boolean | null; outside: string[]; counterparts: CounterpartCheck };
  /** Polls off schedule (rule A1.poll-schedule). */
  scheduleFaults: string[];
  /** A1 for this page: ceiling ok, every poll on schedule, in band or the floor's exception. */
  passes: boolean;
  /** Every walk key of the page; a recurring one is also a `resources` row. */
  walks: Array<{ resource: string; observed: number; oneTimeBacklog: boolean }>;
  resources: DemandRow[];
  outside: DemandRow[];
}

export interface LegacyVolumeRow {
  ref: string;
  shadowKeys: string[];
  basis: LegacyBasis;
  /** Attempts per window: of the window, or at the 7-day rate. */
  legacy: number;
  shadow: number;
  ratio: number | null;
  note: string | null;
  explained: boolean;
  /** `7d_rate`: where the legacy rate starts (7 days back, or its regime's change). */
  legacyFrom: Date | null;
  /** `7d_rate`: why the legacy rate starts at a change (rule A2.legacy-regime). */
  legacyRegime: string | null;
  /** `7d_rate`: the pages' mean shadow history in hours. */
  shadowHours: number | null;
  liveOnlyKeys: string[];
}

export interface LiveDecision {
  /** Frames the router reads. A fan message no key reads at its frame's time
   *  (a chat excluded from message sync, a message the chain confirmed by a
   *  capture before the frame) is counted in `notRead` by reason instead. */
  frames: number;
  notRead: number;
  notReadReasons: Record<string, number>;
  /** Frame received → the first shadow admission after it of a key that reads
   *  it (a fan message: its chat's head, or finding its chat). */
  shadowAdmissionLagMs: Quantiles;
  /** Frame received → the legacy store held it. */
  legacyArrivalLagMs: Quantiles;
  withoutShadowAdmission: number;
  withoutLegacyArrival: number;
  targetP95Ms: number;
  /** Null without a frame to read; false when a frame got no shadow read. */
  meetsTarget: boolean | null;
}

export interface OfflineDecisions {
  from: Date;
  to: Date;
  receipts: number;
  fanMessageFrames: number;
  transactionFrames: number;
  /** Per resource: the signals routed, the reads after coalescing, the due lag. */
  byResource: Array<{ resource: string; signals: number; reads: number; dueLagMs: Quantiles }>;
}

/** Whether a page ran in shadow, settled, through the whole window. */
export interface PageCoverage {
  page: string;
  mode: SyncPageRow["mode"];
  /** The page's first shadow admission from `SHADOW_START_LOOKBACK_MS` before
   *  the window to its end; null without one. */
  firstShadowAdmissionAt: Date | null;
  covered: boolean;
  /** Why not (null when covered): the page is `off`; its mode changed inside
   *  the window or its settling; it has no shadow admission; its first one
   *  is less than `SHADOW_SETTLE_MS` before the window. */
  reason: "off" | "mode_changed" | "no_shadow_admission" | "shadow_began_late" | null;
}

export interface ShadowWindowReport {
  window: { start: Date; end: Date };
  /** The rules part A applies (owner-visible). */
  rules: readonly AcceptanceRule[];
  /** Every page in shadow, settled, through the window; a window that starts
   *  before the deploy or a page's switch to shadow is no acceptance window. */
  coverage: PageCoverage[];
  demand: PageDemand[];
  legacy: LegacyVolumeRow[];
  livePath: { fanMessages: LiveDecision; transactions: LiveDecision; unreadableReceipts: number; offline: OfflineDecisions | null };
  pacer: { pages: Array<{ page: string; sends: number; minGapMs: number | null; violations: number }>; violations: number };
  verdict: { covered: boolean; a1: boolean; a2: boolean; a3: boolean | null; a4: boolean };
}

/**
 * Whether a page ran in shadow, settled, through the window (design §3.12:
 * the window starts once every page has been `shadow` for 10 minutes). From
 * the page row (its current mode and since when) and the journal (its first
 * shadow admission): a window that starts before the deploy or the page's
 * switch to shadow covers time without a shadow actor, so it is no acceptance
 * window whatever its checks say. A page whose mode changed only after the
 * window is judged by the journal alone.
 */
export function shadowWindowCoverage(
  page: Pick<SyncPageRow, "pageId" | "pageLabel" | "mode" | "modeChangedAt">,
  firstShadowAdmissionAt: Date | null,
  window: { start: Date; end: Date },
): PageCoverage {
  const settledBy = window.start.getTime() - SHADOW_SETTLE_MS;
  const changedMs = page.modeChangedAt.getTime();
  const changedBeforeEnd = changedMs < window.end.getTime();
  let reason: PageCoverage["reason"] = null;
  if (page.mode === "off" && changedBeforeEnd) reason = "off";
  else if (changedMs > settledBy && changedBeforeEnd) reason = "mode_changed";
  else if (firstShadowAdmissionAt === null) reason = "no_shadow_admission";
  else if (firstShadowAdmissionAt.getTime() > settledBy) reason = "shadow_began_late";
  return {
    page: page.pageLabel ?? String(page.pageId),
    mode: page.mode,
    firstShadowAdmissionAt,
    covered: reason === null,
    reason,
  };
}

/** A socket frame of the window: its page, time, the work keys that read it
 *  (resources of one subject) and the id the legacy store keys it by. */
interface FrameFact { pageId: number; atMs: number; resources: readonly string[]; subject: string; ref: string }

interface WindowFrames {
  receipts: number;
  unreadable: number;
  fanMessages: Array<Omit<FrameFact, "resources"> & { item: Extract<WsItem, { kind: "message_created" }> }>;
  transactions: FrameFact[];
  /** Per page, the decoded receipts (routing input). */
  byPage: Map<number, Array<{ atMs: number; items: WsItem[] }>>;
}

async function readWindowFrames(
  db: Database,
  input: { from: Date; to: Date; pageIds: readonly number[]; resolvePayload?: FanslyWsLivePayloadResolver },
): Promise<WindowFrames> {
  const frames: WindowFrames = { receipts: 0, unreadable: 0, fanMessages: [], transactions: [], byPage: new Map() };
  for await (const batch of decodedReceiptsInWindow(db, input)) {
    for (const receipt of batch) {
      frames.receipts += 1;
      if (receipt.decoded === null) {
        frames.unreadable += 1;
        continue;
      }
      const atMs = receipt.receivedAt.getTime();
      frames.byPage.set(receipt.pageId, [...(frames.byPage.get(receipt.pageId) ?? []), { atMs, items: receipt.decoded.items }]);
      for (const item of receipt.decoded.items) {
        if (item.kind === "message_created" && !item.isOwn) {
          frames.fanMessages.push({ pageId: receipt.pageId, atMs, subject: item.message.groupId, ref: item.message.id, item });
        } else if (item.kind === "transaction" && item.status === FANSLY_TRANSACTION_STATUS_NEW && item.type !== FANSLY_PAYOUT_TRANSACTION_TYPE) {
          frames.transactions.push({ pageId: receipt.pageId, atMs, resources: ["transactions.head"], subject: "", ref: item.id });
        }
      }
    }
  }
  return frames;
}

/** The keys that read a fan message: the chat's head, or finding the chat. */
export const FAN_MESSAGE_READ_KEYS: readonly string[] = ["dm-messages.head", "dm-conversations.find"];

/**
 * The fan-message frames a key reads, and those none reads by reason. Which
 * key reads a frame is left open: the frame matches the first shadow
 * admission of either read key of its chat, so a chat legacy lists after the
 * frame cannot turn the shadow's `.find` into a missing `.head`. Only whether
 * a frame needs a read at all is judged, by the router with the thread facts
 * as they stood at the frame (`routeThreadAt`): a chat known then and excluded
 * from message sync, or a message the chain confirmed by a capture before the
 * frame, needs none; a chain rebuilt after the window cannot drop a frame.
 */
async function fanFramesToRead(
  db: Database,
  frames: WindowFrames["fanMessages"],
): Promise<{ toRead: FrameFact[]; notRead: Record<string, number> }> {
  const toRead: FrameFact[] = [];
  const notRead: Record<string, number> = {};
  const pageIds = [...new Set(frames.map((frame) => frame.pageId))];
  for (const pageId of pageIds) {
    const ofPage = frames.filter((frame) => frame.pageId === pageId).sort((a, b) => a.atMs - b.atMs);
    const decisions = await routeReceiptsOffline(db, { pageId, receipts: ofPage.map((frame) => ({ atMs: frame.atMs, items: [frame.item] })) });
    ofPage.forEach((frame, index) => {
      const decision = decisions[index]!;
      const read = decision.signals.some((entry) => FAN_MESSAGE_READ_KEYS.includes(entry.resource) && entry.subject === frame.subject);
      if (read) {
        toRead.push({ pageId, atMs: frame.atMs, resources: FAN_MESSAGE_READ_KEYS, subject: frame.subject, ref: frame.ref });
      } else {
        const reason = decision.thread(frame.subject).excluded ? "excluded_chat" : "confirmed_before_frame";
        notRead[reason] = (notRead[reason] ?? 0) + 1;
      }
    });
  }
  return { toRead, notRead };
}

/** The reads the frames of each page imply, per page and resource. */
async function impliedReads(
  db: Database,
  byPage: Map<number, Array<{ atMs: number; items: WsItem[] }>>,
): Promise<{ byPage: Map<number, Map<string, SimulatedReads>>; signals: Map<string, number> }> {
  const coalesceOf = (resource: string) => FANSLY_RESOURCE_SPECS.find((spec) => spec.key === resource)?.coalesce;
  const result = new Map<number, Map<string, SimulatedReads>>();
  const signalCounts = new Map<string, number>();
  for (const [pageId, receipts] of byPage) {
    const routed = await routeReceiptsOffline(db, { pageId, receipts });
    const signals = routed.flatMap((receipt) => coalescedSignalsOf(receipt.atMs, receipt.signals));
    for (const signal of signals) signalCounts.set(signal.resource, (signalCounts.get(signal.resource) ?? 0) + 1);
    result.set(pageId, simulateCoalescedReads(signals, coalesceOf));
  }
  return { byPage: result, signals: signalCounts };
}

/** A page's runs of the keys judged in runs (every poll, every walk with a
 *  minimum interval), read before the pure judgement. */
export interface PageRunFacts {
  /** Runs per key (subject ''), from the run look-back to the window end. */
  runs: ReadonlyMap<string, readonly KeyRun[]>;
  /** When each poll row was placed (its first run is due within one period). */
  placements: ReadonlyMap<string, number>;
  /** The page's first shadow admission: a poll without a row was placed then. */
  firstShadowMs: number | null;
}

const NO_RUN_FACTS: PageRunFacts = { runs: new Map(), placements: new Map(), firstShadowMs: null };

/** What a key counted at its rate counts besides (rule A1.rate). */
function besidesText(rate: RateCount): string {
  return `${rate.extra > 0 ? `, + ${rate.extra} of an early run` : ""}${rate.beyond > 0 ? `, + ${rate.beyond} beyond the run size` : ""}`;
}

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

function durationText(ms: number): string {
  return ms % HOUR_MS === 0 ? `${ms / HOUR_MS} h` : `${(ms / 60_000).toFixed(1)} min`;
}

/**
 * One page's demand of the window against its expectation (design §3.12 A1
 * under rules A1.rate, A1.ceiling, A1.floor and A1.poll-schedule). Pure:
 * every fact is read before.
 */
export function demandOfPage(
  page: Pick<SyncPageRow, "pageId" | "pageLabel" | "mode" | "registryOverrides">,
  input: {
    window: { startMs: number; endMs: number };
    observed: ReadonlyMap<string, { class: string; attempts: number }>;
    reads: ReadonlyMap<string, SimulatedReads> | undefined;
    facts: PageRunFacts;
    counterparts: CounterpartCheck;
  },
): PageDemand {
  const windowMs = input.window.endMs - input.window.startMs;
  const hours = windowMs / HOUR_MS;
  const rows: DemandRow[] = [];
  const keys = new Set([...input.observed.keys(), ...(input.reads?.keys() ?? [])]);
  for (const spec of FANSLY_RESOURCE_SPECS) {
    if (!runsIn(spec, true) || resourceDisabled(page, spec.key)) continue;
    if ((spec.kind === "poll" && spec.period !== undefined) || ratePeriodMs(spec, page, windowMs) !== null) keys.add(spec.key);
  }
  const walks: PageDemand["walks"] = [];
  let steadyState = 0;
  let steadyStateRaw = 0;
  const unknownRunSize: string[] = [];
  const scheduleFaults: string[] = [];
  const attempts = { urgent: 0, requests: 0, planned: 0 };
  const count = (key: string, observed: number, rate: RateCount | null) => {
    steadyStateRaw += observed;
    if (rate === null) {
      steadyState += observed;
    } else if (rate.counted === null) {
      // Without a run to size it, only what the window saw (a lower bound).
      steadyState += observed;
      unknownRunSize.push(key);
    } else {
      steadyState += rate.counted;
    }
  };
  for (const key of [...keys].sort()) {
    const spec = FANSLY_RESOURCE_SPECS.find((entry) => entry.key === key);
    const observedRow = input.observed.get(key);
    const observed = observedRow?.attempts ?? 0;
    const workClass = observedRow?.class ?? spec?.class ?? "planned";
    if (workClass === "urgent" || workClass === "requests" || workClass === "planned") attempts[workClass] += observed;
    const runs = input.facts.runs.get(key) ?? [];
    const ratePeriod = spec === undefined ? null : ratePeriodMs(spec, page, windowMs);
    const rate = ratePeriod === null
      ? null
      : rateCount({ ...ratePeriod, window: input.window, runs, single: spec !== undefined && runGroupingOf(spec) === "single" });
    if (spec?.kind === "goal") {
      const oneTimeBacklog = isOneTimeWalk(spec);
      walks.push({ resource: key, observed, oneTimeBacklog });
      if (oneTimeBacklog || workClass === "requests") continue;
      count(key, observed, rate);
      // A walk on a minimum interval that keeps stepping past its earlier
      // walks' size ran away (rule A1.rate).
      const runaway = rate === null ? [] : runawayRuns({ runs, window: input.window, spanLimitMs: null });
      const runawayFault = runaway.length === 0 ? null : `${runawayText(runaway).join("; ")} (rule A1.rate)`;
      if (runawayFault !== null) scheduleFaults.push(`${key}: ${runawayFault}`);
      const reason = rate === null
        ? "a recurring walk: its steps are not modelled per resource; counted in the steady state as observed"
        : rate.counted === null
          ? `a walk at most every ${durationText(rate.periodMs)}: no finished walk to size it yet (rule A1.rate)`
          : `a walk at most every ${durationText(rate.periodMs)}: counted at its rate, ${rate.runSize} steps per `
            + `${durationText(rate.periodMs)} (the walk of ${rate.runAt!.toISOString()}${besidesText(rate)}; rule A1.rate)`;
      rows.push({
        resource: key,
        class: workClass,
        kind: spec.kind,
        observed,
        expected: null,
        ratio: null,
        runs: null,
        rate,
        verdict: runawayFault === null ? "not_modelled" : "outside",
        reason: runawayFault === null ? reason : `${reason}; ${runawayFault}`,
      });
      continue;
    }
    if (workClass !== "requests") count(key, observed, rate);
    const periodMs = spec?.kind === "poll" && !resourceDisabled(page, key) ? effectivePeriodMs(spec, page) : null;
    const implied = input.reads?.get(key);
    if (spec?.http === false) {
      // Applied from the socket without a request (dm-live.deletions): its
      // frames imply work, never an attempt.
      rows.push({
        resource: key,
        class: workClass,
        kind: spec.kind,
        observed,
        expected: 0,
        ratio: null,
        runs: null,
        rate: null,
        verdict: observed === 0 ? "ok" : "outside",
        reason: `no request: applied from the socket (registry http: false)${implied === undefined ? "" : `; ${implied.reads} applied work${implied.reads === 1 ? "" : "s"} implied`}`,
      });
    } else if (spec !== undefined && periodMs !== null) {
      const placementMs = input.facts.placements.get(key) ?? input.facts.firstShadowMs;
      const row = pollRow({ spec, key, workClass, observed, periodMs, window: input.window, placementMs, runs, reads: input.reads?.get(key), rate });
      const fault = row.runs === null ? null : pollScheduleFault(row.runs);
      if (fault !== null) scheduleFaults.push(`${key}: ${fault}`);
      rows.push(row);
    } else {
      rows.push(demandRow(spec, key, workClass, observed, input.reads?.get(key)));
    }
  }
  const band = { min: STEADY_STATE_BAND_PER_HOUR.min * hours, max: STEADY_STATE_BAND_PER_HOUR.max * hours };
  steadyState = roundTo2(steadyState);
  const ceiling = unknownRunSize.length > 0 ? "unknown" : steadyState <= band.max ? "ok" : "over";
  const outside = rows.filter((row) => row.verdict === "outside");
  const below = steadyState < band.min;
  const holds = below
    ? outside.length === 0 && input.counterparts.lacking.length === 0 && input.counterparts.pending.length === 0
    : null;
  return {
    page: page.pageLabel ?? String(page.pageId),
    mode: page.mode,
    attempts,
    steadyState,
    steadyStateRaw,
    unknownRunSize,
    band,
    inBand: steadyState >= band.min && steadyState <= band.max,
    ceiling,
    floor: { below, holds, outside: outside.map((row) => row.resource), counterparts: input.counterparts },
    scheduleFaults,
    passes: ceiling === "ok" && scheduleFaults.length === 0 && (!below || holds === true),
    walks,
    resources: rows,
    outside,
  };
}

/** A poll's row: its schedule in runs (rule A1.poll-schedule); its demand
 *  runs against the reads the window's frames imply — both ways where only
 *  the socket bumps it, one-sided below and loosely above where an apply or a
 *  dependency bumps it too. */
function pollRow(input: {
  spec: ResourceSpec;
  key: string;
  workClass: string;
  observed: number;
  periodMs: number;
  window: { startMs: number; endMs: number };
  placementMs: number | null;
  runs: readonly KeyRun[];
  reads: SimulatedReads | undefined;
  rate: RateCount | null;
}): DemandRow {
  const schedule = judgePollRuns({ periodMs: input.periodMs, window: input.window, placementMs: input.placementMs, runs: input.runs });
  const socket = input.reads?.reads ?? null;
  const base = {
    resource: input.key,
    class: input.workClass,
    kind: input.spec.kind,
    observed: input.observed,
    runs: schedule,
    rate: input.rate,
  };
  const sizes = schedule.attemptsPerRun;
  const runsText = `${schedule.runs} run${schedule.runs === 1 ? "" : "s"}`
    + `${sizes.length === 0 ? "" : sizes.every((n) => n === 1) ? ` × 1 request` : ` of ${sizes.join(", ")} requests`}`
    + `${schedule.demandRuns === 0 ? "" : ` (${schedule.demandRuns} on a demand bump)`}; ${schedule.expectedRuns.min}–${schedule.expectedRuns.max} due `
    + `every ${durationText(input.periodMs)} ±10 %`
    + `${input.rate === null ? "" : input.rate.counted === null ? "; no finished run to size its rate" : `; counted at its rate, ${input.rate.runSize} per ${durationText(input.periodMs)}${besidesText(input.rate)}`}`;
  const fault = pollScheduleFault(schedule);
  if (fault !== null) return { ...base, expected: socket, ratio: null, verdict: "outside", reason: `${runsText}; ${fault}` };
  // Where only the socket (and the period) bump the poll, its demand runs are
  // held against the frames' reads both ways. Where an apply or a dependency
  // bumps it too (transactions.rescan, account.poll), those bumps only add
  // runs: the frames' reads still bound it from below (at least 0.5×), and the
  // period's runs + 2× the frames' reads from above (a self-bump loop).
  const socketOnly = input.spec.triggers.every((trigger) => trigger === "poll" || trigger.startsWith("ws"));
  if (!socketOnly) {
    const reads = socket ?? 0;
    const demandText = `${schedule.demandRuns} demand run${schedule.demandRuns === 1 ? "" : "s"} vs ${reads} socket read${reads === 1 ? "" : "s"}`;
    const atMost = schedule.expectedRuns.max + EXPECTATION_RATIO_BAND.max * reads;
    if (reads >= 1 && schedule.demandRuns < EXPECTATION_RATIO_BAND.min * reads) {
      return {
        ...base, expected: socket, ratio: schedule.demandRuns / reads, verdict: "outside",
        reason: `${runsText}; ${demandText}: fewer than ${EXPECTATION_RATIO_BAND.min}× the reads the frames imply (other bumps only add runs)`,
      };
    }
    if (schedule.demandRuns > atMost) {
      return {
        ...base, expected: socket, ratio: reads === 0 ? null : schedule.demandRuns / reads, verdict: "outside",
        reason: `${runsText}; ${demandText}: more than the period's ${schedule.expectedRuns.max} runs + ${EXPECTATION_RATIO_BAND.max}× the frames' reads (${atMost}) explain`,
      };
    }
    return {
      ...base, expected: socket, ratio: reads === 0 ? null : schedule.demandRuns / reads, verdict: "ok",
      reason: schedule.demandRuns === 0 && socket === null ? runsText : `${runsText}; ${demandText} (at least ${EXPECTATION_RATIO_BAND.min}× the frames' reads; applies and dependencies add runs)`,
    };
  }
  if (socket === null && schedule.demandRuns === 0) return { ...base, expected: null, ratio: null, verdict: "ok", reason: runsText };
  const demand = demandJudgement(schedule.demandRuns, socket ?? 0);
  return {
    ...base,
    expected: socket,
    ratio: demand.ratio,
    verdict: demand.inside ? "ok" : "outside",
    reason: `${runsText}; ${schedule.demandRuns} demand run${schedule.demandRuns === 1 ? "" : "s"} vs ${socket ?? 0} socket read${socket === 1 ? "" : "s"}`,
  };
}

function demandJudgement(observed: number, expected: number): { ratio: number | null; inside: boolean } {
  if (expected < 1 && observed <= 1) return { ratio: null, inside: true };
  const ratio = expected === 0 ? null : observed / expected;
  return { ratio, inside: ratio !== null && ratio >= EXPECTATION_RATIO_BAND.min && ratio <= EXPECTATION_RATIO_BAND.max };
}

/** A key that is not a poll: its attempts against the reads its socket frames imply. */
function demandRow(
  spec: ResourceSpec | undefined,
  key: string,
  workClass: string,
  observed: number,
  reads: SimulatedReads | undefined,
): DemandRow {
  const kind = spec?.kind ?? "unknown";
  const socket = reads?.reads ?? null;
  const base = { resource: key, class: workClass, kind, observed, runs: null, rate: null };
  if (socket === null) {
    const triggers = spec?.triggers ?? [];
    const reason = spec === undefined
      ? "not in the registry"
      : triggers.some((trigger) => trigger.startsWith("apply:")) ? "follow-up of applies (the shadow estimate)"
        : triggers.includes("owner") ? "owner-triggered"
          : "demand not modelled by the report";
    return { ...base, expected: null, ratio: null, verdict: "not_modelled", reason };
  }
  const demand = demandJudgement(observed, socket);
  const basis = `socket reads ${socket}`;
  if (demand.inside && demand.ratio === null) {
    return { ...base, expected: socket, ratio: null, verdict: "ok", reason: `at most one read expected (${basis})` };
  }
  return {
    ...base,
    expected: socket,
    ratio: demand.ratio,
    verdict: demand.inside ? "ok" : "outside",
    reason: demand.inside ? basis : `observed ${observed} vs expected ${socket} (${basis})`,
  };
}

/** Every page's runs of the keys judged in runs, from the longest look-back. */
async function readRunFacts(
  db: Database,
  input: { pages: readonly SyncPageRow[]; window: { start: Date; end: Date }; firstShadow: ReadonlyMap<number, Date> },
): Promise<Map<number, PageRunFacts>> {
  const windowMs = input.window.end.getTime() - input.window.start.getTime();
  const specs = FANSLY_RESOURCE_SPECS.filter((spec) => runsIn(spec, true) && (spec.kind === "poll" || spec.minIntervalMs !== undefined));
  const periods = input.pages.flatMap((page) => specs.map((spec) => spec.kind === "poll" ? effectivePeriodMs(spec, page) : spec.minIntervalMs ?? null))
    .filter((ms): ms is number => ms !== null);
  const lookbackMs = Math.max(windowMs, ...periods.map(runLookbackMs));
  const pageIds = input.pages.map((page) => page.pageId);
  const attempts = await listSyncRunAttempts(db, {
    pageIds,
    shadow: true,
    resources: specs.map((spec) => spec.key),
    from: new Date(input.window.start.getTime() - lookbackMs),
    to: input.window.end,
  });
  const placements = await readSyncPollPlacements(db, { pageIds, shadow: true, before: input.window.end });
  const facts = new Map<number, PageRunFacts>();
  for (const page of input.pages) {
    const ofPage = attempts.filter((attempt) => attempt.pageId === page.pageId && attempt.subject === "");
    const runs = new Map<string, KeyRun[]>();
    for (const spec of specs) {
      const ofKey = ofPage.filter((attempt) => attempt.resource === spec.key).map((attempt) => ({
        workId: attempt.workId,
        demandRevision: attempt.demandRevision,
        sentMs: attempt.sentAt.getTime(),
        doneMs: attempt.doneAt.getTime(),
        workClosedMs: attempt.workClosedAt?.getTime() ?? null,
      }));
      if (ofKey.length > 0) runs.set(spec.key, runsOf(ofKey, runGroupingOf(spec)));
    }
    facts.set(page.pageId, {
      runs,
      placements: new Map(placements.filter((row) => row.pageId === page.pageId).map((row) => [row.resource, row.createdAt.getTime()])),
      firstShadowMs: input.firstShadow.get(page.pageId)?.getTime() ?? null,
    });
  }
  return facts;
}

/** The legacy volume of part A (design §3.12 A2) and, per page, each stream's
 *  or sender's legacy traffic on its row's basis and the page's own shadow
 *  history (rule A1.floor). */
interface LegacyVolume {
  rows: LegacyVolumeRow[];
  byPage: Map<number, Map<string, number>>;
  shadowByPage: Map<number, PageShadowHistory>;
  specsByRef: Map<string, ResourceSpec[]>;
}

async function legacyVolume(
  db: Database,
  input: { pages: readonly SyncPageRow[]; window: { start: Date; end: Date }; observed: Map<number, Map<string, { class: string; attempts: number }>> },
): Promise<LegacyVolume> {
  const pageIds = input.pages.map((page) => page.pageId);
  const endMs = input.window.end.getTime();
  const windowMs = endMs - input.window.start.getTime();
  const weekFromMs = endMs - LEGACY_WEEK_MS;
  const specsByRef = new Map<string, ResourceSpec[]>();
  for (const spec of FANSLY_RESOURCE_SPECS) {
    for (const ref of spec.legacy) specsByRef.set(refKey(ref), [...(specsByRef.get(refKey(ref)) ?? []), spec]);
  }
  const bases = new Map([...specsByRef].map(([ref, specs]) => [ref, legacyComparisonBasis(specs, input.pages, windowMs)]));
  const rateFromMs = (ref: string) => Math.max(weekFromMs, LEGACY_REGIME_SINCE[ref]?.since.getTime() ?? weekFromMs);

  const inWindow = await countLegacyFanslyAttempts(db, { pageIds, from: input.window.start, to: input.window.end });
  const rateCounts = new Map<number, typeof inWindow>();
  for (const [ref, basis] of bases) {
    const fromMs = rateFromMs(ref);
    if (basis.basis !== "7d_rate" || rateCounts.has(fromMs)) continue;
    rateCounts.set(fromMs, await countLegacyFanslyAttempts(db, { pageIds, from: new Date(fromMs), to: input.window.end }));
  }
  const legacyOf = (counts: typeof inWindow, ref: string, pageId?: number) =>
    counts.streams.filter((row) => `stream:${row.stream}` === ref && (pageId === undefined || row.pageId === pageId)).reduce((total, row) => total + row.attempts, 0)
    + counts.senders.filter((row) => `sender:${row.source}` === ref && (pageId === undefined || row.pageId === pageId)).reduce((total, row) => total + row.attempts, 0);

  // Each page's shadow history within the legacy week (A2.rate): from its
  // first shadow admission; a page has no shadow attempt before it.
  const firstShadow = await readFirstShadowAdmissions(db, { pageIds, from: new Date(weekFromMs), to: input.window.end });
  const historyStarts = [...firstShadow.values()].map((at) => at.getTime());
  const historyCounts = historyStarts.length === 0
    ? []
    : await countSyncAttemptsByKey(db, { pageIds, shadow: true, from: new Date(Math.min(...historyStarts)), to: input.window.end });

  const rows: LegacyVolumeRow[] = [];
  const byPage = new Map<number, Map<string, number>>(pageIds.map((pageId) => [pageId, new Map()]));
  for (const [ref, specs] of [...specsByRef].sort(([a], [b]) => a.localeCompare(b))) {
    const keys = specs.map((spec) => spec.key);
    const { basis, liveOnlyKeys } = bases.get(ref)!;
    const fromMs = rateFromMs(ref);
    const rate = basis === "7d_rate" ? rateCounts.get(fromMs)! : null;
    let shadowWindow = 0;
    for (const observed of input.observed.values()) {
      for (const key of keys) shadowWindow += observed.get(key)?.attempts ?? 0;
    }
    const history = pageIds.flatMap((pageId) => {
      const from = firstShadow.get(pageId);
      if (from === undefined) return [];
      const attempts = historyCounts
        .filter((row) => row.pageId === pageId && keys.includes(row.resource))
        .reduce((total, row) => total + row.attempts, 0);
      return [{ attempts, historyMs: endMs - from.getTime() }];
    });
    const regime = LEGACY_REGIME_SINCE[ref];
    rows.push(legacyVolumeRow({
      ref,
      keys,
      basis,
      liveOnlyKeys,
      windowMs,
      legacy: {
        window: legacyOf(inWindow, ref),
        rate: rate === null ? null : { attempts: legacyOf(rate, ref), from: new Date(fromMs), ms: endMs - fromMs },
      },
      shadow: { window: shadowWindow, history },
      note: LEGACY_VOLUME_NOTES[ref] ?? null,
      regime: regime !== undefined && regime.since.getTime() > weekFromMs ? `from ${regime.since.toISOString()}: ${regime.why}` : null,
    }));
    for (const pageId of pageIds) {
      byPage.get(pageId)!.set(ref, legacyOf(rate ?? inWindow, ref, pageId));
    }
  }
  // Each page's own shadow attempts per key over its history (A1.floor's
  // counterparts: never another page's volume).
  const shadowByPage = new Map<number, PageShadowHistory>(pageIds.map((pageId) => {
    const from = firstShadow.get(pageId);
    const attempts = new Map<string, number>();
    for (const row of historyCounts) {
      if (row.pageId === pageId) attempts.set(row.resource, (attempts.get(row.resource) ?? 0) + row.attempts);
    }
    return [pageId, { attempts, historyMs: from === undefined ? null : endMs - from.getTime() }];
  }));
  // The rows of the keys that recur by themselves, open at the window end
  // (rule A1.floor-scheduled: a stream whose first run is not yet due).
  const recurring = [...new Set(FANSLY_RESOURCE_SPECS
    .filter((spec) => runsIn(spec, true) && input.pages.some((page) => (recurrenceMs(spec, page) ?? 0) > 0))
    .map((spec) => spec.key))];
  const open = await listSyncWorkOpenAt(db, { pageIds, shadow: true, resources: recurring, at: input.window.end });
  for (const [pageId, history] of shadowByPage) {
    const rows = new Map<string, ScheduleRow[]>();
    for (const row of open) {
      if (row.pageId !== pageId) continue;
      rows.set(row.resource, [...(rows.get(row.resource) ?? []), {
        createdMs: row.createdAt.getTime(),
        dueMs: row.dueAt.getTime(),
        firstAdmittedMs: row.firstAdmittedAt?.getTime() ?? null,
        quarantined: row.state === "quarantined",
        recheckedMs: row.waitingReason === "not_due" ? row.updatedAt.getTime() : null,
      }]);
    }
    shadowByPage.set(pageId, { ...history, schedule: { endMs, rows } });
  }
  return { rows, byPage, shadowByPage, specsByRef };
}

async function liveDecision(
  db: Database,
  input: {
    frames: FrameFact[];
    notRead: Record<string, number>;
    pageIds: readonly number[];
    window: { start: Date; end: Date };
    target: number;
    kind: "messages" | "transactions";
  },
): Promise<LiveDecision> {
  const admissions = await listSyncAdmissions(db, {
    pageIds: input.pageIds,
    shadow: true,
    resources: [...new Set(input.frames.flatMap((frame) => frame.resources))],
    from: input.window.start,
    to: new Date(input.window.end.getTime() + ADMISSION_SEARCH_MS),
  });
  const keyOf = (pageId: number, resource: string, subject: string) => `${pageId}\u0000${resource}\u0000${subject}`;
  // Admission times per key, ascending (the read orders by admission).
  const byKey = new Map<string, number[]>();
  for (const admission of admissions) {
    const key = keyOf(admission.pageId, admission.resource, admission.subject);
    const times = byKey.get(key);
    if (times === undefined) byKey.set(key, [admission.admittedAt.getTime()]);
    else times.push(admission.admittedAt.getTime());
  }
  const firstAdmission = (frame: FrameFact): number | undefined => {
    let first: number | undefined;
    for (const resource of frame.resources) {
      const at = byKey.get(keyOf(frame.pageId, resource, frame.subject))?.find((time) => time >= frame.atMs);
      if (at !== undefined && (first === undefined || at < first)) first = at;
    }
    return first;
  };
  const arrivals = new Map<number, Map<string, Date>>();
  for (const pageId of input.pageIds) {
    const refs = input.frames.filter((frame) => frame.pageId === pageId).map((frame) => frame.ref);
    if (refs.length === 0) continue;
    arrivals.set(pageId, input.kind === "messages"
      ? await readLegacyMessageArrivals(db, { pageId, messageIds: refs })
      : await readLedgerTransactionsCreatedAt(db, { pageId, transactionIds: refs }));
  }
  const shadowLags: number[] = [];
  const legacyLags: number[] = [];
  let withoutShadow = 0;
  let withoutLegacy = 0;
  for (const frame of input.frames) {
    const admitted = firstAdmission(frame);
    if (admitted === undefined) withoutShadow += 1;
    else shadowLags.push(admitted - frame.atMs);
    const arrived = arrivals.get(frame.pageId)?.get(frame.ref);
    if (arrived === undefined) withoutLegacy += 1;
    else legacyLags.push(Math.max(0, arrived.getTime() - frame.atMs));
  }
  const shadowQ = quantiles(shadowLags);
  return {
    frames: input.frames.length,
    notRead: Object.values(input.notRead).reduce((total, count) => total + count, 0),
    notReadReasons: input.notRead,
    shadowAdmissionLagMs: shadowQ,
    legacyArrivalLagMs: quantiles(legacyLags),
    withoutShadowAdmission: withoutShadow,
    withoutLegacyArrival: withoutLegacy,
    targetP95Ms: input.target,
    // Every frame to read must have its shadow read, within the target.
    meetsTarget: input.frames.length === 0
      ? null
      : withoutShadow === 0 && shadowQ !== null && shadowQ.p95 <= input.target,
  };
}

async function offlineDecisions(
  db: Database,
  input: { pageIds: readonly number[]; to: Date; resolvePayload?: FanslyWsLivePayloadResolver },
): Promise<OfflineDecisions> {
  const from = new Date(input.to.getTime() - OFFLINE_DECISIONS_LOOKBACK_MS);
  const frames = await readWindowFrames(db, {
    from,
    to: input.to,
    pageIds: input.pageIds,
    ...(input.resolvePayload === undefined ? {} : { resolvePayload: input.resolvePayload }),
  });
  const implied = await impliedReads(db, frames.byPage);
  const merged = new Map<string, { reads: number; dueLagsMs: number[] }>();
  for (const reads of implied.byPage.values()) {
    for (const [resource, simulated] of reads) {
      const current = merged.get(resource) ?? { reads: 0, dueLagsMs: [] };
      merged.set(resource, { reads: current.reads + simulated.reads, dueLagsMs: [...current.dueLagsMs, ...simulated.dueLagsMs] });
    }
  }
  return {
    from,
    to: input.to,
    receipts: frames.receipts,
    fanMessageFrames: frames.fanMessages.length,
    transactionFrames: frames.transactions.length,
    byResource: [...merged].sort(([a], [b]) => a.localeCompare(b)).map(([resource, simulated]) => ({
      resource,
      signals: implied.signals.get(resource) ?? 0,
      reads: simulated.reads,
      dueLagMs: quantiles(simulated.dueLagsMs),
    })),
  };
}

/** Part A of the shadow report over [start, end). */
export async function reportShadowWindow(db: Database, input: ShadowWindowInput): Promise<ShadowWindowReport> {
  const { start, end } = input.window;
  const windowMs = end.getTime() - start.getTime();
  if (!(windowMs > 0)) throw new Error("the report window must end after it starts");
  const pageIds = input.pages.map((page) => page.pageId);
  const resolve = input.resolvePayload === undefined ? {} : { resolvePayload: input.resolvePayload };

  // Every page in shadow, settled, through the window.
  const firstShadow = await readFirstShadowAdmissions(db, { pageIds, from: new Date(start.getTime() - SHADOW_START_LOOKBACK_MS), to: end });
  const coverage = input.pages.map((page) => shadowWindowCoverage(page, firstShadow.get(page.pageId) ?? null, input.window));

  // A1: demand against its expectation.
  const observed = new Map<number, Map<string, { class: string; attempts: number }>>();
  for (const row of await countSyncAttemptsByKey(db, { pageIds, shadow: true, from: start, to: end })) {
    const page = observed.get(row.pageId) ?? new Map<string, { class: string; attempts: number }>();
    const current = page.get(row.resource);
    page.set(row.resource, { class: row.class, attempts: (current?.attempts ?? 0) + row.attempts });
    observed.set(row.pageId, page);
  }
  const frames = await readWindowFrames(db, { from: start, to: end, pageIds, ...resolve });
  const implied = await impliedReads(db, frames.byPage);

  // A2: the legacy engine's hour (A1's floor reads its counterparts).
  const legacy = await legacyVolume(db, { pages: input.pages, window: input.window, observed });

  const runFacts = await readRunFacts(db, { pages: input.pages, window: input.window, firstShadow });
  const demand = input.pages.map((page) => demandOfPage(page, {
    window: { startMs: start.getTime(), endMs: end.getTime() },
    observed: observed.get(page.pageId) ?? new Map(),
    reads: implied.byPage.get(page.pageId),
    facts: runFacts.get(page.pageId) ?? NO_RUN_FACTS,
    counterparts: legacyCounterparts({
      page,
      legacy: legacy.byPage.get(page.pageId) ?? new Map(),
      specsByRef: legacy.specsByRef,
      shadow: legacy.shadowByPage.get(page.pageId) ?? { attempts: new Map(), historyMs: null },
    }),
  }));

  // A3: live-path decisions.
  const fan = await fanFramesToRead(db, frames.fanMessages);
  const fanMessages = await liveDecision(db, {
    frames: fan.toRead,
    notRead: fan.notRead,
    pageIds,
    window: input.window,
    target: LIVE_PATH_TARGET_P95_MS.messages,
    kind: "messages",
  });
  const transactions = await liveDecision(db, {
    frames: frames.transactions,
    notRead: {},
    pageIds,
    window: input.window,
    target: LIVE_PATH_TARGET_P95_MS.transactions,
    kind: "transactions",
  });
  const offline = frames.fanMessages.length < LIVE_PATH_MIN_SAMPLE.messages || frames.transactions.length < LIVE_PATH_MIN_SAMPLE.transactions
    ? await offlineDecisions(db, { pageIds, to: start, ...resolve })
    : null;

  // A4: the pacer's self-check over the shadow journal.
  const pace = await readSyncJournalMetrics(db, { pageIds, shadow: true, since: start, until: end });
  const pacerPages = input.pages.map((page) => {
    const row = pace.find((entry) => entry.pageId === page.pageId);
    return {
      page: page.pageLabel ?? String(page.pageId),
      sends: (row?.sends.urgent ?? 0) + (row?.sends.requests ?? 0) + (row?.sends.planned ?? 0),
      minGapMs: row?.minGapMs ?? null,
      violations: row?.paceViolations ?? 0,
    };
  });
  const violations = pacerPages.reduce((total, row) => total + row.violations, 0);

  const decisions = [fanMessages.meetsTarget, transactions.meetsTarget].filter((value): value is boolean => value !== null);
  return {
    window: input.window,
    rules: SHADOW_WINDOW_RULES,
    coverage,
    demand: demand.map((page) => ({ ...page, outside: page.outside.slice(0, input.maxListed) })),
    legacy: legacy.rows,
    livePath: { fanMessages, transactions, unreadableReceipts: frames.unreadable, offline },
    pacer: { pages: pacerPages, violations },
    verdict: {
      covered: coverage.every((page) => page.covered),
      a1: demand.every((page) => page.passes),
      a2: legacy.rows.every((row) => row.explained),
      a3: decisions.length === 0 ? null : decisions.every(Boolean),
      a4: violations === 0,
    },
  };
}
