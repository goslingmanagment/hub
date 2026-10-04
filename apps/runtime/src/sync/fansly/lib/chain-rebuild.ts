import { setTimeout as delay } from "node:timers/promises";

import {
  getLatestCompletedChainRebuild,
  getSyncPage,
  listLegacyDmJournalRows,
  listPageThreadChains,
  readThreadStoredFacts,
  SYNC_CHAIN_REBUILD_AUDIT_EVENT,
  writeRebuiltThreadChain,
  type LegacyDmJournalRow,
  type SyncPageMode,
  type ThreadChainRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";
import { recordAudit, type AuditContext } from "../../../services/auth.ts";
import { createCapturePayloadRowResolver, isCapturePayloadUnavailable } from "../../../services/payload-reader.ts";
import {
  chainPageNeedsStoredFacts,
  emptyChain,
  foldChainPage,
  type ChainCompletion,
  type ChainFold,
  type ChainPage,
  type ChainVerdict,
  type Segment,
  type ThreadChain,
} from "./chain.ts";

// Fansly Sync Engine (plan §6.3, design §8.2): DM chains re-proved LOCALLY
// from the legacy journal — the `/message` pages in `sync_raw_payloads` since
// 2026-07-05, each with its own request parameters — by the same fold the
// engine runs online (chain.ts). No request reaches Fansly.
//
// What it writes (`--write`; a dry run writes nothing): only the chain columns
// of `page_dm_threads`, through `writeRebuiltThreadChain` — never a legacy
// coverage column, so pages the legacy engine owns see no change. Never on a
// `handover`/`live` page (the engine is the chain writer there, I9), never over
// a chain the engine wrote, never between 00:00 and 05:00 UTC (the legacy night
// backfill window) unless forced.
//
// Initial chains are empty: legacy coverage is not trusted. A thread that
// holds messages and has no head page in the journal stays `unverified`. A
// body the catalog cannot serve is skipped and counted; the fold then simply
// cannot continue a walk past it (the next page's cursor no longer matches).
// A head walk still staged when a run ends is not persisted (D18).

export type SyncChainContext = Pick<AppContext, "db" | "logger">;

/** Why a journal row folds nothing. */
export const JOURNAL_SKIP_REASONS = [
  "no_params",
  "contract_rejected",
  "no_messages_array",
  "body_unavailable",
  "unknown_thread",
  "engine_owned",
  "already_folded",
  "conflicted",
] as const;
export type JournalSkipReason = (typeof JOURNAL_SKIP_REASONS)[number];

export type JournalEntryResult =
  | { kind: "page"; groupId: string; page: ChainPage }
  | { kind: "skip"; reason: Extract<JournalSkipReason, "no_params" | "contract_rejected" | "no_messages_array" | "body_unavailable">; groupId: string | null };

export interface JournalEntry {
  rawId: number;
  capturedAt: Date;
  result: JournalEntryResult;
}

const DECIMAL = /^[0-9]{1,30}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Request parameters of a journal row: `{groupId, limit, before?}`. Rows
 *  captured before 2026-07-05 carry none and fold nothing. */
export function parseJournalParams(value: unknown): { groupId: string; limit: number; before: string | null } | null {
  if (!isRecord(value)) return null;
  const { groupId, limit, before } = value;
  if (typeof groupId !== "string" || !DECIMAL.test(groupId)) return null;
  const parsedLimit = typeof limit === "number" ? limit : typeof limit === "string" && /^[0-9]{1,6}$/.test(limit) ? Number(limit) : NaN;
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1) return null;
  if (before !== undefined && before !== null && typeof before !== "string") return null;
  return { groupId, limit: parsedLimit, before: typeof before === "string" ? before : null };
}

/** `createdAt` of a Fansly message (seconds, or ms when ≥ 10^12, the legacy
 *  normalization) in ms; null when absent or not a number. */
export function messageCreatedAtMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value >= 1_000_000_000_000 ? value : value * 1000;
}

/**
 * One journal row as a chain page (or why it is not one). `body` is the
 * resolved response (`{messages: [...]}`), or the `{contractAccepted: false}`
 * envelope the legacy lane journals for a refused body. A message without a
 * string id makes the page fail the contract (`bad_id`), it is not dropped.
 */
