import { dmReaderStoreOf, getSyncPage, listPageThreadChains, readThreadStoredFacts } from "@agency_hub_core/db";
import { fanslySnowflakeToDate } from "@agency_hub_core/shared";

import {
  foldJournalEntry,
  initialFoldState,
  legacyJournalBatches,
  newFoldCounters,
  ScanGovernor,
  type JournalEntry,
  type ScanPacing,
  type ScanStop,
  type SyncChainContext,
} from "../fansly/lib/chain-rebuild.ts";
import { estimateItemReads, type ItemEtaFacts } from "./eta.ts";

// The ETA error on the journal (design §7.2.4, a step-2 acceptance item;
// read-only, no Fansly request): every chain the legacy `/message` journal
// proves complete (an empty page at `before = contiguous oldest`) is replayed
// as if a request `all` had been filed when only its head page was known —
// density from that head page's time span — and the estimate is compared with
// the reads the walk really took below the head (each page that extended the
// chain down, plus the empty page that proved the start). The report is the
// fact / forecast distribution per page; there is no threshold (plan §17:
// quality is a metric).

const DECIMAL = /^[0-9]{1,30}$/;

interface ThreadTrace {
  /** The head page that started the chain. */
  headRawId: number;
  headCount: number;
  headNewestMs: number | null;
  headOldestMs: number | null;
  /** Reads below the head so far. */
  readsBelow: number;
}

export interface EtaBacktestSample {
  threadId: number;
  groupId: string;
  headRawId: number;
  provedRawId: number;
  headMessages: number;
  /** Reads the journal took from the head page to the proving empty page. */
  fact: number;
  readsMin: number;
  readsEstimate: number | null;
  /** fact / readsEstimate (null without an estimate). */
  ratio: number | null;
}

export interface Quantiles {
  p10: number;
  p50: number;
  p90: number;
}

export interface EtaBacktestPageReport {
  pageId: number;
  pageLabel: string | null;
  scan: { rowsScanned: number; batches: number; throughRawId: number; completed: boolean; stoppedBy: ScanStop | null };
  chains: { proven: number; sampled: number; withoutEstimate: number; emptyChats: number };
  /** Distribution of fact / forecast over the sampled chains. */
  factOverEstimate: Quantiles | null;
  /** Chains whose fact fell below the lower bound (expected 0). */
  belowLowerBound: number;
  examples: EtaBacktestSample[];
}

/** Nearest-rank quantiles of a non-empty sample. */
export function quantiles(values: readonly number[]): Quantiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9) };
}

/** The estimate as it would have been with only the head page known. */
export function backtestEstimate(trace: Pick<ThreadTrace, "headCount" | "headNewestMs" | "headOldestMs">, groupId: string, now: Date) {
  const oldest = trace.headOldestMs === null ? null : new Date(trace.headOldestMs);
  const facts: ItemEtaFacts = {
    complete: false,
    chainCount: trace.headCount,
    chainOldestAt: oldest,
    storedCount: trace.headCount,
    storedNewestAt: trace.headNewestMs === null ? null : new Date(trace.headNewestMs),
    storedOldestAt: oldest,
    chatStartAt: DECIMAL.test(groupId) ? fanslySnowflakeToDate(groupId) : null,
  };
  return estimateItemReads({ depth: { kind: "all" }, anchored: true, belowAnchor: trace.headCount, facts, now });
}

function headTrace(entry: JournalEntry): ThreadTrace | null {
  if (entry.result.kind !== "page") return null;
  const times = entry.result.page.createdAtMs.filter((ms): ms is number => ms !== null);
  return {
    headRawId: entry.rawId,
    headCount: entry.result.page.ids.length,
    headNewestMs: times.length === 0 ? null : Math.max(...times),
    headOldestMs: times.length === 0 ? null : Math.min(...times),
    readsBelow: 0,
  };
}

export interface EtaBacktestOptions extends ScanPacing {
  pageId: number;
  since?: Date;
  maxListed: number;
}

