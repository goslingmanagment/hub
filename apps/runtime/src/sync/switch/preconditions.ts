import { sql } from "drizzle-orm";

import {
  FANSLY_SYNC_ENGINE_HYDRATION_LANE,
  getFanslySendGuard,
  getLatestCompletedChainRebuild,
  getNotificationIncidentByKey,
  getSyncPage,
  listSyncPages,
  type SyncPageRow,
} from "@agency_hub_core/db";

import { loadEffectiveConfig } from "../../services/effective-config.ts";
import { syncEngineIncidentKey } from "../../services/notification-incidents.ts";
import { inLegacyNightWindow } from "../fansly/lib/chain-rebuild.ts";
import { ROUTE_POLICY_HASH } from "../fansly/routes.ts";
import { judgeShadowFingerprint, type ShadowFingerprintExpectation } from "../report/shadow-fingerprint.ts";
import {
  isShadowVerdictCheck,
  SHADOW_HARD_CHECKS,
  SHADOW_RED_LINES,
  SHADOW_VERDICT_CHECKS,
  type ShadowVerdictCheck,
} from "../report/shadow-report.ts";
import { isUnfinishedRollback, readLatestSwitchAudit } from "./audit.ts";
import { wholeSeconds, type SwitchContext } from "./context.ts";

// The switch's preconditions (design step 3 §3.5 item 7, runbook §6.1): every
// machine-checkable one is re-checked by the CLI before phase A, and `--dry-run`
// prints them all. Every check reads the database clock.

/** A `sync` heartbeat this old is a stopped process. */
export const SWITCH_SYNC_HEARTBEAT_FRESH_MS = 90_000;
/** The page's shadow owner must have beaten this recently. */
export const SWITCH_OWNER_HEARTBEAT_FRESH_MS = 30_000;
/** The shadow report's window must have ended this recently. */
export const SWITCH_REPORT_MAX_AGE_MS = 24 * 60 * 60_000;

export interface SwitchCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** The shadow report as `sync shadow report --out` writes it (the fields the
 *  switch reads). */
interface ShadowReportFile {
  generatedAt?: unknown;
  pages?: Array<{ page?: unknown; mode?: unknown }>;
  window?: { window?: { start?: unknown; end?: unknown } } | null;
  verdict?: Record<string, unknown> & { accepted?: unknown };
  fingerprint?: unknown;
}

/** The owner's judgement of a report's red lines (step 3b ruling 12: "red
 *  lines are judged by the owner with evidence"), as `sync switch
 *  --accept-red-lines <checks> --red-lines-reason <text>` gives it. */
export interface RedLinesAcceptance {
  /** The verdict checks the owner accepts failing: red lines only. */
  checks: readonly string[];
  /** The owner's evidence, audited with the switch. */
  reason: string;
}

/** The red lines a switch runs on by the owner's word: what it audits. */
export interface AcceptedRedLines {
  /** The report's failing checks: every one a red line the owner accepted. */
  checks: ShadowVerdictCheck[];
  /** What the owner listed that the report does not fail. */
  listedNotFailing: string[];
  reason: string;
  /** The report's window and when the report was written. */
  window: { start: string | null; end: string | null };
  generatedAt: string | null;
}

function check(name: string, ok: boolean, detail: string): SwitchCheck {
  return { name, ok, detail };
}

/** A check's state in a report's verdict: true passes, false fails; anything
 *  else was not judged (its part did not run) — but A3 without a sampled
 *  frame (null), which the verdict leaves to the offline replay. */
function verdictState(verdict: Record<string, unknown>, key: ShadowVerdictCheck): "ok" | "fail" | "not_judged" {
  const value = verdict[key];
  if (value === true || (key === "a3" && value === null)) return "ok";
  return value === false ? "fail" : "not_judged";
}

function statesText(verdict: Record<string, unknown>, keys: readonly ShadowVerdictCheck[]): string {
  return keys.map((key) => `${key} ${verdictState(verdict, key) === "fail" ? "FAIL" : "not judged"}`).join(", ");
}

/** The owner's word is well-formed: a reason, and red lines alone. Pure. */
export function redLinesAcceptanceProblem(acceptance: RedLinesAcceptance): string | null {
  if (acceptance.reason.trim().length === 0) return "accepting red lines needs the owner's reason (--red-lines-reason)";
  if (acceptance.checks.length === 0) return "--accept-red-lines names no red line";
  const hard = acceptance.checks.filter((key) => isShadowVerdictCheck(key) && SHADOW_VERDICT_CHECKS[key] === "hard");
  if (hard.length > 0) return `${hard.join(", ")}: a hard check of the shadow report, never accepted (red lines: ${SHADOW_RED_LINES.join(", ")})`;
  const unknown = acceptance.checks.filter((key) => !isShadowVerdictCheck(key));
  if (unknown.length > 0) return `${unknown.join(", ")}: no check of the shadow report (red lines: ${SHADOW_RED_LINES.join(", ")})`;
  return null;
}

