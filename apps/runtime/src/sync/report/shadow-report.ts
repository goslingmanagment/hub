import { sql } from "drizzle-orm";

import {
  countMediaStatsRefreshProgress,
  type Database,
  type FanslyWsLivePayloadResolver,
  type MediaStatsRefreshProgress,
  type SyncPageMode,
  type SyncPageRow,
} from "@agency_hub_core/db";

import type { SyncContext } from "../context.ts";
import type { SettingsSource } from "../engine/ports.ts";
import type { EngineRegistry } from "../engine/resource.ts";
import { ScanGovernor, type ScanPacing } from "../fansly/lib/chain-rebuild.ts";
import { purchaseAnnouncementSummary } from "./purchase-announcements.ts";
import { readShadowFingerprint, type ShadowFingerprintPage, type ShadowReportFingerprint } from "./shadow-fingerprint.ts";
import {
  backtestEta,
  checkChains,
  REPLAY_EXCUSED_REASON_NOTES,
  replayResources,
  SEPTEMBER_16_COUNTEREXAMPLE_RAW_IDS,
  type ChainCheckReport,
  type ReplayKindReport,
} from "./shadow-journal.ts";
import {
  reportShadowWindow,
  socketDemandText,
  STEADY_STATE_BAND_PER_HOUR,
  type PageDemand,
  type ShadowWindowReport,
} from "./shadow-window.ts";
import { readShadowRouteChecks, routeCheckLines, type ShadowRouteChecks } from "./shadow-routes.ts";
import type { EtaBacktestPageReport } from "../requests/eta-backtest.ts";

// `pnpm cli sync shadow report` (design §3.12): the shadow acceptance's
// evidence in one JSON document with an owner-readable summary. Part A reads
// the live one-hour window in ONE read-only repeatable-read transaction (a
// consistent picture of the hour); part B reads the past journal in batches
// (read-only transactions for the replay; the chain checks and the ETA
// backtest are the dry-run scans of `sync chain …` and `sync history
// eta-backtest`). The report judges the pages in shadow alone — the switch
// candidates: a page `live`, in `handover` or `off` is listed as not judged
// with its mode and why, and counts in no part and no verdict (a live page is
// judged by `sync switch check`). Acceptance = every judged page settled in
// shadow through the window (a window that starts before the deploy or a
// page's switch to shadow is no acceptance window), A1–A4 hold, the route
// budgets held in shadow and no walk went round in circles (step 3b ruling 12,
// `shadow-routes.ts`), the fingerprint proves the window's sync build
// (`shadow-fingerprint.ts`: the switch accepts the report only of its own
// build and route policy), B5 ≥ 99.9 % per resource (matched over every
// observation but legacy's own refusals; a kind with observations and nothing
// judged fails) with every mismatch listed for explanation, B6 lists the 16.09
// counterexamples and no empty-page soundness hit, B7 printed. A report that
// is not accepted can still carry a switch: the owner judges its red lines
// with evidence (ruling 12, `SHADOW_VERDICT_CHECKS`; `sync switch
// --accept-red-lines`), never a failed hard check.

export interface ShadowReportInput {
  /** The pages to report on; only those in shadow are judged
   *  (`shadowReportScope`). */
  pages: readonly SyncPageRow[];
  registry: Pick<EngineRegistry, "module">;
  /** Part A's window; null skips part A. */
  window: { start: Date; end: Date } | null;
  /** Part B; null skips it. */
  journal: {
    replaySince: Date;
    replayMinPerKind: number;
    replayMaxPerKind: number;
    /** The `/message` journal of B6 and B7 since. */
    chainsSince: Date;
    pacing: ScanPacing;
    /** The 16.09 counterexamples B6 must list (tests pass their own). */
    expectedCounterexampleRawIds?: readonly number[];
  } | null;
  maxListed: number;
  resolvePayload?: FanslyWsLivePayloadResolver;
  /** The live settings part A's module checks read, as the engine host reads
   *  them (`createEffectiveConfigSettingsSource`): a look check re-runs the
   *  plan's own pick, and the replies' re-walk cycle is live config (rule
   *  A1.floor-idle; the registry's 14 d is not prod's 30 d). */
  settings: SettingsSource;
  /** The build of the process writing the report (its fingerprint). */
  reportBuild: string | null;
}