/** Backtest the ETA over one page's legacy journal (read-only). */
export async function backtestPageEta(
  app: SyncChainContext,
  options: EtaBacktestOptions,
  governor: ScanGovernor = new ScanGovernor(options),
): Promise<EtaBacktestPageReport> {
  const page = await getSyncPage(app.db, options.pageId);
  const threads = await listPageThreadChains(app.db, { pageId: options.pageId });
  // From empty chains: what the journal alone proves (legacy coverage and any
  // earlier rebuild are not trusted, as in the rebuild's scratch fold).
  const book = new Map(threads.map((row) => [row.groupId, initialFoldState(row, "scratch")]));
  // The walk being traced per chat; null once its chain was proven (a later
  // head page of the chat starts a new trace).
  const traces = new Map<string, ThreadTrace | null>();
  const counters = newFoldCounters();
  const samples: EtaBacktestSample[] = [];
  const report: EtaBacktestPageReport = {
    pageId: options.pageId,
    pageLabel: page?.pageLabel ?? null,
    scan: { rowsScanned: 0, batches: 0, throughRawId: 0, completed: false, stoppedBy: governor.stopReason() },
    chains: { proven: 0, sampled: 0, withoutEstimate: 0, emptyChats: 0 },
    factOverEstimate: null,
    belowLowerBound: 0,
    examples: [],
  };
  const store = dmReaderStoreOf(page?.mode);
  const readStored = (threadId: number) => readThreadStoredFacts(app.db, threadId, { store });
  const now = new Date();
  if (report.scan.stoppedBy === null) {
    for await (const batch of legacyJournalBatches(app, {
      pageId: options.pageId,
      afterId: 0,
      batchRows: options.batchRows,
      ...(options.since === undefined ? {} : { since: options.since }),
    })) {
      for (const entry of batch.entries) {
        const folded = await foldJournalEntry(book, entry, counters, readStored);
        if (folded === null) continue;
        const { state, fold } = folded;
        const verdict = fold.verdict;
        if (verdict.kind === "started") {
          const trace = headTrace(entry);
          if (trace !== null) traces.set(state.groupId, trace);
          continue;
        }
        const trace = traces.get(state.groupId) ?? null;
        if (verdict.kind === "extended_down") {
          if (trace !== null) trace.readsBelow += 1;
          continue;
        }
        if (verdict.kind !== "completed") continue;
        report.chains.proven += 1;
        if (verdict.via === "empty_head") report.chains.emptyChats += 1;
        traces.set(state.groupId, null);
        if (verdict.via !== "empty_page" || trace === null) continue;
        const estimate = backtestEstimate(trace, state.groupId, now);
        const fact = trace.readsBelow + 1;
        const sample: EtaBacktestSample = {
          threadId: state.threadId,
          groupId: state.groupId,
          headRawId: trace.headRawId,
          provedRawId: entry.rawId,
          headMessages: trace.headCount,
          fact,
          readsMin: estimate.readsMin,
          readsEstimate: estimate.readsEstimate,
          ratio: estimate.readsEstimate === null || estimate.readsEstimate === 0 ? null : fact / estimate.readsEstimate,
        };
        samples.push(sample);
        if (fact < estimate.readsMin) report.belowLowerBound += 1;
      }
      report.scan.rowsScanned += batch.entries.length;
      report.scan.batches += 1;
      report.scan.throughRawId = batch.throughRawId;
      if (batch.exhausted) {
        report.scan.completed = true;
        break;
      }
      report.scan.stoppedBy = governor.stopReason();
      if (report.scan.stoppedBy !== null) break;
      await governor.pause();
    }
  }
  const ratios = samples.flatMap((sample) => (sample.ratio === null ? [] : [sample.ratio]));
  report.chains.sampled = samples.length;
  report.chains.withoutEstimate = samples.length - ratios.length;
  const q = quantiles(ratios);
  report.factOverEstimate = q === null
    ? null
    : { p10: Math.round(q.p10 * 100) / 100, p50: Math.round(q.p50 * 100) / 100, p90: Math.round(q.p90 * 100) / 100 };
  // The worst forecasts both ways, for the owner to read.
  const ranked = samples.filter((sample) => sample.ratio !== null).sort((a, b) => a.ratio! - b.ratio!);
  const half = Math.max(1, Math.floor(options.maxListed / 2));
  report.examples = ranked.length <= options.maxListed ? ranked : [...ranked.slice(0, half), ...ranked.slice(-half)];
  return report;
}
