import { sql } from "drizzle-orm";

import {
  diffDmParityThreadRows,
  getPageConversationMessages,
  getPageConversationPreview,
  getPageDmMessageWindowSummary,
  getPageDmSyncCoverage,
  listAgentTranscript,
  listDmParityActiveThreads,
  listDmParityFullRows,
  listDmParityPendingOverlayThreads,
  listDmParityPresenceThreads,
  listDmParitySpecialThreads,
  listDmParityStratifiedThreads,
  listSyncPages,
  listThreadStoredWindows,
  readDmParityCoverage,
  readDmParityRefStates,
  readDmParityThreadPresence,
  readThreadStoredFacts,
  type AgentTranscriptRow,
  type Database,
  type DmParityThread,
  type PageConversationMessageRow,
  type PageConversationPreviewMessageRow,
  type PageDmMessageWindowSummary,
  type SyncPageMode,
  type SyncPageRow,
} from "@agency_hub_core/db";

import {
  compareFullRow,
  compareMessageWindows,
  differingFields,
  extraThreads,
  oneSidedIds,
  ParityLedger,
  parityVerdict,
  PARITY_PERSISTENCE_MS,
  presenceFinding,
  servedText,
  toSecond,
  type ExtraThread,
  type ParityClass,
  type ParityClassReport,
  type ParityItem,
  type ParityMessage,
  type ParityPlace,
  type ParityReader,
  type ParityValue,
  type SummaryDriftItem,
} from "./classify.ts";

// Step 4, S4-06 (owner decision №11): `pnpm cli sync dm-reader-parity`. For
// one hour after the five-page acceptance the agent compares every DM reader
// that reads page_dm_messages today with the message_archive variant S4-08
// will serve from (there is no production read log to replay: the agent
// read audit names no conversation), on a sample per round:
//   - threads active since the previous round;
//   - 50 threads per page, stratified by stored count (1–25, 26–100,
//     101–1000, >1000);
//   - every thread with a deletion, tip, PPV, reply ref or exclusion — the
//     whole history, spread over the run's rounds (each checked once) — and
//     every thread with a pending overlay row (each round);
//   - every thread whose live rows differ between the stores (the №11
//     archive-only threads among them), each round.
// Readers: A1 the chat messages at 25 and 100 and A2 the preview at 25, with
// the live overlay; A2 the page's coverage; A3 the agent transcript with and
// without the hot arm; A4 the summary columns against the archive; B the
// fold's stored facts and the window summary. Every read runs in a READ ONLY
// transaction (each thread in one repeatable-read snapshot, so both stores
// are seen at one instant), on the app connection: the read_only role cannot
// read these tables. A missing message is rechecked from both stores ≥ 2 min
// after it was first seen; `--full` adds one scan of every Fansly hot row.

export const DM_PARITY_STRATIFIED_PER_PAGE = 50;
export const DM_PARITY_ACTIVE_CAP = 200;
export const DM_PARITY_WINDOW_LIMITS = [25, 100] as const;
export const DM_PARITY_PREVIEW_LIMIT = 25;
export const DM_PARITY_TRANSCRIPT_LIMIT = 100;
export const DM_PARITY_FULL_BATCH = 2_000;
const STATEMENT_TIMEOUT = sql.raw(`'120s'`);
/** The stores of a Fansly page's messages carry this platform. */
const FANSLY = "fansly";

export interface DmReaderParityOptions {
  /** The run stops starting rounds after this long. */
  windowMs: number;
  rounds: number;
  /** Between round starts; round 1 looks back this far for activity. */
  intervalMs: number;
  pageLabel?: string;
  full: boolean;
}

export interface DmReaderParityDeps {
  db: Database;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Progress lines (stderr in the CLI). */
  progress?: (line: string) => void;
}

export type DmParitySampleReason =
  | "active"
  | "stratified"
  | "deletion"
  | "tip"
  | "ppv"
  | "reply"
  | "exclusion"
  | "pending_overlay"
  | "store_difference";