export interface ShadowReportVerdict {
  /** Every page in shadow, settled, through part A's window. */
  covered: boolean | null;
  a1: boolean | null;
  a2: boolean | null;
  a3: boolean | null;
  a4: boolean | null;
  /** Every route and family kept its budget in shadow (ruling 12). */
  budgets: boolean | null;
  /** No walk asked a route from the same position twice (ruling 12). */
  walks: boolean | null;
  /** The fingerprint proves the one sync build of the window. */
  build: boolean;
  b5: boolean | null;
  b6: boolean | null;
  b7: boolean | null;
  /** Every part ran to completion and every check holds. */
  accepted: boolean;
}

/**
 * Every check of the verdict and who may overrule its FAIL (step 3b ruling
 * 12: "the other A1/A2 rules stay frozen and red lines are judged by the owner
 * with evidence"). A `hard` check — the window's coverage, the pacer, the
 * route budgets, the walks, the build — is never overruled; a `red_line` of a
 * frozen rule only by the owner, at the switch, with a reason it audits
 * (`sync switch --accept-red-lines`). The rules and thresholds stay as they are.
 */
export const SHADOW_VERDICT_CHECKS: Readonly<Record<Exclude<keyof ShadowReportVerdict, "accepted">, "hard" | "red_line">> = {
  covered: "hard",
  a1: "red_line",
  a2: "red_line",
  a3: "red_line",
  a4: "hard",
  budgets: "hard",
  walks: "hard",
  build: "hard",
  b5: "red_line",
  b6: "red_line",
  b7: "red_line",
};

export type ShadowVerdictCheck = keyof typeof SHADOW_VERDICT_CHECKS;

const VERDICT_CHECKS = Object.keys(SHADOW_VERDICT_CHECKS) as ShadowVerdictCheck[];
/** The checks no one overrules, in the verdict's order. */
export const SHADOW_HARD_CHECKS: readonly ShadowVerdictCheck[] = VERDICT_CHECKS.filter((key) => SHADOW_VERDICT_CHECKS[key] === "hard");
/** The checks whose FAIL the owner may accept, in the verdict's order. */
export const SHADOW_RED_LINES: readonly ShadowVerdictCheck[] = VERDICT_CHECKS.filter((key) => SHADOW_VERDICT_CHECKS[key] === "red_line");

/** Whether `name` is a check of the verdict (never an inherited property). */
export function isShadowVerdictCheck(name: string): name is ShadowVerdictCheck {
  return Object.hasOwn(SHADOW_VERDICT_CHECKS, name);
}

/** Why the report does not judge a page in this mode. */
export const SHADOW_NOT_JUDGED_REASONS: Readonly<Record<Exclude<SyncPageMode, "shadow">, string>> = {
  live: "live — judged by `sync switch check`",
  handover: "handover — a switch is under way; judged by `sync switch check` once live",
  off: "off — the engine does not run the page",
};

/** A page the report lists without judging it. */
export interface ShadowReportNotJudged {
  page: string;
  mode: Exclude<SyncPageMode, "shadow">;
  reason: string;
}

/** The pages the report judges — those in shadow, the switch candidates —
 *  and the others, listed with their mode and why. Pure. */
export function shadowReportScope<P extends Pick<SyncPageRow, "pageId" | "pageLabel" | "mode">>(
  pages: readonly P[],
): { judged: P[]; notJudged: ShadowReportNotJudged[] } {
  const judged: P[] = [];
  const notJudged: ShadowReportNotJudged[] = [];
  for (const page of pages) {
    if (page.mode === "shadow") {
      judged.push(page);
    } else {
      notJudged.push({ page: page.pageLabel ?? String(page.pageId), mode: page.mode, reason: SHADOW_NOT_JUDGED_REASONS[page.mode] });
    }
  }
  return { judged, notJudged };
}

/** The media-stats walk as the shadow models it on a page (ruling 12), with
 *  its queue under those tiers at the window end. */
export interface ShadowMediaModelRow extends Pick<ShadowFingerprintPage, "page" | "media"> {
  queue: MediaStatsRefreshProgress;
}

