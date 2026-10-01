import {
  countStoredMessagesOlderThan,
  getPageDmMessageWindowSummary,
  getSyncPage,
  listPageThreadChains,
  listThreadStoredWindows,
  readThreadStoredFacts,
  type SyncPageMode,
} from "@agency_hub_core/db";

import {
  FIRST_SECOND_RULE_ENABLED,
  isFirstSecondPage,
  isShortPage,
  sameMessageId,
  validateChainPage,
} from "./chain.ts";
import {
  foldJournalEntry,
  initialFoldState,
  legacyJournalBatches,
  newFoldCounters,
  ScanGovernor,
  type ChainFoldCounters,
  type ScanPacing,
  type ScanStop,
  type SyncChainContext,
} from "./chain-rebuild.ts";

// Fansly Sync Engine (plan §6.2, design §8.3, §5.4 step 6): read-only checks.
//
// `check-end-rule` folds the legacy journal from empty chains (the rebuild's
// fold, nothing written) and measures the end-of-history rule on it:
//   1. short pages are not ends — a page with 0 < items < its own limit (a
//      limit-1 head repair is never short) for which older material exists:
//      a later journal page at `before` = its oldest id is non-empty, or the
//      hub stores an older non-deleted message (the 16.09 counterexample,
//      raw 2975891 and 2975902, must be among them);
//   2. empty pages are sound — an empty page at `before` = the chain's (or the
//      staged walk's) oldest id must have no older stored message;
//   3. the first-second heuristic (informational, decision №3 keeps it off);
//   4. legacy verdicts — threads legacy calls complete whose rebuilt chain is
//      not.
// `check-window` compares the stored-window columns with the window
// recomputed from the rows (the drift check of the engine's incremental
// `syncLegacyThreadSummary`).

const STORED_PROBE_CHUNK = 1000;

interface ShortPageRecord {
  rawId: number;
  groupId: string;
  threadId: number | null;
  limit: number;
  items: number;
  oldestId: string;
  firstSecond: boolean;
  laterPageRawId: number | null;
  storedOlder: number;
}

interface EmptyEndRecord {
  rawId: number;
  groupId: string;
  threadId: number;
  before: string;
  storedOlder: number;
}

export interface EndRuleCounterexample {
  rawId: number;
  groupId: string;
  threadId: number | null;
  limit: number;
  items: number;
  oldestId: string;
  /** A later page at before = oldestId returned messages. */
  laterPageRawId: number | null;
  /** Non-deleted stored messages older than oldestId. */
  storedOlder: number;
}

export interface EndRulePageReport {
  pageId: number;
  pageLabel: string | null;
  scan: { rowsScanned: number; throughRawId: number; completed: boolean; stoppedBy: ScanStop | null };
  rows: ChainFoldCounters;
  shortPages: {
    total: number;
    counterexamples: number;
    byEvidence: { later_page: number; stored: number; both: number };
    counterexampleRawIds: number[];
    details: EndRuleCounterexample[];
  };
  emptyPageSoundness: {
    emptyPagesAtChainEnd: number;
    withOlderStored: number;
    hits: Array<{ rawId: number; groupId: string; threadId: number; before: string; storedOlder: number }>;
  };
  firstSecond: {
    ruleEnabled: boolean;
    shortPagesWithinOneSecond: number;
    ofWhichOlderMaterial: number;
    rawIds: number[];
  };
  legacyVerdicts: {
    legacyComplete: number;
    rebuiltComplete: number;
    falseComplete: number;
    notInJournal: number;
    examples: Array<{ threadId: number; groupId: string; rebuiltState: string }>;
  };
}

export interface EndRuleOptions extends ScanPacing {
  pageId: number;
  since: Date;
  /** Cap of the detailed lists (raw id lists are always complete). */
  maxListed: number;
}

async function storedOlderCounts(app: SyncChainContext, probes: { threadId: number; beforeId: string }[]): Promise<number[]> {
  const counts: number[] = [];
  for (let start = 0; start < probes.length; start += STORED_PROBE_CHUNK) {
    counts.push(...await countStoredMessagesOlderThan(app.db, probes.slice(start, start + STORED_PROBE_CHUNK)));
  }
  return counts;
}