export function journalEntryFromRow(
  row: Pick<LegacyDmJournalRow, "id" | "requestParams" | "capturedAt">,
  body: unknown,
): JournalEntry {
  const params = parseJournalParams(row.requestParams);
  const base = { rawId: row.id, capturedAt: row.capturedAt };
  if (params === null) return { ...base, result: { kind: "skip", reason: "no_params", groupId: null } };
  if (isRecord(body) && body.contractAccepted === false) {
    return { ...base, result: { kind: "skip", reason: "contract_rejected", groupId: params.groupId } };
  }
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return { ...base, result: { kind: "skip", reason: "no_messages_array", groupId: params.groupId } };
  }
  const ids: string[] = [];
  const createdAtMs: (number | null)[] = [];
  for (const message of body.messages) {
    ids.push(isRecord(message) && typeof message.id === "string" ? message.id : "");
    createdAtMs.push(isRecord(message) ? messageCreatedAtMs(message.createdAt) : null);
  }
  return {
    ...base,
    result: {
      kind: "page",
      groupId: params.groupId,
      page: {
        before: params.before,
        limit: params.limit,
        ids,
        createdAtMs,
        capturedAt: row.capturedAt,
        witness: { kind: "raw", rawPayloadId: row.id },
      },
    },
  };
}

export interface JournalBatch {
  entries: JournalEntry[];
  /** The last journal id this batch scanned (the cursor of the next one). */
  throughRawId: number;
  /** No more rows after this batch (at the time of the read). */
  exhausted: boolean;
}

/**
 * The legacy `/message` journal of one page in id order, `batchRows` rows at a
 * time, bodies resolved through the payload seam (production rows are
 * pointer-only). Rows without parameters are not resolved at all.
 */
export async function* legacyJournalBatches(
  app: SyncChainContext,
  input: { pageId: number; afterId: number; batchRows: number; groupId?: string; since?: Date },
): AsyncGenerator<JournalBatch> {
  let cursor = input.afterId;
  for (;;) {
    const rows = await listLegacyDmJournalRows(app.db, {
      pageId: input.pageId,
      afterId: cursor,
      limit: input.batchRows,
      ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
      ...(input.since === undefined ? {} : { since: input.since }),
    });
    const resolvable = rows.filter((row) => parseJournalParams(row.requestParams) !== null);
    const resolve = createCapturePayloadRowResolver(app, "raw_payload", resolvable);
    const entries: JournalEntry[] = [];
    for (const row of rows) {
      if (parseJournalParams(row.requestParams) === null) {
        entries.push(journalEntryFromRow(row, null));
        continue;
      }
      try {
        entries.push(journalEntryFromRow(row, (await resolve(row)).payload));
      } catch (error) {
        if (!isCapturePayloadUnavailable(error)) throw error;
        const params = parseJournalParams(row.requestParams);
        entries.push({
          rawId: row.id,
          capturedAt: row.capturedAt,
          result: { kind: "skip", reason: "body_unavailable", groupId: params?.groupId ?? null },
        });
      }
    }
    if (rows.length > 0) cursor = rows[rows.length - 1]!.id;
    const exhausted = rows.length < input.batchRows;
    yield { entries, throughRawId: cursor, exhausted };
    if (exhausted) return;
  }
}

// ── run pacing ────────────────────────────────────────────────────────────────

/** 00:00–05:00 UTC: the legacy night backfill window. */
export function inLegacyNightWindow(now: Date): boolean {
  return now.getUTCHours() < 5;
}

export type ScanStop = "max_duration" | "night_window";

export interface ScanPacing {
  batchRows: number;
  sleepMs: number;
  /** Wall-clock budget of the whole run; null = none. */
  maxDurationMs: number | null;
  forceWindow: boolean;
  now?: () => Date;
}

export class ScanGovernor {
  private readonly startedAt: number;
  private readonly now: () => Date;

  constructor(private readonly pacing: ScanPacing) {
    this.now = pacing.now ?? (() => new Date());
    this.startedAt = this.now().getTime();
  }

  /** Why the scan must stop now, or null. */
  stopReason(): ScanStop | null {
    const now = this.now();
    if (!this.pacing.forceWindow && inLegacyNightWindow(now)) return "night_window";
    if (this.pacing.maxDurationMs !== null && now.getTime() - this.startedAt >= this.pacing.maxDurationMs) {
      return "max_duration";
    }
    return null;
  }

  async pause(): Promise<void> {
    if (this.pacing.sleepMs > 0) await delay(this.pacing.sleepMs);
  }
}

// ── the fold book ─────────────────────────────────────────────────────────────

type VerdictKind = ChainVerdict["kind"];