export interface ShadowReport {
  generatedAt: Date;
  /** The pages judged: every one in shadow (the switch checks its page here). */
  pages: Array<{ page: string; mode: SyncPageRow["mode"] }>;
  /** The pages listed but not judged: in no part and no verdict. */
  notJudged: ShadowReportNotJudged[];
  /** What the hour ran on (build, route policy, registry and tiers, S). */
  fingerprint: ShadowReportFingerprint;
  window: ShadowWindowReport | null;
  /** Part A's two SQL checks over the shadow journal. */
  routes: ShadowRouteChecks | null;
  media: ShadowMediaModelRow[] | null;
  journal: {
    replay: ReplayKindReport[];
    chains: ChainCheckReport[];
    septemberSixteen: { expected: number[]; listed: number[]; missing: number[] };
    eta: Array<EtaBacktestPageReport | { pageId: number; error: string }>;
    stoppedBy: string | null;
  } | null;
  verdict: ShadowReportVerdict;
  summary: string[];
}

interface WindowPart {
  window: ShadowWindowReport;
  routes: ShadowRouteChecks;
  media: ShadowMediaModelRow[];
  fingerprint: ShadowReportFingerprint;
}

/** Part A — and the fingerprint of its window — inside one read-only,
 *  repeatable-read transaction. */
async function windowPart(
  ctx: Pick<SyncContext, "db" | "logger">,
  input: ShadowReportInput,
  window: { start: Date; end: Date },
): Promise<WindowPart> {
  return ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    const report = await reportShadowWindow(tx, {
      window,
      pages: input.pages,
      maxListed: input.maxListed,
      registry: input.registry,
      logger: ctx.logger,
      ...(input.resolvePayload === undefined ? {} : { resolvePayload: input.resolvePayload }),
      settings: input.settings,
    });
    const routes = await readShadowRouteChecks(tx, { pages: input.pages, window, maxListed: input.maxListed });
    const fingerprint = await readShadowFingerprint(tx, { pages: input.pages, window, settings: input.settings, reportBuild: input.reportBuild });
    // The fingerprint's media model per page (in `input.pages` order), with
    // its queue under the same tiers.
    const media: ShadowMediaModelRow[] = [];
    for (const [index, page] of input.pages.entries()) {
      const model = fingerprint.pages[index]!;
      media.push({
        page: model.page,
        media: model.media,
        queue: await countMediaStatsRefreshProgress(tx, { pageId: page.pageId, now: window.end, longTailCycleDays: 30, tiers: model.media.tiers }),
      });
    }
    return { window: report, routes, media, fingerprint };
  });
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(2)} %`;
}

function seconds(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`;
}

function mark(value: boolean | null): string {
  return value === null ? "n/a" : value ? "ok" : "FAIL";
}

export async function buildShadowReport(ctx: Pick<SyncContext, "db" | "logger">, requested: ShadowReportInput): Promise<ShadowReport> {
  // Every part below reads the judged pages alone.
  const scope = shadowReportScope(requested.pages);
  const input: ShadowReportInput = { ...requested, pages: scope.judged };
  const part = input.window === null ? null : await windowPart(ctx, input, input.window);
  const window = part?.window ?? null;
  const fingerprint = part?.fingerprint
    ?? await readShadowFingerprint(ctx.db, { pages: input.pages, window: null, settings: input.settings, reportBuild: input.reportBuild });

  let journal: ShadowReport["journal"] = null;
  if (input.journal !== null) {
    const governor = new ScanGovernor(input.journal.pacing);
    const replay = await replayResources(ctx, {
      pages: input.pages,
      registry: input.registry,
      since: input.journal.replaySince,
      minPerKind: input.journal.replayMinPerKind,
      maxPerKind: input.journal.replayMaxPerKind,
      batchRows: input.journal.pacing.batchRows,
      maxListed: input.maxListed,
    }, governor);
    const scan = { pages: input.pages, since: input.journal.chainsSince, pacing: input.journal.pacing, maxListed: input.maxListed };
    const chains = await checkChains(ctx, scan, governor);
    const eta = await backtestEta(ctx, scan, governor);
    const expected = [...(input.journal.expectedCounterexampleRawIds ?? SEPTEMBER_16_COUNTEREXAMPLE_RAW_IDS)];
    const listed = new Set(chains.flatMap((row) => "error" in row.endRule ? [] : row.endRule.shortPages.counterexampleRawIds));
    journal = {
      replay,
      chains,
      septemberSixteen: { expected, listed: expected.filter((id) => listed.has(id)), missing: expected.filter((id) => !listed.has(id)) },
      eta,
      stoppedBy: governor.stopReason(),
    };
  }

  const routes = part?.routes ?? null;
  const media = part?.media ?? null;
  const verdict = verdictOf({ window, routes, fingerprint }, journal, input.pages.length);
  return {
    generatedAt: new Date(),
    pages: input.pages.map((page) => ({ page: page.pageLabel ?? String(page.pageId), mode: page.mode })),
    notJudged: scope.notJudged,
    fingerprint,
    window,
    routes,
    media,
    journal,
    verdict,
    summary: summaryOf({ window, routes, media, fingerprint }, journal, verdict, { judged: input.pages, notJudged: scope.notJudged }),
  };
}