export async function checkEndRule(
  app: SyncChainContext,
  options: EndRuleOptions,
  governor: ScanGovernor = new ScanGovernor(options),
): Promise<EndRulePageReport> {
  const syncPage = await getSyncPage(app.db, options.pageId);
  const threads = await listPageThreadChains(app.db, { pageId: options.pageId });
  const book = new Map(threads.map((row) => [row.groupId, initialFoldState(row, "scratch")]));
  const counters = newFoldCounters();
  const shortPages: ShortPageRecord[] = [];
  const pendingByCursor = new Map<string, ShortPageRecord[]>();
  const emptyEnds: EmptyEndRecord[] = [];
  const seenGroups = new Set<string>();
  const readStored = (threadId: number) => readThreadStoredFacts(app.db, threadId);
  const scan: EndRulePageReport["scan"] = { rowsScanned: 0, throughRawId: 0, completed: false, stoppedBy: null };

  scan.stoppedBy = governor.stopReason();
  if (scan.stoppedBy === null) {
    for await (const batch of legacyJournalBatches(app, {
      pageId: options.pageId,
      afterId: 0,
      batchRows: options.batchRows,
      since: options.since,
    })) {
      for (const entry of batch.entries) {
        const { result } = entry;
        if (result.kind === "page" && validateChainPage(result.page) === null) {
          const { page, groupId } = result;
          const state = book.get(groupId);
          seenGroups.add(groupId);
          if (page.before !== null && page.ids.length > 0) {
            for (const short of pendingByCursor.get(`${groupId}:${page.before}`) ?? []) {
              short.laterPageRawId ??= entry.rawId;
            }
          }
          if (isShortPage(page)) {
            const record: ShortPageRecord = {
              rawId: entry.rawId,
              groupId,
              threadId: state?.threadId ?? null,
              limit: page.limit,
              items: page.ids.length,
              oldestId: page.ids[page.ids.length - 1]!,
              firstSecond: isFirstSecondPage(groupId, page),
              laterPageRawId: null,
              storedOlder: 0,
            };
            shortPages.push(record);
            const key = `${groupId}:${record.oldestId}`;
            pendingByCursor.set(key, [...(pendingByCursor.get(key) ?? []), record]);
          }
          if (state !== undefined && page.before !== null && page.ids.length === 0) {
            const chainEnd = state.chain.state === "partial" || state.chain.state === "complete"
              ? state.chain.oldestId : null;
            const atEnd = (chainEnd !== null && sameMessageId(page.before, chainEnd))
              || (state.segment !== null && sameMessageId(page.before, state.segment.oldestId));
            if (atEnd) {
              emptyEnds.push({ rawId: entry.rawId, groupId, threadId: state.threadId, before: page.before, storedOlder: 0 });
            }
          }
        }
        await foldJournalEntry(book, entry, counters, readStored);
      }
      scan.rowsScanned += batch.entries.length;
      scan.throughRawId = batch.throughRawId;
      if (batch.exhausted) {
        scan.completed = true;
        break;
      }
      scan.stoppedBy = governor.stopReason();
      if (scan.stoppedBy !== null) break;
      await governor.pause();
    }
  }

  const shortProbes = shortPages.filter((record) => record.threadId !== null);
  const shortCounts = await storedOlderCounts(
    app,
    shortProbes.map((record) => ({ threadId: record.threadId!, beforeId: record.oldestId })),
  );
  shortProbes.forEach((record, index) => {
    record.storedOlder = shortCounts[index] ?? 0;
  });
  const endCounts = await storedOlderCounts(
    app,
    emptyEnds.map((record) => ({ threadId: record.threadId, beforeId: record.before })),
  );
  emptyEnds.forEach((record, index) => {
    record.storedOlder = endCounts[index] ?? 0;
  });

  const counterexamples = shortPages.filter((record) => record.laterPageRawId !== null || record.storedOlder > 0);
  const byEvidence = { later_page: 0, stored: 0, both: 0 };
  for (const record of counterexamples) {
    const later = record.laterPageRawId !== null;
    const stored = record.storedOlder > 0;
    if (later && stored) byEvidence.both += 1;
    else if (later) byEvidence.later_page += 1;
    else byEvidence.stored += 1;
  }
  const firstSecond = shortPages.filter((record) => record.firstSecond);
  const soundnessHits = emptyEnds.filter((record) => record.storedOlder > 0);

  let legacyComplete = 0;
  let rebuiltComplete = 0;
  let falseComplete = 0;
  let notInJournal = 0;
  const examples: EndRulePageReport["legacyVerdicts"]["examples"] = [];
  for (const state of book.values()) {
    if (state.chain.state === "complete") rebuiltComplete += 1;
    if (state.legacyCoverageStatus !== "complete") continue;
    legacyComplete += 1;
    if (!seenGroups.has(state.groupId)) {
      notInJournal += 1;
      continue;
    }
    if (state.chain.state !== "complete") {
      falseComplete += 1;
      if (examples.length < options.maxListed) {
        examples.push({ threadId: state.threadId, groupId: state.groupId, rebuiltState: state.chain.state });
      }
    }
  }

  return {
    pageId: options.pageId,
    pageLabel: syncPage?.pageLabel ?? null,
    scan,
    rows: counters,
    shortPages: {
      total: shortPages.length,
      counterexamples: counterexamples.length,
      byEvidence,
      counterexampleRawIds: counterexamples.map((record) => record.rawId),
      details: counterexamples.slice(0, options.maxListed).map((record) => ({
        rawId: record.rawId,
        groupId: record.groupId,
        threadId: record.threadId,
        limit: record.limit,
        items: record.items,
        oldestId: record.oldestId,
        laterPageRawId: record.laterPageRawId,
        storedOlder: record.storedOlder,
      })),
    },
    emptyPageSoundness: {
      emptyPagesAtChainEnd: emptyEnds.length,
      withOlderStored: soundnessHits.length,
      hits: soundnessHits.slice(0, options.maxListed).map((record) => ({ ...record })),
    },
    firstSecond: {
      ruleEnabled: FIRST_SECOND_RULE_ENABLED,
      shortPagesWithinOneSecond: firstSecond.length,
      ofWhichOlderMaterial: firstSecond.filter((record) => record.laterPageRawId !== null || record.storedOlder > 0).length,
      rawIds: firstSecond.slice(0, options.maxListed).map((record) => record.rawId),
    },
    legacyVerdicts: { legacyComplete, rebuiltComplete, falseComplete, notInJournal, examples },
  };
}