const VERDICT_KINDS: readonly VerdictKind[] = [
  "started", "head_unchanged", "staged", "joined", "extended_down", "completed", "segment_stale",
  "segment_dropped_by_head", "not_continuing", "anomaly", "contract_violation",
];

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

export interface ChainFoldCounters {
  folded: number;
  skipped: Record<JournalSkipReason, number>;
  verdicts: Record<VerdictKind, number>;
  completions: Record<ChainCompletion, number>;
  anomalies: Record<string, number>;
  contractViolations: Record<string, number>;
  examples: { anomalies: ExampleRow[]; contractViolations: ExampleRow[] };
}

export interface ExampleRow { rawId: number; groupId: string; reason: string }

const MAX_EXAMPLES = 20;

export function newFoldCounters(): ChainFoldCounters {
  return {
    folded: 0,
    skipped: zeroCounts(JOURNAL_SKIP_REASONS),
    verdicts: zeroCounts(VERDICT_KINDS),
    completions: zeroCounts<ChainCompletion>(["empty_page", "empty_head", "segment_empty_page"]),
    anomalies: {},
    contractViolations: {},
    examples: { anomalies: [], contractViolations: [] },
  };
}

function countVerdict(counters: ChainFoldCounters, verdict: ChainVerdict, rawId: number, groupId: string): void {
  counters.verdicts[verdict.kind] += 1;
  if (verdict.kind === "completed") counters.completions[verdict.via] += 1;
  if (verdict.kind === "anomaly") {
    counters.anomalies[verdict.reason] = (counters.anomalies[verdict.reason] ?? 0) + 1;
    if (counters.examples.anomalies.length < MAX_EXAMPLES) {
      counters.examples.anomalies.push({ rawId, groupId, reason: verdict.reason });
    }
  }
  if (verdict.kind === "contract_violation") {
    counters.contractViolations[verdict.reason] = (counters.contractViolations[verdict.reason] ?? 0) + 1;
    if (counters.examples.contractViolations.length < MAX_EXAMPLES) {
      counters.examples.contractViolations.push({ rawId, groupId, reason: verdict.reason });
    }
  }
}

export interface ThreadFoldState {
  threadId: number;
  groupId: string;
  chain: ThreadChain;
  segment: Segment | null;
  /** Journal ids at or below this were folded by an earlier run. */
  foldedThrough: number;
  /** The watermark the database holds (the optimistic check of a write). */
  storedWatermark: number;
  engineOwned: boolean;
  conflicted: boolean;
  dirty: boolean;
  /** Written at least once by this run. */
  written: boolean;
  foldedPages: number;
  /** How the chain was last completed in this run. */
  completedVia: ChainCompletion | null;
  storedMessageCount: number;
  legacyCoverageStatus: ThreadChainRow["messageCoverageStatus"];
}

/** The chain a run starts from for one thread (§8.2): empty (legacy coverage
 *  is not trusted) unless an earlier rebuild left one and the run is
 *  incremental. A full run replaces an existing chain under a new epoch. */
export function initialFoldState(row: ThreadChainRow, mode: "incremental" | "full" | "scratch"): ThreadFoldState {
  const unverified = row.storedMessageCount > 0 || row.chain.state === "unverified";
  const resume = mode === "incremental" && row.source === "journal_rebuild" && row.journalWatermark > 0;
  const hadChain = row.chain.count > 0 || row.chain.state === "complete" || row.chain.state === "partial";
  const chain: ThreadChain = resume
    ? { ...row.chain }
    : emptyChain(unverified ? "unverified" : "none", row.chain.epoch + (mode === "full" && hadChain ? 1 : 0));
  return {
    threadId: row.threadId,
    groupId: row.groupId,
    chain,
    segment: null,
    foldedThrough: resume ? row.journalWatermark : 0,
    storedWatermark: row.journalWatermark,
    engineOwned: mode !== "scratch" && row.source === "engine",
    conflicted: false,
    dirty: false,
    written: false,
    foldedPages: 0,
    completedVia: null,
    storedMessageCount: row.storedMessageCount,
    legacyCoverageStatus: row.messageCoverageStatus,
  };
}

export type StoredFactsReader = (threadId: number) => Promise<{ nonDeletedCount: number; oldestNonDeletedId: string | null }>;

/**
 * Fold one journal entry into the book: skips are counted, a page is folded
 * into its thread's chain (StoredFacts read only for empty pages). Returns the
 * thread and its fold, or null when the entry was skipped.
 */