function verdictOf(
  partA: Pick<ShadowReport, "window" | "routes" | "fingerprint">,
  journal: ShadowReport["journal"],
  pages: number,
): ShadowReportVerdict {
  const { window, routes, fingerprint } = partA;
  // A kind passes only on its own ratio; null is a kind without a single
  // legacy observation (listed as not replayable, design §3.12).
  const b5 = journal === null
    ? null
    : journal.replay.every((row) => row.stoppedBy === null && row.meetsTarget !== false);
  const chainsComplete = journal !== null && journal.chains.length === pages && journal.chains.every((row) =>
    !("error" in row.rebuild) && row.rebuild.scan.completed && !("error" in row.endRule) && row.endRule.scan.completed);
  const b6 = journal === null
    ? null
    : chainsComplete && journal.septemberSixteen.missing.length === 0
      && journal.chains.every((row) => !("error" in row.endRule) && row.endRule.emptyPageSoundness.hits.length === 0);
  const b7 = journal === null
    ? null
    : journal.eta.length === pages && journal.eta.every((row) => !("error" in row) && row.scan.completed);
  const verdict = {
    covered: window?.verdict.covered ?? null,
    a1: window?.verdict.a1 ?? null,
    a2: window?.verdict.a2 ?? null,
    a3: window?.verdict.a3 ?? null,
    a4: window?.verdict.a4 ?? null,
    budgets: routes === null ? null : routes.budgets.violations === 0,
    walks: routes === null ? null : routes.walks.repeats === 0,
    build: fingerprint.build.sync !== null,
    b5,
    b6,
    b7,
  };
  // A3 without a single sampled frame is decided by the offline replay, which
  // the owner reads; every other check must hold, both parts must have run
  // and a page must have been judged.
  const accepted = pages > 0 && window !== null && journal !== null
    && verdict.covered === true
    && verdict.a1 === true && verdict.a2 === true && verdict.a3 !== false && verdict.a4 === true
    && verdict.budgets === true && verdict.walks === true && verdict.build
    && b5 === true && b6 === true && b7 === true;
  return { ...verdict, accepted };
}

/** One page's A1 line: the steady state at its rate, its socket demand apart
 *  (rule A1.ceiling-demand), the rest against the ceiling and the band, the
 *  floor's exception below it, the polls' schedule. */