export interface DmParityRoundReport {
  round: number;
  startedAt: string;
  durationMs: number;
  threads: number;
  byReason: Partial<Record<DmParitySampleReason, number>>;
  rechecked: number;
}

export interface DmParityPageReport {
  pageId: number;
  pageLabel: string;
  mode: SyncPageMode;
  threadsChecked: number;
  /** The lifetime sample (deletion, tip, PPV, reply, exclusion): how many
   *  threads, and how many of them this run reached. */
  lifetimeThreads: number;
  lifetimeChecked: number;
  /** Threads whose live rows differ between the stores, at the first round. */
  storeDifferenceThreads: number;
  /** `previewReadyConversationCount` as served (the summary column) and as
   *  the archive would count it, at the last round. */
  coverage: { served: number; archive: number } | null;
}

export interface DmParityFullReport {
  hotRows: number;
  storeDifferenceThreads: number;
  durationMs: number;
  completed: boolean;
}

export interface DmReaderParityReport {
  command: "sync dm-reader-parity";
  startedAt: string;
  finishedAt: string;
  options: {
    windowMs: number;
    rounds: number;
    intervalMs: number;
    page: string | null;
    full: boolean;
    persistenceMs: number;
  };
  verdict: "pass" | "fail";
  failReasons: string[];
  pages: DmParityPageReport[];
  rounds: DmParityRoundReport[];
  classes: Record<ParityClass, ParityClassReport>;
  /** The extra_in_archive messages by thread (№11: goes to the owner). */
  extraInArchive: { messages: number; threads: ExtraThread[] };
  info: {
    summaryDrift: { total: number; byField: Record<string, number>; items: SummaryDriftItem[] };
    windowShifts: Partial<Record<ParityReader, number>>;
  };
  full: DmParityFullReport | null;
}

/** Each read of the parity: READ ONLY, repeatable read, a 120 s statement
 *  cap (the store-difference scan of the largest page took 35 s cold). */
