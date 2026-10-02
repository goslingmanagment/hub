import { sql } from "drizzle-orm";

import { listSyncReplayObservations, type Database, type SyncPageRow } from "@agency_hub_core/db";

import { isCapturePayloadUnavailable, resolveCapturePayloadRow } from "../../services/payload-reader.ts";
import type { SyncContext } from "../context.ts";
import type { EngineRegistry, ReplayVerdict } from "../engine/resource.ts";
import { checkEndRule, type EndRulePageReport } from "../fansly/lib/chain-checks.ts";
import {
  rebuildPageChains,
  type ChainRebuildPageReport,
  type ScanGovernor,
  type ScanPacing,
  type ScanStop,
} from "../fansly/lib/chain-rebuild.ts";
import { FANSLY_RESOURCE_SPECS } from "../fansly/registry.ts";
import { backtestPageEta, type EtaBacktestPageReport } from "../requests/eta-backtest.ts";

// The shadow report, part B (design §3.12): the past journal, independent of
// the live window. B5 replays the legacy observations of every resource
// through its new wire contract and intended effects (≥ 99.9 % per resource,
// every mismatch listed), B6 rebuilds the DM chains from the whole `/message`
// journal and checks the end-of-history rule (the 16.09 counterexamples must
// be listed, no empty-page soundness hit), B7 measures the ETA on the journal.
// Read-only and batched; the scans stop at the legacy night window or the
// run's budget (the governor), and say so.

/** The share of each resource's replayed observations that must match. */
export const REPLAY_MATCH_TARGET = 0.999;
/** The 16.09 end-of-history counterexamples (raw 2975891 and 2975902: a head
 *  of 24 of 25 between full pages, design §8.3). */
export const SEPTEMBER_16_COUNTEREXAMPLE_RAW_IDS: readonly number[] = [2975891, 2975902];

type JournalContext = Pick<SyncContext, "db" | "logger">;

export interface ReplayKindReport {
  resource: string;
  kind: string;
  total: number;
  matched: number;
  mismatched: number;
  notReplayable: number;
  /** matched / (matched + mismatched); null when nothing was comparable. */
  ratio: number | null;
  meetsTarget: boolean | null;
  oldestReceivedAt: Date | null;
  stoppedBy: ScanStop | null;
  mismatches: Array<{ observationId: number; page: string; reason: string; detail?: Readonly<Record<string, unknown>> }>;
  notReplayableReasons: Record<string, number>;
}

export interface ReplayInput {
  pages: readonly SyncPageRow[];
  registry: Pick<EngineRegistry, "module">;
  /** Replay every observation received since … */
  since: Date;
  /** … and at least this many of each kind (older ones when fewer exist since). */
  minPerKind: number;
  /** A kind's run stops after this many (the report says so). */
  maxPerKind: number;
  batchRows: number;
  maxListed: number;
}

function pageName(pages: readonly SyncPageRow[], pageId: number): string {
  const page = pages.find((row) => row.pageId === pageId);
  return page?.pageLabel ?? String(pageId);
}

/** A SQLSTATE when the driver gives one (drizzle wraps it in `cause`), else
 *  the error's class: driver messages embed SQL and parameters. */
function errorName(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = current.cause;
  }
  return error instanceof Error ? error.name : "unknown";
}