function demandLine(page: PageDemand): string {
  const perHour = page.band.max / STEADY_STATE_BAND_PER_HOUR.max;
  const rated = page.resources
    .filter((row) => row.rate !== null && row.rate.counted !== null && row.rate.runSize !== null && row.rate.runSize > 0
      && row.rate.sizedBy === "run")
    .map((row) => `${row.resource} ${row.rate!.runSize}/${row.rate!.periodMs / 3_600_000} h`
      + `${row.rate!.extra + row.rate!.beyond > 0 ? ` + ${row.rate!.extra + row.rate!.beyond}` : ""}`);
  const assumed = page.assumedRunSize.map((entry) => `${entry.resource} ${entry.steps}/${entry.periodMs / 3_600_000} h`);
  const { socketDemand } = page;
  const parts = [
    `steady ${page.steadyState} per ${perHour === 1 ? "hour" : `${perHour} h`} (observed ${page.steadyStateRaw}`
      + `${rated.length === 0 ? "" : `; at their rate: ${rated.join(", ")}`})`,
    `socket demand ${socketDemand.perHour} reads/h, ${socketDemand.capacityShare} % of capacity ${socketDemand.capacityPerHour}/h (`
      + socketDemand.resources.map((entry) => `${socketDemandText(entry)}, `).join("")
      + "out of the ceiling, rule A1.ceiling-demand)",
    page.ceiling === "unknown"
      ? `ceiling ${page.band.max}: UNKNOWN, at least ${page.ceilingSteadyState} — no finished run to size it and no assumed size of ${page.unknownRunSize.join(", ")} (rules A1.rate, A1.rate-assumed)`
      : `ceiling ${page.band.max} ${page.ceiling === "ok" ? "ok" : "OVER"} at ${page.ceilingSteadyState}`
        + `${assumed.length === 0 ? "" : ` (on assumed sizes, no finished run yet: ${assumed.join(", ")}; rule A1.rate-assumed)`}`,
  ];
  if (!page.floor.below) {
    parts.push(page.inBand ? `band ${page.band.min}–${page.band.max}` : `above the band ${page.band.min}–${page.band.max}`);
  } else {
    const { counterparts } = page.floor;
    const listed = `${counterparts.scheduled.length === 0 ? "" : `; scheduled, first run not yet due (rule A1.floor-scheduled): ${counterparts.scheduled.map((entry) => `${entry.ref} (${entry.why})`).join(", ")}`}`
      + `${counterparts.idle.length === 0 ? "" : `; idle, nothing due on the page — looked on time, which subjects a due rule takes not verified while legacy reads first (rules A1.floor-queue, A1.floor-idle): ${counterparts.idle.map((entry) => `${entry.ref} (${entry.why})`).join(", ")}`}`
      + `${counterparts.onDemand.length === 0 ? "" : `; on demand, none due on the page: ${counterparts.onDemand.map((entry) => entry.ref).join(", ")}`}`
      + `${counterparts.notInShadow.length === 0 ? "" : `; not in shadow by design: ${counterparts.notInShadow.map((entry) => `${entry.ref} (${entry.why})`).join(", ")}`}`;
    parts.push(page.floor.holds === true
      ? `below ${page.band.min}: the floor's exception holds (rule A1.floor: every modelled resource at its expectation, every legacy stream with a shadow counterpart on the page${listed})`
      : `below ${page.band.min}: the floor's exception FAILS (rule A1.floor${page.floor.outside.length === 0 ? "" : `; outside: ${page.floor.outside.join(", ")}`}`
        + `${counterparts.lacking.length === 0 ? "" : `; no shadow counterpart on the page: ${counterparts.lacking.map((entry) => `${entry.ref} (${entry.why})`).join(", ")}`}`
        + `${counterparts.pending.length === 0 ? "" : `; counterpart NOT YET JUDGEABLE: ${counterparts.pending.map((entry) => `${entry.ref} (${entry.why})`).join(", ")}`}${listed})`);
  }
  parts.push(page.scheduleFaults.length === 0
    ? "polls on schedule, no runaway run"
    : `OFF SCHEDULE or RUNAWAY (rules A1.poll-schedule, A1.rate): ${page.scheduleFaults.join("; ")}`);
  // Rows outside their expectation other than a poll off schedule (named above).
  const offSchedule = new Set(page.scheduleFaults.map((fault) => fault.slice(0, fault.indexOf(":"))));
  const outsideRows = page.outside.filter((row) => !offSchedule.has(row.resource));
  if (!page.floor.below && outsideRows.length > 0) parts.push(`outside 0.5×–2×: ${outsideRows.map((row) => row.resource).join(", ")}`);
  return `A1 ${page.page}: ${parts.join("; ")} — ${page.passes ? "ok" : "FAIL"}`;
}

function tiersText(tiers: ShadowFingerprintPage["media"]["tiers"]): string {
  const days = (ms: number) => `${Math.round((ms / 86_400_000) * 10) / 10} d`;
  return `≤ ${tiers.freshDays} d every ${days(tiers.freshEveryMs)}, ≤ ${tiers.midDays} d every ${days(tiers.midEveryMs)}, `
    + `older every ${days(tiers.oldEveryMs)}`;
}