async function readOnly<T>(db: Database, body: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = ${STATEMENT_TIMEOUT}`);
    return body(tx as unknown as Database);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** 50 over four buckets: 13, 13, 12, 12. */
function stratifiedQuotas(total: number): [number, number, number, number] {
  const base = Math.floor(total / 4);
  const rest = total % 4;
  return [0, 1, 2, 3].map((bucket) => base + (bucket < rest ? 1 : 0)) as [number, number, number, number];
}

function messagesRow(row: PageConversationMessageRow): ParityMessage {
  return {
    id: row.messageId,
    provenance: row.provenance?.source ?? null,
    deleted: false,
    fields: {
      senderRole: row.senderRole,
      text: servedText(row.content),
      createdAt: toSecond(row.createdAt),
      tipCents: row.tipAmountCents,
      apiUnavailable: row.provenance?.source === "live" ? row.provenance.apiUnavailable : null,
    },
  };
}

function previewRow(row: PageConversationPreviewMessageRow): ParityMessage {
  return {
    id: row.platformMessageId,
    provenance: row.provenance?.source ?? null,
    deleted: false,
    fields: {
      senderId: row.senderPlatformUserId,
      senderRole: row.senderRole,
      text: servedText(row.content),
      createdAt: toSecond(row.createdAt),
      tipCents: row.totalTipAmountCents,
      apiUnavailable: row.provenance?.source === "live" ? row.provenance.apiUnavailable : null,
    },
  };
}

function transcriptRow(row: AgentTranscriptRow): ParityMessage {
  return {
    id: row.messageRef,
    provenance: null,
    deleted: row.deletedAt !== null,
    fields: {
      senderRole: row.senderRole,
      text: servedText(row.textPlain),
      createdAt: toSecond(row.occurredAt),
      isTip: row.isTip,
      tipMills: row.tipAmountMills === null ? null : row.tipAmountMills.toString(),
      priceMills: row.priceMills === null ? null : row.priceMills.toString(),
      isOpened: row.isOpened,
      inReplyToRef: row.inReplyToRef,
    },
  };
}

function summaryValues(summary: PageDmMessageWindowSummary): Record<string, ParityValue> {
  return {
    storedMessageCount: summary.storedMessageCount,
    newestStoredMessageId: summary.newestStoredMessageId,
    oldestStoredMessageId: summary.oldestStoredMessageId,
    lastFanMessageAt: summary.lastFanMessageAt?.toISOString() ?? null,
    lastModelMessageAt: summary.lastModelMessageAt?.toISOString() ?? null,
  };
}

interface SampledThread {
  thread: DmParityThread;
  reasons: Set<DmParitySampleReason>;
}

export async function runDmReaderParity(
  deps: DmReaderParityDeps,
  options: DmReaderParityOptions,
): Promise<DmReaderParityReport> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const progress = deps.progress ?? (() => undefined);
  const { db } = deps;
  if (!Number.isSafeInteger(options.rounds) || options.rounds < 1) throw new Error("--rounds must be at least 1");

  const startedAt = now();
  const ledger = new ParityLedger();
  const allPages = await readOnly(db, (tx) => listSyncPages(tx));
  const pages = options.pageLabel === undefined
    ? allPages
    : allPages.filter((page) => page.pageLabel === options.pageLabel);
  if (pages.length === 0) {
    throw new Error(options.pageLabel === undefined ? "No Fansly page has a sync page row" : `No Fansly page labelled ${options.pageLabel}`);
  }
  const label = (page: SyncPageRow) => page.pageLabel ?? String(page.pageId);
  // Rounds the window fits; the lifetime sample is spread over them.
  const plannedRounds = Math.max(1, Math.min(options.rounds, Math.floor((options.windowMs - 1) / options.intervalMs) + 1));
  const pageReports = new Map<number, DmParityPageReport>(pages.map((page) => [page.pageId, {
    pageId: page.pageId,
    pageLabel: label(page),
    mode: page.mode,
    threadsChecked: 0,
    lifetimeThreads: 0,
    lifetimeChecked: 0,
    storeDifferenceThreads: 0,
    coverage: null,
  }]));
  const checkedThreads = new Map<number, Set<number>>(pages.map((page) => [page.pageId, new Set<number>()]));
  const lifetime = new Map<number, Array<{ thread: DmParityThread; reasons: DmParitySampleReason[] }>>();
  const storeDifference = new Map<number, DmParityThread[]>();
  const rounds: DmParityRoundReport[] = [];

  const compareThread = async (page: SyncPageRow, thread: DmParityThread, at: Date) => {
    const pageId = page.pageId;
    const conversationRef = thread.conversationRef;
    const place = (reader: ParityReader): ParityPlace => ({
      pageId, pageLabel: label(page), threadId: thread.threadId, conversationRef, reader,
    });
    await readOnly(db, async (tx) => {
      const windows: Array<{ reader: ParityReader; hot: ParityMessage[]; archive: ParityMessage[] }> = [];
      for (const limit of DM_PARITY_WINDOW_LIMITS) {
        const input = { platformAccountId: pageId, platformConversationId: conversationRef, limit, liveOverlay: true };
        const hot = await getPageConversationMessages(tx, input);
        const archive = await getPageConversationMessages(tx, { ...input, store: "message_archive" });
        if (hot !== null && archive !== null) {
          windows.push({
            reader: limit === 25 ? "A1.messages@25" : "A1.messages@100",
            hot: hot.messages.map(messagesRow),
            archive: archive.messages.map(messagesRow),
          });
        }
      }
      const previewInput = {
        platformAccountId: pageId, platformConversationId: conversationRef, limit: DM_PARITY_PREVIEW_LIMIT, liveOverlay: true,
      };
      const hotPreview = await getPageConversationPreview(tx, previewInput);
      const archivePreview = await getPageConversationPreview(tx, { ...previewInput, store: "message_archive" });
      if (hotPreview !== null && archivePreview !== null) {
        windows.push({
          reader: "A2.preview@25",
          hot: hotPreview.messages.map(previewRow),
          archive: archivePreview.messages.map(previewRow),
        });
      }
      const transcriptInput = {
        pageId,
        platform: FANSLY,
        conversationRef,
        from: new Date(0),
        to: new Date(at.getTime() + 24 * 3_600_000),
        sortDir: "desc" as const,
        limit: DM_PARITY_TRANSCRIPT_LIMIT,
        filters: { includeDeleted: true },
        archiveFloor: null,
      };
      const hotTranscript = await listAgentTranscript(tx, transcriptInput);
      const archiveTranscript = await listAgentTranscript(tx, { ...transcriptInput, hotArm: false });
      windows.push({
        reader: "A3.transcript",
        hot: hotTranscript.rows.map(transcriptRow),
        archive: archiveTranscript.rows.map(transcriptRow),
      });

      const presence = await diffDmParityThreadRows(tx, thread.threadId);
      const refs = [
        ...windows.flatMap((window) => oneSidedIds(window.hot, window.archive)),
        ...presence.hotOnly,
        ...presence.archiveOnly,
      ];
      const states = await readDmParityRefStates(tx, { pageId, conversationRef, refs });
      for (const window of windows) {
        const compared = compareMessageWindows(window.hot, window.archive, states, conversationRef);
        for (const finding of compared.findings) ledger.record(place(window.reader), finding, at);
        ledger.recordShift(window.reader, compared.shifted);
      }
      for (const ref of [...presence.hotOnly, ...presence.archiveOnly]) {
        const state = states.get(ref);
        const finding = state === undefined ? null : presenceFinding(state, conversationRef);
        if (finding !== null) ledger.record(place("A4.summary"), finding, at);
      }

      // B and A4: thread values. A difference the rows explain (one store
      // holds a message the other does not) is already recorded per message.
      const explained = presence.hotOnly.length + presence.archiveOnly.length > 0;
      const hotFacts = await readThreadStoredFacts(tx, thread.threadId);
      const archiveFacts = await readThreadStoredFacts(tx, thread.threadId, { store: "message_archive" });
      const hotSummary = summaryValues(await getPageDmMessageWindowSummary(tx, thread.threadId));
      const archiveSummary = summaryValues(
        await getPageDmMessageWindowSummary(tx, thread.threadId, { store: "message_archive" }),
      );
      if (!explained) {
        for (const [reader, hot, archive] of [
          ["B.storedFacts", hotFacts, archiveFacts],
          ["B.windowSummary", hotSummary, archiveSummary],
        ] as Array<[ParityReader, Record<string, ParityValue>, Record<string, ParityValue>]>) {
          for (const difference of differingFields(hot, archive)) {
            ledger.record(place(reader), {
              class: "field_mismatch", messageId: null, aspect: difference.field, hot: difference.hot, archive: difference.archive,
            }, at);
          }
        }
      }
      const [stored] = await listThreadStoredWindows(tx, { pageId, threadId: thread.threadId, afterThreadId: 0, limit: 1 });
      if (stored !== undefined) {
        const columns = summaryValues(stored);
        for (const difference of differingFields(columns, archiveSummary)) {
          if (explained) continue;
          if (columns[difference.field] !== hotSummary[difference.field]) {
            ledger.recordDrift(place("A4.summary"), difference.field, difference.hot, hotSummary[difference.field] ?? null);
          } else {
            ledger.record(place("A4.summary"), {
              class: "field_mismatch", messageId: null, aspect: difference.field, hot: difference.hot, archive: difference.archive,
            }, at);
          }
        }
      }
    });
  };

  const compareCoverage = async (page: SyncPageRow, at: Date) => {
    const place = (thread: { threadId: number; conversationRef: string }): ParityPlace => ({
      pageId: page.pageId, pageLabel: label(page), threadId: thread.threadId, conversationRef: thread.conversationRef,
      reader: "A2.coverage",
    });
    await readOnly(db, async (tx) => {
      const served = await getPageDmSyncCoverage(tx, page.pageId);
      const coverage = await readDmParityCoverage(tx, { pageId: page.pageId });
      pageReports.get(page.pageId)!.coverage = { served: served.previewReadyConversationCount, archive: coverage.archiveReady };
      for (const thread of coverage.differing) {
        if (thread.hotReady && !thread.archiveReady) {
          ledger.record(place(thread), { class: "missing_in_archive", messageId: null, aspect: "thread", hot: true, archive: false }, at);
        } else if (!thread.hotReady && thread.archiveReady) {
          ledger.record(place(thread), { class: "extra_in_archive", messageId: null, aspect: "thread", hot: false, archive: true }, at);
        } else if (thread.columnReady !== thread.archiveReady) {
          ledger.recordDrift(place(thread), "previewReady", thread.columnReady, thread.hotReady);
        }
      }
    });
  };

  /** Ask both stores again about every missing item first seen ≥ 2 min ago. */
  const recheckDue = async (): Promise<number> => {
    const at = now();
    const due = ledger.dueRechecks(at);
    const byChat = new Map<string, ParityItem[]>();
    for (const item of due) {
      const key = JSON.stringify([item.pageId, item.conversationRef]);
      byChat.set(key, [...(byChat.get(key) ?? []), item]);
    }
    for (const items of byChat.values()) {
      const { pageId, conversationRef } = items[0]!;
      await readOnly(db, async (tx) => {
        const messages = items.filter((item) => item.messageId !== null);
        const states = await readDmParityRefStates(tx, {
          pageId, conversationRef, refs: messages.map((item) => item.messageId!),
        });
        for (const item of messages) {
          const state = states.get(item.messageId!);
          const finding = state === undefined ? null : presenceFinding(state, conversationRef);
          ledger.decide(item, finding?.class === "missing_in_archive", at);
        }
        const threads = items.filter((item) => item.messageId === null && item.threadId !== null);
        const presence = await readDmParityThreadPresence(tx, threads.map((item) => item.threadId!));
        for (const item of threads) {
          const found = presence.get(item.threadId!);
          ledger.decide(item, found !== undefined && found.hot && !found.archive, at);
        }
      });
    }
    return due.length;
  };

  let previousRoundStart: Date | null = null;
  for (let round = 1; round <= options.rounds; round += 1) {
    const roundStart = now();
    if (round > 1 && roundStart.getTime() - startedAt.getTime() >= options.windowMs) break;
    const since = previousRoundStart ?? new Date(roundStart.getTime() - options.intervalMs);
    const byReason: Partial<Record<DmParitySampleReason, number>> = {};
    let threadsThisRound = 0;
    for (const page of pages) {
      const report = pageReports.get(page.pageId)!;
      const sample = await readOnly(db, async (tx) => {
        if (!lifetime.has(page.pageId)) {
          const special = await listDmParitySpecialThreads(tx, { pageId: page.pageId });
          lifetime.set(page.pageId, special.map(({ reasons, ...thread }) => ({ thread, reasons })));
          report.lifetimeThreads = special.length;
          const differing = await listDmParityPresenceThreads(tx, { pageId: page.pageId });
          storeDifference.set(page.pageId, differing);
          report.storeDifferenceThreads = differing.length;
        }
        const picked = new Map<number, SampledThread>();
        const add = (thread: DmParityThread, reason: DmParitySampleReason) => {
          const entry = picked.get(thread.threadId) ?? { thread, reasons: new Set<DmParitySampleReason>() };
          entry.reasons.add(reason);
          picked.set(thread.threadId, entry);
        };
        for (const thread of await listDmParityActiveThreads(tx, { pageId: page.pageId, since, limit: DM_PARITY_ACTIVE_CAP })) {
          add(thread, "active");
        }
        const quotas = stratifiedQuotas(DM_PARITY_STRATIFIED_PER_PAGE);
        for (const thread of await listDmParityStratifiedThreads(tx, { pageId: page.pageId, quotas })) add(thread, "stratified");
        (lifetime.get(page.pageId) ?? []).forEach((entry, index) => {
          if (index % plannedRounds !== (round - 1) % plannedRounds) return;
          for (const reason of entry.reasons) add(entry.thread, reason);
        });
        for (const thread of await listDmParityPendingOverlayThreads(tx, { pageId: page.pageId })) add(thread, "pending_overlay");
        for (const thread of storeDifference.get(page.pageId) ?? []) add(thread, "store_difference");
        return [...picked.values()];
      });
      progress(`[sync dm-reader-parity] round ${round}: ${label(page)} — ${sample.length} threads`);
      await compareCoverage(page, now());
      const lifetimeIds = new Set((lifetime.get(page.pageId) ?? []).map((entry) => entry.thread.threadId));
      for (const entry of sample) {
        await compareThread(page, entry.thread, now());
        checkedThreads.get(page.pageId)!.add(entry.thread.threadId);
        for (const reason of entry.reasons) byReason[reason] = (byReason[reason] ?? 0) + 1;
      }
      report.threadsChecked = checkedThreads.get(page.pageId)!.size;
      report.lifetimeChecked = [...lifetimeIds].filter((id) => checkedThreads.get(page.pageId)!.has(id)).length;
      threadsThisRound += sample.length;
    }
    const rechecked = await recheckDue();
    rounds.push({
      round,
      startedAt: roundStart.toISOString(),
      durationMs: now().getTime() - roundStart.getTime(),
      threads: threadsThisRound,
      byReason,
      rechecked,
    });
    previousRoundStart = roundStart;
    if (round < options.rounds) {
      const next = roundStart.getTime() + options.intervalMs;
      if (next - startedAt.getTime() >= options.windowMs) break;
      await sleep(Math.max(0, next - now().getTime()));
    }
  }

  let full: DmParityFullReport | null = null;
  if (options.full) {
    const fullStart = now();
    const pageIds = pages.map((page) => page.pageId);
    const pageById = new Map(pages.map((page) => [page.pageId, page]));
    let afterId = 0;
    let hotRows = 0;
    for (;;) {
      const rows = await readOnly(db, (tx) => listDmParityFullRows(tx, { pageIds, afterId, limit: DM_PARITY_FULL_BATCH }));
      if (rows.length === 0) break;
      const at = now();
      for (const row of rows) {
        const page = pageById.get(row.pageId)!;
        for (const finding of compareFullRow(row)) {
          ledger.record({
            pageId: row.pageId, pageLabel: label(page), threadId: row.threadId, conversationRef: row.conversationRef, reader: "full",
          }, finding, at);
        }
      }
      hotRows += rows.length;
      afterId = rows.at(-1)!.hotId;
      if (hotRows % (DM_PARITY_FULL_BATCH * 50) === 0) progress(`[sync dm-reader-parity] --full: ${hotRows} hot rows`);
    }
    // The other side: archive rows the hot table does not hold live.
    let differenceThreads = 0;
    for (const page of pages) {
      const differing = await readOnly(db, (tx) => listDmParityPresenceThreads(tx, { pageId: page.pageId }));
      differenceThreads += differing.length;
      for (const thread of differing) {
        await readOnly(db, async (tx) => {
          const presence = await diffDmParityThreadRows(tx, thread.threadId);
          const states = await readDmParityRefStates(tx, {
            pageId: page.pageId, conversationRef: thread.conversationRef, refs: [...presence.hotOnly, ...presence.archiveOnly],
          });
          const at = now();
          for (const state of states.values()) {
            const finding = presenceFinding(state, thread.conversationRef);
            if (finding !== null) {
              ledger.record({
                pageId: page.pageId, pageLabel: label(page), threadId: thread.threadId, conversationRef: thread.conversationRef,
                reader: "full",
              }, finding, at);
            }
          }
        });
      }
    }
    full = { hotRows, storeDifferenceThreads: differenceThreads, durationMs: now().getTime() - fullStart.getTime(), completed: true };
    progress(`[sync dm-reader-parity] --full: ${hotRows} hot rows, ${differenceThreads} threads with a store difference`);
  }

  // Settle: every missing item gets its recheck ≥ 2 min after it was seen.
  for (let open = ledger.openMissing(); open.length > 0; open = ledger.openMissing()) {
    const dueAt = Math.min(...open.map((item) => Date.parse(item.firstSeenAt) + PARITY_PERSISTENCE_MS));
    await sleep(Math.max(0, dueAt - now().getTime()));
    await recheckDue();
  }

  const classes = ledger.classes();
  const { verdict, failReasons } = parityVerdict({
    classes,
    fullRequested: options.full,
    fullCompleted: full?.completed === true,
  });
  const drift = ledger.drift();
  const driftByField: Record<string, number> = {};
  for (const item of drift) driftByField[item.field] = (driftByField[item.field] ?? 0) + 1;
  const extras = extraThreads(ledger.items());
  return {
    command: "sync dm-reader-parity",
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    options: {
      windowMs: options.windowMs,
      rounds: options.rounds,
      intervalMs: options.intervalMs,
      page: options.pageLabel ?? null,
      full: options.full,
      persistenceMs: PARITY_PERSISTENCE_MS,
    },
    verdict,
    failReasons,
    pages: [...pageReports.values()],
    rounds,
    classes,
    extraInArchive: { messages: extras.reduce((sum, thread) => sum + thread.messages, 0), threads: extras },
    info: {
      summaryDrift: { total: drift.length, byField: driftByField, items: drift },
      windowShifts: ledger.shifts(),
    },
    full,
  };
}

/** The owner's short report (№11): verdict, counts, and the archive-only list. */
export function summarizeDmReaderParity(report: DmReaderParityReport): string[] {
  const missing = report.classes.missing_in_archive;
  const lines = [
    `sync dm-reader-parity: ${report.verdict.toUpperCase()}${report.failReasons.length > 0 ? ` (${report.failReasons.join("; ")})` : ""}`,
    `  ${report.rounds.length} round(s) ${report.startedAt} → ${report.finishedAt}; threads checked: `
      + report.pages.map((page) => `${page.pageLabel} ${page.threadsChecked}`).join(", "),
    `  missing_in_archive: ${missing.total} (persistent ${missing.persistent ?? 0}, resolved ${missing.resolved ?? 0}, open ${missing.open ?? 0})`,
    `  field_mismatch: ${report.classes.field_mismatch.total}${Object.keys(report.classes.field_mismatch.byField ?? {}).length > 0
      ? ` ${JSON.stringify(report.classes.field_mismatch.byField)}` : ""}`,
    `  extra_in_archive: ${report.extraInArchive.messages} message(s) in ${report.extraInArchive.threads.length} thread(s); `
      + `in windows: ${JSON.stringify(report.classes.extra_in_archive.byReader)}`,
    `  tie_order: ${report.classes.tie_order.total}; summary drift (not a store difference): ${report.info.summaryDrift.total}`,
  ];
  if (report.full !== null) {
    lines.push(`  --full: ${report.full.hotRows} hot rows, ${report.full.storeDifferenceThreads} thread(s) with a store difference`);
  }
  for (const thread of report.extraInArchive.threads) {
    lines.push(`    ${thread.pageLabel} ${thread.conversationRef}: ${thread.messages} archive-only message(s)`);
  }
  return lines;
}