// ── check-window ──────────────────────────────────────────────────────────────

const WINDOW_FIELDS = [
  "storedMessageCount",
  "newestStoredMessageId",
  "oldestStoredMessageId",
  "lastFanMessageAt",
  "lastModelMessageAt",
] as const;
type WindowField = (typeof WINDOW_FIELDS)[number];

export interface WindowDrift {
  threadId: number;
  groupId: string;
  fields: Partial<Record<WindowField, { stored: string | number | null; recomputed: string | number | null }>>;
}

export interface WindowCheckReport {
  pageId: number;
  pageLabel: string | null;
  mode: SyncPageMode | "no_sync_page";
  threadsChecked: number;
  drifted: number;
  byField: Record<WindowField, number>;
  examples: WindowDrift[];
  truncated: boolean;
}

function comparable(value: Date | string | number | null): string | number | null {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Compare every thread's stored-window columns (`stored_message_count`,
 * newest/oldest stored ids, last fan/model times) with the window the legacy
 * finalize would recompute from the rows (`getPageDmMessageWindowSummary`).
 * Read-only; one summary query per thread.
 */
export async function checkWindow(
  app: SyncChainContext,
  options: { pageId: number; threadId?: number; maxThreads: number; maxListed: number },
): Promise<WindowCheckReport> {
  const syncPage = await getSyncPage(app.db, options.pageId);
  const byField = Object.fromEntries(WINDOW_FIELDS.map((field) => [field, 0])) as Record<WindowField, number>;
  const examples: WindowDrift[] = [];
  let threadsChecked = 0;
  let drifted = 0;
  let afterThreadId = 0;
  let truncated = false;
  for (;;) {
    const remaining = options.maxThreads - threadsChecked;
    const rows = await listThreadStoredWindows(app.db, {
      pageId: options.pageId,
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
      afterThreadId,
      limit: Math.min(500, remaining + 1),
    });
    if (rows.length === 0) break;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    for (const row of rows.slice(0, remaining)) {
      afterThreadId = row.threadId;
      threadsChecked += 1;
      const summary = await getPageDmMessageWindowSummary(app.db, row.threadId);
      const fields: WindowDrift["fields"] = {};
      for (const field of WINDOW_FIELDS) {
        const stored = comparable(row[field]);
        const recomputed = comparable(summary[field]);
        if (stored !== recomputed) {
          fields[field] = { stored, recomputed };
          byField[field] += 1;
        }
      }
      if (Object.keys(fields).length > 0) {
        drifted += 1;
        if (examples.length < options.maxListed) examples.push({ threadId: row.threadId, groupId: row.groupId, fields });
      }
    }
  }
  return {
    pageId: options.pageId,
    pageLabel: syncPage?.pageLabel ?? null,
    mode: syncPage?.mode ?? "no_sync_page",
    threadsChecked,
    drifted,
    byField,
    examples,
    truncated,
  };
}