function fingerprintLine(fingerprint: ShadowReportFingerprint): string {
  const { build, setting } = fingerprint;
  return `Fingerprint: sync build ${build.sync ?? `UNPROVEN (${build.unproven})`}`
    + `${build.report !== null && build.report !== build.sync ? ` (report written by ${build.report})` : ""}; `
    + `route policy ${fingerprint.policyHash.slice(0, 12)}, registry ${fingerprint.registryHash.slice(0, 12)}; `
    + `S ${setting.effectiveMs ?? "unreadable"} ms now${setting.windowMs.length === 0 ? "" : `, ${setting.windowMs.join(" / ")} ms in the window`}`;
}

/** Which pages the report judged and which it only lists. */
function scopeLine(scope: { judged: readonly SyncPageRow[]; notJudged: readonly ShadowReportNotJudged[] }): string {
  const judged = scope.judged.map((page) => page.pageLabel ?? String(page.pageId));
  return `Judged: ${judged.length === 0 ? "none — no page is in shadow" : `${judged.join(", ")} (in shadow, the switch candidates)`}`
    + `${scope.notJudged.length === 0 ? "" : `; not judged, in no verdict: ${scope.notJudged.map((entry) => `${entry.page} ${entry.reason}`).join("; ")}`}`;
}

function summaryOf(
  partA: Pick<ShadowReport, "window" | "routes" | "media" | "fingerprint">,
  journal: ShadowReport["journal"],
  verdict: ShadowReportVerdict,
  scope: { judged: readonly SyncPageRow[]; notJudged: readonly ShadowReportNotJudged[] },
): string[] {
  const { window, routes, media, fingerprint } = partA;
  const lines: string[] = [fingerprintLine(fingerprint), scopeLine(scope)];
  if (window !== null) {
    lines.push(`Window ${window.window.start.toISOString()} … ${window.window.end.toISOString()}`);
    const uncovered = window.coverage.filter((page) => !page.covered);
    lines.push(uncovered.length === 0
      ? "Coverage: every page in shadow from at least 10 min before the start"
      : `Coverage: NOT an acceptance window — ${uncovered.map((page) => `${page.page} ${page.reason}`
        + `${page.firstShadowAdmissionAt === null ? "" : ` (first shadow admission ${page.firstShadowAdmissionAt.toISOString()})`}`).join(", ")}; `
        + "the window must start once every page has run in shadow for 10 min");
    for (const rule of window.rules) lines.push(`Rule ${rule.id}: ${rule.text}`);
    for (const page of window.demand) lines.push(demandLine(page));
    const unexplained = window.legacy.filter((row) => !row.explained).map((row) => `${row.ref} (${row.basis}: legacy ${row.legacy}, `
      + `shadow ${row.shadow}${row.ratio === null ? "" : `, ratio ${row.ratio.toFixed(2)}`})`
      + `${row.basis === "demand_replaced" && row.note !== null ? ` — ${row.note}` : ""}`);
    const liveOnly = window.legacy.filter((row) => row.basis === "live_only" && row.legacy > 0).map((row) => `${row.ref} ${row.legacy}`);
    // Rule A2.demand-replaced: listed with the legacy volume and what the poll read.
    const demandReplaced = window.legacy.filter((row) => row.basis === "demand_replaced" && row.explained && row.legacy > 0)
      .map((row) => `${row.ref} ${row.legacy} (shadow ${row.shadow}; `
        + `${row.announcements === null ? "no legacy attempt to judge" : purchaseAnnouncementSummary(row.announcements)})`);
    lines.push(`A2 legacy volume: ${unexplained.length === 0 ? "every stream and sender explained" : `unexplained: ${unexplained.join(", ")}`}`
      + `${liveOnly.length === 0 ? "" : `; live-only, not in shadow (rule A2.live-only): ${liveOnly.join(", ")}`}`
      + `${demandReplaced.length === 0 ? "" : `; demand-replaced, compared after the switch (rule A2.demand-replaced): ${demandReplaced.join(", ")}`}`);
    const { fanMessages, transactions, offline } = window.livePath;
    lines.push(`A3 fan messages: ${fanMessages.frames} frames to read (${fanMessages.withoutShadowAdmission} without a shadow read, `
      + `${fanMessages.notRead} needing none), shadow p95 ${seconds(fanMessages.shadowAdmissionLagMs?.p95)} `
      + `(target ${seconds(fanMessages.targetP95Ms)}), legacy p95 ${seconds(fanMessages.legacyArrivalLagMs?.p95)}`);
    lines.push(`A3 transactions: ${transactions.frames} frames (${transactions.withoutShadowAdmission} without a shadow read), `
      + `shadow p95 ${seconds(transactions.shadowAdmissionLagMs?.p95)} `
      + `(target ${seconds(transactions.targetP95Ms)}), legacy p95 ${seconds(transactions.legacyArrivalLagMs?.p95)}`);
    if (offline !== null) {
      lines.push(`A3 offline decisions over ${offline.receipts} receipts of the previous 24 h: `
        + offline.byResource.map((row) => `${row.resource} ${row.reads} reads / ${row.signals} signals`).join("; "));
    }
    lines.push(`A4 pacer: ${window.pacer.violations} shadow pairs closer than the setting`);
  }
  if (routes !== null) lines.push(...routeCheckLines(routes));
  for (const row of media ?? []) {
    lines.push(`Media model ${row.page}: tiers ${tiersText(row.media.tiers)}; long-tail windows ${row.media.longTailWindowMode}; `
      + `queue ${row.queue.queueSize} (never visited ${row.queue.neverVisited}, due ${row.queue.dueNow}, `
      + `backfill done ${row.queue.backfillComplete})`);
  }
  if (journal !== null) {
    const below = journal.replay.filter((row) => row.meetsTarget === false).map((row) => `${row.kind} `
      + (row.ratio !== null ? percent(row.ratio) : row.notReplayableReasons.no_replay === undefined ? "nothing judged" : "no replay"));
    const none = journal.replay.filter((row) => row.meetsTarget === null).map((row) => row.kind);
    lines.push(`B5 replay: ${journal.replay.reduce((total, row) => total + row.total, 0)} observations; `
      + `${below.length === 0 ? "every resource ≥ 99.9 %" : `below 99.9 %: ${below.join(", ")}`}`
      + `${none.length === 0 ? "" : `; not replayable (no observation): ${none.join(", ")}`}`);
    // What was not compared, per kind and reason: where legacy stored no fact
    // to compare with, the reason is named and left out of the ratio; every
    // other reason counts as not matched.
    const skipped = journal.replay.filter((row) => row.notReplayable > 0).map((row) => `${row.kind} `
      + Object.entries(row.notReplayableReasons)
        .map(([reason, count]) => {
          const note = REPLAY_EXCUSED_REASON_NOTES[reason];
          return `${reason} ${count}${note === undefined ? "" : ` (${note}, left out)`}`;
        })
        .join(", "));
    if (skipped.length > 0) lines.push(`B5 not replayable: ${skipped.join("; ")}`);
    // Matches that needed a named legacy rule, per kind and rule.
    const via = journal.replay.filter((row) => Object.keys(row.matchedVia).length > 0).map((row) => `${row.kind} `
      + Object.entries(row.matchedVia).map(([rule, count]) => `${rule} ${count}`).join(", "));
    if (via.length > 0) lines.push(`B5 matched through a legacy rule: ${via.join("; ")}`);
    const hits = journal.chains.reduce((total, row) => total + ("error" in row.endRule ? 0 : row.endRule.emptyPageSoundness.hits.length), 0);
    lines.push(`B6 chains: 16.09 counterexamples listed ${journal.septemberSixteen.listed.length}/${journal.septemberSixteen.expected.length}, `
      + `empty-page soundness hits ${hits}`);
    lines.push(`B7 ETA: ${journal.eta.length} pages backtested`);
    if (journal.stoppedBy !== null) lines.push(`Part B stopped early: ${journal.stoppedBy}`);
  }
  lines.push(`Verdict: coverage ${mark(verdict.covered)}, A1 ${mark(verdict.a1)}, A2 ${mark(verdict.a2)}, A3 ${mark(verdict.a3)}, A4 ${mark(verdict.a4)}, `
    + `route budgets ${mark(verdict.budgets)}, walks ${mark(verdict.walks)}, build ${mark(verdict.build)}, `
    + `B5 ${mark(verdict.b5)}, B6 ${mark(verdict.b6)}, B7 ${mark(verdict.b7)} — ${verdict.accepted ? "ACCEPTED" : "not accepted"}`);
  return lines;
}