export async function foldJournalEntry(
  book: Map<string, ThreadFoldState>,
  entry: JournalEntry,
  counters: ChainFoldCounters,
  readStored: StoredFactsReader,
): Promise<{ state: ThreadFoldState; fold: ChainFold } | null> {
  const { result } = entry;
  if (result.kind === "skip") {
    counters.skipped[result.reason] += 1;
    return null;
  }
  const state = book.get(result.groupId);
  if (state === undefined) {
    counters.skipped.unknown_thread += 1;
    return null;
  }
  const skip: JournalSkipReason | null = state.engineOwned ? "engine_owned"
    : state.conflicted ? "conflicted"
      : entry.rawId <= state.foldedThrough ? "already_folded" : null;
  if (skip !== null) {
    counters.skipped[skip] += 1;
    return null;
  }
  const stored = chainPageNeedsStoredFacts(result.page) ? await readStored(state.threadId) : null;
  const fold = foldChainPage(state.chain, state.segment, result.page, stored);
  counters.folded += 1;
  countVerdict(counters, fold.verdict, entry.rawId, result.groupId);
  for (const reported of fold.reported) countVerdict(counters, reported, entry.rawId, result.groupId);
  if (fold.verdict.kind === "completed") state.completedVia = fold.verdict.via;
  state.chain = fold.chain;
  state.segment = fold.segment;
  state.dirty = true;
  state.foldedPages += 1;
  return { state, fold };
}

// ── the rebuild ───────────────────────────────────────────────────────────────

export interface ChainRebuildOptions extends ScanPacing {
  pageId: number;
  /** One thread only (page_dm_threads.id); its run never counts as the page's. */
  threadId?: number;
  write: boolean;
  /** Ignore earlier rebuilds: fold the whole journal from empty chains. */
  full: boolean;
  audit?: AuditContext;
  /** Progress after every batch (the CLI prints it). */
  onBatch?: (progress: { pageId: number; throughRawId: number; rowsScanned: number; batches: number }) => void;
}

export interface ChainRebuildThreadSummary {
  folded: number;
  complete: number;
  completeVia: Record<ChainCompletion | "earlier_run", number>;
  partial: number;
  unverified: number;
  none: number;
  written: number;
  skipped: { engine_owned: number; concurrent_write: number; thread_missing: number };
  epochChanged: number;
}

export interface ChainRebuildPageReport {
  pageId: number;
  pageLabel: string | null;
  mode: SyncPageMode | "no_sync_page";
  write: boolean;
  full: boolean;
  threadId: number | null;
  scan: {
    fromRawId: number;
    throughRawId: number;
    rowsScanned: number;
    batches: number;
    completed: boolean;
    stoppedBy: ScanStop | null;
  };
  rows: ChainFoldCounters;
  threads: ChainRebuildThreadSummary;
}

/** The rebuild refuses a page the engine owns (I9). */
export class ChainRebuildRefusedError extends Error {
  constructor(readonly pageId: number, readonly mode: SyncPageMode) {
    super(
      `sync chain rebuild: page ${pageId} is '${mode}' — the Fansly Sync Engine is the only chain writer there `
        + "(the rebuild runs on 'off' and 'shadow' pages)",
    );
    this.name = "ChainRebuildRefusedError";
  }
}

/**
 * Rebuild the chains of one page (or one thread) from the legacy journal.
 * Incremental by default: the scan starts after the page's last completed
 * page-wide `--write` run, and a thread resumes from its stored chain past its
 * own watermark. With `write`, folded threads are written after every batch
 * (each in its own short transaction) and the run leaves an audit event; a
 * page-wide run that reached the end of the journal is the page's completed
 * rebuild.
 */