/**
 * A report whose verdict is not accepted carries a switch only by the owner's
 * judgement of its red lines (step 3b ruling 12): every failing check a red
 * line the owner listed, every hard check passed, every part run. Pure.
 */
export function judgeRedLines(
  verdict: Record<string, unknown>,
  acceptance: RedLinesAcceptance | null,
): { ok: true; checks: ShadowVerdictCheck[]; listedNotFailing: string[] } | { ok: false; detail: string } {
  const hard = SHADOW_HARD_CHECKS.filter((key) => verdictState(verdict, key) !== "ok");
  const failing = SHADOW_RED_LINES.filter((key) => verdictState(verdict, key) === "fail");
  const unjudged = SHADOW_RED_LINES.filter((key) => verdictState(verdict, key) === "not_judged");
  if (acceptance === null) {
    const named = [...hard, ...failing, ...unjudged];
    const offer = hard.length === 0 && unjudged.length === 0 && failing.length > 0
      ? `; the owner may accept its red lines with evidence: --accept-red-lines ${failing.join(",")} --red-lines-reason "<evidence>" (step 3b ruling 12)`
      : "";
    return { ok: false, detail: `the shadow report's verdict is not accepted${named.length === 0 ? "" : ` (${statesText(verdict, named)})`}${offer}` };
  }
  if (hard.length > 0) {
    return { ok: false, detail: `the shadow report fails a hard check (${statesText(verdict, hard)}): never accepted, whatever the red lines` };
  }
  if (unjudged.length > 0) {
    return { ok: false, detail: `the shadow report did not judge ${unjudged.join(", ")} (a part did not run): no red line of an incomplete report is accepted` };
  }
  const unaccepted = failing.filter((key) => !acceptance.checks.includes(key));
  if (unaccepted.length > 0) {
    return {
      ok: false,
      detail: `the shadow report fails ${unaccepted.join(", ")}, which the owner did not accept (--accept-red-lines ${acceptance.checks.join(",")})`,
    };
  }
  if (failing.length === 0) return { ok: false, detail: "the shadow report's verdict is not accepted, yet it fails no check" };
  return { ok: true, checks: failing, listedNotFailing: acceptance.checks.filter((key) => !failing.some((entry) => entry === key)) };
}

/** The owner's acceptance as the switch prints it. */
export function redLinesLine(redLines: AcceptedRedLines): string {
  return `red lines ${redLines.checks.join(", ")} accepted by the owner (step 3b ruling 12): "${redLines.reason}"`
    + `${redLines.listedNotFailing.length === 0 ? "" : `; listed but not failing: ${redLines.listedNotFailing.join(", ")}`}`
    + `; report window ${redLines.window.start ?? "?"} … ${redLines.window.end ?? "?"}`;
}

/** "sync runs the same build as this CLI" (G13): the newest `sync` heartbeat
 *  must be fresh and carry this CLI's non-empty build identity. Pure. */
export function judgeBuildIdentity(
  sync: { imageTag: string | null; ageMs: number } | null,
  own: string | null,
): SwitchCheck {
  if (sync === null) return check("build_identity", false, "no sync heartbeat (runtime_instances role sync)");
  if (sync.ageMs > SWITCH_SYNC_HEARTBEAT_FRESH_MS) {
    return check("build_identity", false, `the sync heartbeat is ${wholeSeconds(sync.ageMs)} s old`);
  }
  const unknown = (value: string | null): boolean => value === null || value.trim().length === 0 || value === "unknown";
  if (unknown(sync.imageTag) || unknown(own)) {
    return check("build_identity", false, `build identity unknown (sync ${sync.imageTag ?? "null"}, this CLI ${own ?? "null"})`);
  }
  return sync.imageTag === own
    ? check("build_identity", true, `sync and this CLI run ${own}`)
    : check("build_identity", false, `sync runs ${sync.imageTag}, this CLI ${own}`);
}

