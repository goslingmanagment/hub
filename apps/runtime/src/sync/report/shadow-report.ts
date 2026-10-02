import { sql } from "drizzle-orm";

import type { Database, FanslyWsLivePayloadResolver, SyncPageRow } from "@agency_hub_core/db";

import type { SyncContext } from "../context.ts";
import type { EngineRegistry } from "../engine/resource.ts";
import { ScanGovernor, type ScanPacing } from "../fansly/lib/chain-rebuild.ts";
import {
  backtestEta,
  checkChains,
  REPLAY_EXCUSED_REASONS,
  replayResources,
  SEPTEMBER_16_COUNTEREXAMPLE_RAW_IDS,
  type ChainCheckReport,
  type ReplayKindReport,
} from "./shadow-journal.ts";
import { reportShadowWindow, type ShadowWindowReport } from "./shadow-window.ts";
import type { EtaBacktestPageReport } from "../requests/eta-backtest.ts";

// `pnpm cli sync shadow report` (design §3.12): the shadow acceptance's
// evidence in one JSON document with an owner-readable summary. Part A reads
// the live one-hour window in ONE read-only repeatable-read transaction (a
// consistent picture of the hour); part B reads the past journal in batches
// (read-only transactions for the replay; the chain checks and the ETA
// backtest are the dry-run scans of `sync chain …` and `sync history
// eta-backtest`). Acceptance = every page in shadow, settled, through the
// window (a window that starts before the deploy or a page's switch to shadow
// is no acceptance window), A1–A4 hold, B5 ≥ 99.9 % per resource
// (matched over every observation but legacy's own refusals; a kind with
// observations and nothing judged fails) with every mismatch listed for
// explanation, B6 lists the 16.09 counterexamples and no empty-page soundness
// hit, B7 printed.

export interface ShadowReportInput {
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
}

export interface ShadowReportVerdict {
  /** Every page in shadow, settled, through part A's window. */
  covered: boolean | null;
  a1: boolean | null;
  a2: boolean | null;
  a3: boolean | null;
  a4: boolean | null;
  b5: boolean | null;
  b6: boolean | null;
  b7: boolean | null;
  /** Every part ran to completion and every check holds. */
  accepted: boolean;
}

export interface ShadowReport {
  generatedAt: Date;
  pages: Array<{ page: string; mode: SyncPageRow["mode"] }>;
  window: ShadowWindowReport | null;
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

/** Part A inside one read-only, repeatable-read transaction. */
async function windowPart(db: Database, input: ShadowReportInput, window: { start: Date; end: Date }): Promise<ShadowWindowReport> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    return reportShadowWindow(tx, {
      window,
      pages: input.pages,
      maxListed: input.maxListed,
      ...(input.resolvePayload === undefined ? {} : { resolvePayload: input.resolvePayload }),
    });
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

export async function buildShadowReport(ctx: Pick<SyncContext, "db" | "logger">, input: ShadowReportInput): Promise<ShadowReport> {
  const window = input.window === null ? null : await windowPart(ctx.db, input, input.window);

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

  const verdict = verdictOf(window, journal, input.pages.length);
  return {
    generatedAt: new Date(),
    pages: input.pages.map((page) => ({ page: page.pageLabel ?? String(page.pageId), mode: page.mode })),
    window,
    journal,
    verdict,
    summary: summaryOf(window, journal, verdict),
  };
}

function verdictOf(window: ShadowReport["window"], journal: ShadowReport["journal"], pages: number): ShadowReportVerdict {
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
    b5,
    b6,
    b7,
  };
  // A3 without a single sampled frame is decided by the offline replay, which
  // the owner reads; every other check must hold and both parts must have run.
  const accepted = window !== null && journal !== null
    && verdict.covered === true
    && verdict.a1 === true && verdict.a2 === true && verdict.a3 !== false && verdict.a4 === true
    && b5 === true && b6 === true && b7 === true;
  return { ...verdict, accepted };
}

