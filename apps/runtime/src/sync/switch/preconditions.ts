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
  pages?: Array<{ page?: unknown; mode?: unknown }>;
  window?: { window?: { start?: unknown; end?: unknown } } | null;
  verdict?: { accepted?: unknown };
}

function check(name: string, ok: boolean, detail: string): SwitchCheck {
  return { name, ok, detail };
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

async function buildIdentityCheck(ctx: SwitchContext): Promise<SwitchCheck> {
  const result = await ctx.db.execute<{ imageTag: string | null; ageMs: number | string }>(sql`
    select image_tag as "imageTag",
           extract(epoch from clock_timestamp() - last_seen_at) * 1000 as "ageMs"
      from runtime_instances
     where role = 'sync'
     order by last_seen_at desc
     limit 1
  `);
  const row = result.rows[0];
  return judgeBuildIdentity(row === undefined ? null : { imageTag: row.imageTag, ageMs: Number(row.ageMs) }, ctx.buildSha);
}

/** The shadow report's verdict for the page (S2-13: one report-wide verdict). */
export function shadowReportCheck(text: string | null, pageLabel: string, now: Date): SwitchCheck {
  if (text === null) return check("shadow_report", false, "no shadow report (--shadow-report <path>)");
  let report: ShadowReportFile;
  try {
    report = JSON.parse(text) as ShadowReportFile;
  } catch {
    return check("shadow_report", false, "the shadow report is not JSON");
  }
  if (report.verdict?.accepted !== true) return check("shadow_report", false, "the shadow report's verdict is not accepted");
  const listed = (report.pages ?? []).find((entry) => entry.page === pageLabel);
  if (listed === undefined) return check("shadow_report", false, `the shadow report does not list ${pageLabel}`);
  if (listed.mode !== "shadow") {
    return check("shadow_report", false, `the shadow report lists ${pageLabel} as ${String(listed.mode)}, not shadow`);
  }
  const end = report.window?.window?.end;
  const endAt = typeof end === "string" ? new Date(end) : null;
  if (endAt === null || Number.isNaN(endAt.getTime())) return check("shadow_report", false, "the shadow report has no window");
  const ageMs = now.getTime() - endAt.getTime();
  if (ageMs > SWITCH_REPORT_MAX_AGE_MS) {
    return check("shadow_report", false, `the shadow report's window ended ${Math.round(ageMs / 3_600_000)} h ago (> 24 h)`);
  }
  return check("shadow_report", true, `accepted; window ended ${endAt.toISOString()}`);
}

/**
 * Every precondition of `sync switch` for one page (design §3.5 item 7). The
 * report is read through `ctx.readFile` (null: not given or unreadable).
 */
export async function checkSwitchPreconditions(
  ctx: SwitchContext,
  input: { page: SyncPageRow; shadowReportPath: string | null },
): Promise<{ ok: boolean; checks: SwitchCheck[] }> {
  const { db } = ctx;
  const page = (await getSyncPage(db, input.page.pageId)) ?? input.page;
  const label = page.pageLabel ?? String(page.pageId);
  const now = page.dbNow;
  const checks: SwitchCheck[] = [];

  checks.push(await buildIdentityCheck(ctx));
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
  checks.push(shadowReportCheck(reportText, label, now));

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

  return { ok: checks.every((entry) => entry.ok), checks };
}