/** The build check, and the build `sync` runs (its newest heartbeat's). */
async function buildIdentityCheck(ctx: SwitchContext): Promise<{ check: SwitchCheck; syncBuild: string | null }> {
  const result = await ctx.db.execute<{ imageTag: string | null; ageMs: number | string }>(sql`
    select image_tag as "imageTag",
           extract(epoch from clock_timestamp() - last_seen_at) * 1000 as "ageMs"
      from runtime_instances
     where role = 'sync'
     order by last_seen_at desc
     limit 1
  `);
  const row = result.rows[0];
  return {
    check: judgeBuildIdentity(row === undefined ? null : { imageTag: row.imageTag, ageMs: Number(row.ageMs) }, ctx.buildSha),
    syncBuild: row?.imageTag ?? null,
  };
}

/**
 * The shadow report's verdict for the page (S2-13: one report-wide verdict),
 * of the build and route policy being switched to (step 3b ruling 12: its
 * fingerprint; an accepted report of another build proves nothing about this
 * one, however fresh). A verdict that is not accepted passes only by the
 * owner's judgement of its red lines (`judgeRedLines`), returned for the
 * switch to audit; everything else is checked as for an accepted one.
 */
export function shadowReportCheck(
  text: string | null,
  pageLabel: string,
  now: Date,
  expected: ShadowFingerprintExpectation,
  acceptance: RedLinesAcceptance | null = null,
): { check: SwitchCheck; redLines: AcceptedRedLines | null } {
  const refuse = (detail: string) => ({ check: check("shadow_report", false, detail), redLines: null });
  if (acceptance !== null) {
    const problem = redLinesAcceptanceProblem(acceptance);
    if (problem !== null) return refuse(problem);
  }
  if (text === null) return refuse("no shadow report (--shadow-report <path>)");
  let report: ShadowReportFile;
  try {
    report = JSON.parse(text) as ShadowReportFile;
  } catch {
    return refuse("the shadow report is not JSON");
  }
  let red: { checks: ShadowVerdictCheck[]; listedNotFailing: string[] } | null = null;
  if (report.verdict?.accepted !== true) {
    const judged = judgeRedLines(report.verdict ?? {}, acceptance);
    if (!judged.ok) return refuse(judged.detail);
    red = judged;
  }
  const listed = (report.pages ?? []).find((entry) => entry.page === pageLabel);
  if (listed === undefined) return refuse(`the shadow report does not list ${pageLabel}`);
  if (listed.mode !== "shadow") return refuse(`the shadow report lists ${pageLabel} as ${String(listed.mode)}, not shadow`);
  const end = report.window?.window?.end;
  const endAt = typeof end === "string" ? new Date(end) : null;
  if (endAt === null || Number.isNaN(endAt.getTime())) return refuse("the shadow report has no window");
  const ageMs = now.getTime() - endAt.getTime();
  if (ageMs > SWITCH_REPORT_MAX_AGE_MS) return refuse(`the shadow report's window ended ${Math.round(ageMs / 3_600_000)} h ago (> 24 h)`);
  const fingerprint = judgeShadowFingerprint(report.fingerprint, expected);
  if (!fingerprint.ok) return refuse(fingerprint.detail);
  const tail = `window ended ${endAt.toISOString()}; ${fingerprint.detail}`;
  if (red === null) {
    return {
      check: check("shadow_report", true, `accepted${acceptance === null ? "" : " (no red line to accept)"}; ${tail}`),
      redLines: null,
    };
  }
  const start = report.window?.window?.start;
  const redLines: AcceptedRedLines = {
    checks: red.checks,
    listedNotFailing: red.listedNotFailing,
    reason: acceptance!.reason.trim(),
    window: { start: typeof start === "string" ? start : null, end: endAt.toISOString() },
    generatedAt: typeof report.generatedAt === "string" ? report.generatedAt : null,
  };
  return { check: check("shadow_report", true, `not accepted; ${redLinesLine(redLines)}; ${tail}`), redLines };
}

/**
 * Every precondition of `sync switch` for one page (design §3.5 item 7). The
 * report is read through `ctx.readFile` (null: not given or unreadable).
 */