function summaryOf(window: ShadowReport["window"], journal: ShadowReport["journal"], verdict: ShadowReportVerdict): string[] {
  const lines: string[] = [];
  if (window !== null) {
    lines.push(`Window ${window.window.start.toISOString()} … ${window.window.end.toISOString()}`);
    const uncovered = window.coverage.filter((page) => !page.covered);
    lines.push(uncovered.length === 0
      ? "Coverage: every page in shadow from at least 10 min before the start"
      : `Coverage: NOT an acceptance window — ${uncovered.map((page) => `${page.page} ${page.reason}`
        + `${page.firstShadowAdmissionAt === null ? "" : ` (first shadow admission ${page.firstShadowAdmissionAt.toISOString()})`}`).join(", ")}; `
        + "the window must start once every page has run in shadow for 10 min");
    for (const page of window.demand) {
      lines.push(`A1 ${page.page}: steady ${page.steadyState} (band ${page.band.min}–${page.band.max}) ${page.inBand ? "ok" : "OUTSIDE"}`
        + `${page.outside.length === 0 ? "" : `; outside 0.5×–2×: ${page.outside.map((row) => row.resource).join(", ")}`}`);
    }
    const unexplained = window.legacy.filter((row) => !row.explained).map((row) => row.ref);
    lines.push(`A2 legacy volume: ${unexplained.length === 0 ? "every stream and sender explained" : `unexplained: ${unexplained.join(", ")}`}`);
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
  if (journal !== null) {
    const below = journal.replay.filter((row) => row.meetsTarget === false).map((row) => `${row.kind} `
      + (row.ratio !== null ? percent(row.ratio) : row.notReplayableReasons.no_replay === undefined ? "nothing judged" : "no replay"));
    const none = journal.replay.filter((row) => row.meetsTarget === null).map((row) => row.kind);
    lines.push(`B5 replay: ${journal.replay.reduce((total, row) => total + row.total, 0)} observations; `
      + `${below.length === 0 ? "every resource ≥ 99.9 %" : `below 99.9 %: ${below.join(", ")}`}`
      + `${none.length === 0 ? "" : `; not replayable (no observation): ${none.join(", ")}`}`);
    // What was not compared, per kind and reason: legacy's own refusals are
    // left out of the ratio, every other reason counts as not matched.
    const skipped = journal.replay.filter((row) => row.notReplayable > 0).map((row) => `${row.kind} `
      + Object.entries(row.notReplayableReasons)
        .map(([reason, count]) => `${reason} ${count}${REPLAY_EXCUSED_REASONS.has(reason) ? " (legacy refusal, left out)" : ""}`)
        .join(", "));
    if (skipped.length > 0) lines.push(`B5 not replayable: ${skipped.join("; ")}`);
    const hits = journal.chains.reduce((total, row) => total + ("error" in row.endRule ? 0 : row.endRule.emptyPageSoundness.hits.length), 0);
    lines.push(`B6 chains: 16.09 counterexamples listed ${journal.septemberSixteen.listed.length}/${journal.septemberSixteen.expected.length}, `
      + `empty-page soundness hits ${hits}`);
    lines.push(`B7 ETA: ${journal.eta.length} pages backtested`);
    if (journal.stoppedBy !== null) lines.push(`Part B stopped early: ${journal.stoppedBy}`);
  }
  lines.push(`Verdict: coverage ${mark(verdict.covered)}, A1 ${mark(verdict.a1)}, A2 ${mark(verdict.a2)}, A3 ${mark(verdict.a3)}, A4 ${mark(verdict.a4)}, `
    + `B5 ${mark(verdict.b5)}, B6 ${mark(verdict.b6)}, B7 ${mark(verdict.b7)} — ${verdict.accepted ? "ACCEPTED" : "not accepted"}`);
  return lines;
}