/** B5: every kind a resource owns, replayed newest first. */
export async function replayResources(
  ctx: JournalContext,
  input: ReplayInput,
  governor: ScanGovernor,
): Promise<ReplayKindReport[]> {
  const pageIds = input.pages.map((page) => page.pageId);
  const reports: ReplayKindReport[] = [];
  const seen = new Set<string>();
  for (const spec of FANSLY_RESOURCE_SPECS) {
    for (const kind of spec.replayKinds ?? []) {
      if (seen.has(kind)) continue;
      seen.add(kind);
      const report: ReplayKindReport = {
        resource: spec.key,
        kind,
        total: 0,
        matched: 0,
        mismatched: 0,
        notReplayable: 0,
        ratio: null,
        meetsTarget: null,
        oldestReceivedAt: null,
        stoppedBy: null,
        mismatches: [],
        notReplayableReasons: {},
      };
      reports.push(report);
      const module = await input.registry.module(spec.key);
      if (module.replay === undefined) {
        report.notReplayableReasons.no_replay = 1;
        continue;
      }
      const replay = module.replay.bind(module);
      let before: { receivedAt: Date; id: number } | null = null;
      let done = false;
      while (!done && report.total < input.maxPerKind) {
        report.stoppedBy = governor.stopReason();
        if (report.stoppedBy !== null) break;
        const rows = await listSyncReplayObservations(ctx.db, { kind, pageIds, before, limit: input.batchRows });
        if (rows.length === 0) break;
        // One read-only transaction per batch; one savepoint per observation,
        // so a replay that fails (or tries to write) costs only its verdict.
        await ctx.db.transaction(async (raw) => {
          const tx = raw as unknown as Database;
          await tx.execute(sql`set transaction read only`);
          for (const row of rows) {
            if ((row.receivedAt < input.since && report.total >= input.minPerKind) || report.total >= input.maxPerKind) {
              done = true;
              return;
            }
            report.total += 1;
            report.oldestReceivedAt = row.receivedAt;
            let verdict: ReplayVerdict;
            try {
              verdict = await tx.transaction(async (savepoint) => {
                const db = savepoint as unknown as Database;
                const resolved = await resolveCapturePayloadRow({ db, logger: ctx.logger }, "observation", row.id, row);
                return replay(
                  { id: row.id, receivedAt: row.receivedAt, kind: row.kind, pageId: row.pageId, payload: resolved.payload },
                  { db, pageId: row.pageId },
                );
              });
            } catch (error) {
              verdict = isCapturePayloadUnavailable(error)
                ? { kind: "not_replayable", reason: "body_unavailable" }
                : { kind: "mismatch", reason: `replay_failed:${errorName(error)}` };
            }
            if (verdict.kind === "match") report.matched += 1;
            else if (verdict.kind === "not_replayable") {
              report.notReplayable += 1;
              report.notReplayableReasons[verdict.reason] = (report.notReplayableReasons[verdict.reason] ?? 0) + 1;
            } else {
              report.mismatched += 1;
              if (report.mismatches.length < input.maxListed) {
                report.mismatches.push({
                  observationId: row.id,
                  page: pageName(input.pages, row.pageId),
                  reason: verdict.reason,
                  ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
                });
              }
            }
          }
        });
        const last = rows.at(-1)!;
        before = { receivedAt: last.receivedAt, id: last.id };
        if (rows.length < input.batchRows) break;
        await governor.pause();
      }
      const comparable = report.matched + report.mismatched;
      report.ratio = comparable === 0 ? null : report.matched / comparable;
      report.meetsTarget = report.ratio === null ? null : report.ratio >= REPLAY_MATCH_TARGET;
      if (report.total === 0) report.notReplayableReasons.no_observation = 1;
    }
  }
  return reports;
}

export interface ChainCheckReport {
  page: string;
  rebuild: Pick<ChainRebuildPageReport, "scan" | "threads"> | { error: string };
  endRule: Pick<EndRulePageReport, "scan" | "shortPages" | "emptyPageSoundness" | "legacyVerdicts"> | { error: string };
}

/** B6: the dry-run rebuild of every page's chains from the whole journal and
 *  the end-of-history check. */
export async function checkChains(
  ctx: JournalContext,
  input: { pages: readonly SyncPageRow[]; since: Date; pacing: ScanPacing; maxListed: number },
  governor: ScanGovernor,
): Promise<ChainCheckReport[]> {
  const reports: ChainCheckReport[] = [];
  for (const page of input.pages) {
    if (governor.stopReason() !== null) break;
    const rebuild = await rebuildPageChains(ctx, { ...input.pacing, pageId: page.pageId, write: false, full: true }, governor)
      .then((report) => ({ scan: report.scan, threads: report.threads }), (error: unknown) => ({ error: errorName(error) }));
    const endRule = await checkEndRule(ctx, { ...input.pacing, pageId: page.pageId, since: input.since, maxListed: input.maxListed }, governor)
      .then((report) => ({
        scan: report.scan,
        shortPages: report.shortPages,
        emptyPageSoundness: report.emptyPageSoundness,
        legacyVerdicts: report.legacyVerdicts,
      }), (error: unknown) => ({ error: errorName(error) }));
    reports.push({ page: page.pageLabel ?? String(page.pageId), rebuild, endRule });
  }
  return reports;
}

/** B7: the ETA's fact over forecast on the journal, page by page. */
export async function backtestEta(
  ctx: JournalContext,
  input: { pages: readonly SyncPageRow[]; since: Date; pacing: ScanPacing; maxListed: number },
  governor: ScanGovernor,
): Promise<Array<EtaBacktestPageReport | { pageId: number; error: string }>> {
  const reports: Array<EtaBacktestPageReport | { pageId: number; error: string }> = [];
  for (const page of input.pages) {
    if (governor.stopReason() !== null) break;
    reports.push(await backtestPageEta(ctx, { ...input.pacing, pageId: page.pageId, since: input.since, maxListed: input.maxListed }, governor)
      .catch((error: unknown) => ({ pageId: page.pageId, error: errorName(error) })));
  }
  return reports;
}