export async function rebuildPageChains(
  app: SyncChainContext,
  options: ChainRebuildOptions,
  governor: ScanGovernor = new ScanGovernor(options),
): Promise<ChainRebuildPageReport> {
  const syncPage = await getSyncPage(app.db, options.pageId);
  const mode: SyncPageMode | "no_sync_page" = syncPage?.mode ?? "no_sync_page";
  if (mode === "handover" || mode === "live") {
    throw new ChainRebuildRefusedError(options.pageId, mode);
  }

  const threads = await listPageThreadChains(app.db, {
    pageId: options.pageId,
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
  });
  if (options.threadId !== undefined && threads.length === 0) {
    throw new Error(`sync chain rebuild: thread ${options.threadId} is not a thread of page ${options.pageId}`);
  }
  const foldMode = options.full ? "full" : "incremental";
  const book = new Map(threads.map((row) => [row.groupId, initialFoldState(row, foldMode)]));
  const latest = options.full ? null : await getLatestCompletedChainRebuild(app.db, options.pageId);
  const fromRawId = latest?.throughRawId ?? 0;
  const counters = newFoldCounters();
  const summary: ChainRebuildThreadSummary = {
    folded: 0,
    complete: 0,
    completeVia: { empty_page: 0, empty_head: 0, segment_empty_page: 0, earlier_run: 0 },
    partial: 0,
    unverified: 0,
    none: 0,
    written: 0,
    skipped: { engine_owned: 0, concurrent_write: 0, thread_missing: 0 },
    epochChanged: 0,
  };
  const scan: ChainRebuildPageReport["scan"] = {
    fromRawId,
    throughRawId: fromRawId,
    rowsScanned: 0,
    batches: 0,
    completed: false,
    stoppedBy: null,
  };
  const readStored = (threadId: number) => readThreadStoredFacts(app.db, threadId);

  const flush = async (throughRawId: number) => {
    if (!options.write) return;
    for (const state of book.values()) {
      if (!state.dirty || state.engineOwned || state.conflicted) continue;
      const written = await writeRebuiltThreadChain(app.db, {
        pageId: options.pageId,
        threadId: state.threadId,
        chain: state.chain,
        expectedWatermark: state.storedWatermark,
        journalWatermark: throughRawId,
      });
      state.dirty = false;
      if (written.kind === "written") {
        state.written = true;
        state.storedWatermark = Math.max(state.storedWatermark, throughRawId);
        if (written.epochChanged) summary.epochChanged += 1;
        continue;
      }
      summary.skipped[written.reason] += 1;
      if (written.reason === "engine_owned") state.engineOwned = true;
      else state.conflicted = true;
    }
  };

  scan.stoppedBy = governor.stopReason();
  if (scan.stoppedBy === null) {
    const groupId = options.threadId === undefined ? undefined : threads[0]!.groupId;
    for await (const batch of legacyJournalBatches(app, {
      pageId: options.pageId,
      afterId: fromRawId,
      batchRows: options.batchRows,
      ...(groupId === undefined ? {} : { groupId }),
    })) {
      for (const entry of batch.entries) await foldJournalEntry(book, entry, counters, readStored);
      scan.rowsScanned += batch.entries.length;
      scan.batches += 1;
      scan.throughRawId = batch.throughRawId;
      await flush(batch.throughRawId);
      options.onBatch?.({
        pageId: options.pageId,
        throughRawId: scan.throughRawId,
        rowsScanned: scan.rowsScanned,
        batches: scan.batches,
      });
      if (batch.exhausted) {
        scan.completed = true;
        break;
      }
      scan.stoppedBy = governor.stopReason();
      if (scan.stoppedBy !== null) break;
      await governor.pause();
    }
  }

  for (const state of book.values()) {
    if (state.written) summary.written += 1;
    if (state.foldedPages === 0) continue;
    summary.folded += 1;
    if (state.chain.state === "complete") {
      summary.complete += 1;
      summary.completeVia[state.completedVia ?? "earlier_run"] += 1;
    } else {
      summary[state.chain.state] += 1;
    }
  }

  const report: ChainRebuildPageReport = {
    pageId: options.pageId,
    pageLabel: syncPage?.pageLabel ?? null,
    mode,
    write: options.write,
    full: options.full,
    threadId: options.threadId ?? null,
    scan,
    rows: counters,
    threads: summary,
  };
  if (options.write) {
    await recordAudit(app, {
      ...(options.audit ?? { source: "cli", actorUserId: null }),
      eventType: SYNC_CHAIN_REBUILD_AUDIT_EVENT,
      platformAccountId: options.pageId,
      metadata: {
        scope: options.threadId === undefined ? "page" : "thread",
        threadId: options.threadId ?? null,
        full: options.full,
        completed: scan.completed,
        stoppedBy: scan.stoppedBy,
        fromRawId: scan.fromRawId,
        throughRawId: scan.throughRawId,
        rowsScanned: scan.rowsScanned,
        rowsFolded: counters.folded,
        threadsFolded: summary.folded,
        threadsWritten: summary.written,
        threadsComplete: summary.complete,
        threadsPartial: summary.partial,
        anomalies: counters.anomalies,
        contractViolations: counters.contractViolations,
        bodiesUnavailable: counters.skipped.body_unavailable,
      },
    });
  }
  return report;
}