export async function checkSwitchPreconditions(
  ctx: SwitchContext,
  input: { page: SyncPageRow; shadowReportPath: string | null; acceptRedLines?: RedLinesAcceptance | null },
): Promise<{ ok: boolean; checks: SwitchCheck[]; redLines: AcceptedRedLines | null }> {
  const { db } = ctx;
  const page = (await getSyncPage(db, input.page.pageId)) ?? input.page;
  const label = page.pageLabel ?? String(page.pageId);
  const now = page.dbNow;
  const checks: SwitchCheck[] = [];

  const build = await buildIdentityCheck(ctx);
  checks.push(build.check);
  checks.push(check("live_loop", ctx.liveLoopEnabled, ctx.liveLoopEnabled
    ? "this build runs a live loop"
    : "this build has no live loop (LIVE_LOOP_ENABLED = false)"));

  const heartbeatAge = page.owner.heartbeatAt === null ? null : now.getTime() - page.owner.heartbeatAt.getTime();
  const released = page.owner.releasedAt !== null && page.owner.releaseGeneration === page.owner.generation;
  checks.push(check(
    "page_shadow",
    page.mode === "shadow" && heartbeatAge !== null && heartbeatAge <= SWITCH_OWNER_HEARTBEAT_FRESH_MS && !released,
    `mode ${page.mode}, owner generation ${page.owner.generation}, heartbeat ${heartbeatAge === null ? "never" : `${wholeSeconds(heartbeatAge)} s ago`}${released ? ", released" : ""}`,
  ));

  let reportText: string | null = null;
  if (input.shadowReportPath !== null) {
    reportText = await ctx.readFile(input.shadowReportPath).catch(() => null);
  }
  const report = shadowReportCheck(
    reportText,
    label,
    now,
    { syncBuild: build.syncBuild, policyHash: ROUTE_POLICY_HASH },
    input.acceptRedLines ?? null,
  );
  checks.push(report.check);

  const rebuild = await getLatestCompletedChainRebuild(db, page.pageId);
  checks.push(check("chain_rebuild", rebuild !== null, rebuild === null
    ? "the page's chains were never rebuilt from the journal (sync chain rebuild --page … --write)"
    : `completed ${rebuild.createdAt.toISOString()}`));

  const others = (await listSyncPages(db, { modes: ["handover"] })).filter((row) => row.pageId !== page.pageId);
  checks.push(check("no_other_handover", others.length === 0, others.length === 0
    ? "no other page is switching"
    : `in handover: ${others.map((row) => row.pageLabel ?? row.pageId).join(", ")}`));

  // The legacy night backfill (plan §15): no switch from 00:00 to 05:00 UTC.
  checks.push(check("not_night", !(ctx.inNightWindow ?? inLegacyNightWindow)(now), `database clock ${now.toISOString()} (no switch 00:00–05:00 UTC)`));

  const guard = await getFanslySendGuard(db, page.pageId);
  checks.push(check(
    "guard_row",
    guard !== null && guard.ownerEngine === "legacy" && guard.closedReason === null,
    guard === null
      ? "no send guard row"
      : `owner ${guard.ownerEngine}${guard.closedReason === null ? "" : `, closed (${guard.closedReason}): fansly-send-guard confirm-terminated`}${guard.holderToken === null ? "" : `, held by ${guard.holderSource ?? "?"}`}`,
  ));

  const latch = await getNotificationIncidentByKey(db, syncEngineIncidentKey({ subKey: "page_stopped", pageId: page.pageId }));
  checks.push(check("no_page_stopped_latch", latch?.status !== "open", latch?.status === "open"
    ? `open: ${latch.errorSummary ?? ""}`
    : "no open page_stopped latch"));

  const writer = await db.execute<{ writer: string | null }>(sql`select transactions_writer as writer from pages where id = ${page.pageId}`);
  const transactionsWriter = writer.rows[0]?.writer ?? null;
  checks.push(check("transactions_writer", transactionsWriter === "fansly", `pages.transactions_writer = ${transactionsWriter ?? "null"}`));

  const hydration = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from agent_hydration_requests r join pages p on p.id = r.page_id
     where r.page_id = ${page.pageId} and p.platform = 'fansly' and r.state in ('approved', 'dispatching')
       -- A row the engine served earlier (a history request, kept across a
       -- rollback) runs into no fence: not a legacy run to wait for.
       and r.execution_lane is distinct from ${FANSLY_SYNC_ENGINE_HYDRATION_LANE}
  `);
  const settling = Number(hydration.rows[0]?.n ?? 0);
  checks.push(check("hydration_settled", settling === 0, settling === 0
    ? "no approved or dispatching hydration request"
    : `${settling} hydration request(s) approved or dispatching: wait for them to settle`));

  const latest = await readLatestSwitchAudit(db, page.pageId);
  checks.push(check("no_unfinished_rollback", !isUnfinishedRollback(latest), isUnfinishedRollback(latest)
    ? `a rollback of this page stopped at ${latest!.stage}: finish it with sync rollback`
    : "no unfinished rollback"));

  const settingMs = await loadEffectiveConfig(db, ctx.rawConfig)
    .then((config) => config.fanslyDefaultDelayMs)
    .catch(() => null);
  checks.push(check("pause_setting", settingMs !== null, settingMs === null ? "fanslyDefaultDelayMs is unreadable" : `S = ${settingMs} ms`));

  return { ok: checks.every((entry) => entry.ok), checks, redLines: report.redLines };
}
