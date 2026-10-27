import {
  getFanslyBlocklistReaderState,
  markFanslyBlocklistPostsDeleted,
  saveFanslyBlocklistReaderState,
  upsertFanslyBlocklistMessages,
  type Database,
  type FanslyBlocklistReaderState,
} from "@agency_hub_core/db";
import { sanitizePostgresText } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { ensureQueueCreated, type QueueCreationClient } from "../sync-queue.ts";
import { parseBlocklistHandles } from "./handles.ts";
import { BlocklistFloodWait, connectBlocklistTelegram, type BlocklistTelegram } from "./telegram.ts";

// FANSLY BLOCKLIST reader (fan marks, 2026-10-27): every 10 minutes the
// worker reads the Telegram group FANSLY BLOCKLIST — a community blacklist of
// Fansly members, ~10 posts a day — with the agency's own account, read-only
// (./telegram.ts), and keeps the posts that name a fansly.com profile
// (./handles.ts) for the marks in the chat header (`clientFanMarks`).
//
// A run, one history page (100 messages) a request, a second apart:
// 1. the head: from the newest message down past the last run's newest, at
//    least the newest RECHECK_MESSAGES — so an edit there («UPD: ✅заплатил»)
//    is read again, and a stored post in that range the read did not return
//    is marked deleted;
// 2. the backfill, until it reaches the group's first message: down from the
//    oldest message read, at most MAX_MESSAGES_PER_RUN a run with the head.
// A FLOOD_WAIT the library does not sleep through ends the run and is kept:
// no run asks before it passes. `read_at` moves only when a run read the head
// to the last run's newest (a full read).
//
// Off — nothing connects, one line in the log — while TG_READER_SESSION is
// empty. The job is exclusive: one run at a time across the workers.

export const FANSLY_BLOCKLIST_QUEUE = "fan-marks.blocklist.read";
const QUEUE_OPTIONS = { policy: "exclusive", retryLimit: 0 } as const;
const SCHEDULE = "*/10 * * * *";

const PAGE_LIMIT = 100;
/** The head is re-read this deep every run (edits and deletions). */
export const BLOCKLIST_RECHECK_MESSAGES = 200;
/** Messages one run reads at most, the head and the backfill together. */
export const BLOCKLIST_MAX_MESSAGES_PER_RUN = 3000;
const REQUEST_GAP_MS = 1000;

/** One message of the group as read. */
export interface BlocklistMessage {
  id: number;
  postedAt: Date;
  editedAt: Date | null;
  text: string;
  /** The targets of its text links. */
  urls: string[];
  authorName: string | null;
}

export interface BlocklistHistoryPage {
  /** Every id the page returned, service messages included: what is still there. */
  ids: number[];
  /** Its messages with content (service messages carry none). */
  messages: BlocklistMessage[];
}

/** The group's history, newest first. */
export interface BlocklistHistory {
  chatId: number;
  /** Messages below `offsetId` (0: from the newest) and above `minId`, at most `limit`. */
  page(input: { offsetId: number; minId: number; limit: number }): Promise<BlocklistHistoryPage>;
}

export interface BlocklistReadResult {
  status: "read" | "flood_wait";
  requests: number;
  messages: number;
  postsWritten: number;
  deleted: number;
  /** The head was read to the last run's newest: `read_at` moved. */
  fullRead: boolean;
  backfillDone: boolean;
  floodSeconds?: number;
}

function inputsOf(messages: readonly BlocklistMessage[]) {
  return messages.map((message) => ({
    messageId: message.id,
    postedAt: message.postedAt,
    editedAt: message.editedAt,
    authorName: message.authorName === null ? null : sanitizePostgresText(message.authorName).slice(0, 256),
    text: sanitizePostgresText(message.text),
    handles: parseBlocklistHandles(message.text, message.urls),
  }));
}

/** One run over `history` (see the header). Writes as it reads; the state is saved at the end, a FLOOD_WAIT included. */
export async function readBlocklistHistory(
  db: Database,
  history: BlocklistHistory,
  options: { now: Date; maxMessages?: number; sleep?: (ms: number) => Promise<void> },
): Promise<BlocklistReadResult> {
  const now = options.now;
  const maxMessages = options.maxMessages ?? BLOCKLIST_MAX_MESSAGES_PER_RUN;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const chatId = history.chatId;
  const stored = await getFanslyBlocklistReaderState(db, chatId);
  const state: FanslyBlocklistReaderState = stored ?? {
    chatId, headMessageId: null, tailMessageId: null, backfillDoneAt: null, readAt: null, floodUntil: null, messagesRead: 0,
  };
  const result: BlocklistReadResult = {
    status: "read", requests: 0, messages: 0, postsWritten: 0, deleted: 0, fullRead: false, backfillDone: state.backfillDoneAt !== null,
  };
  if (state.floodUntil !== null && state.floodUntil > now) {
    return { ...result, status: "flood_wait", floodSeconds: Math.ceil((state.floodUntil.getTime() - now.getTime()) / 1000) };
  }
  state.floodUntil = null;

  const read = async (offsetId: number): Promise<BlocklistHistoryPage> => {
    if (result.requests > 0) await sleep(REQUEST_GAP_MS);
    result.requests += 1;
    const page = await history.page({ offsetId, minId: 0, limit: PAGE_LIMIT });
    result.messages += page.ids.length;
    result.postsWritten += await upsertFanslyBlocklistMessages(db, { chatId, readAt: now, messages: inputsOf(page.messages) });
    return page;
  };

  try {
    // 1. The head.
    let offsetId = 0;
    let headMin: number | null = null;
    let headMax: number | null = null;
    const present: number[] = [];
    let reachedEnd = false;
    for (;;) {
      const page = await read(offsetId);
      present.push(...page.ids);
      if (page.ids.length > 0) {
        headMin = Math.min(headMin ?? Infinity, ...page.ids);
        headMax = Math.max(headMax ?? -Infinity, ...page.ids);
      }
      if (page.ids.length === 0) {
        reachedEnd = true;
        break;
      }
      const deepEnough = present.length >= BLOCKLIST_RECHECK_MESSAGES;
      const pastLastHead = state.headMessageId === null || headMin! <= state.headMessageId;
      if (deepEnough && pastLastHead) break;
      if (result.messages >= maxMessages) break;
      offsetId = headMin!;
    }
    const caughtUp = reachedEnd || state.headMessageId === null || (headMin !== null && headMin <= state.headMessageId);
    if (headMin !== null && headMax !== null) {
      result.deleted = await markFanslyBlocklistPostsDeleted(db, {
        chatId, fromMessageId: headMin, toMessageId: headMax, presentIds: present, at: now,
      });
    }
    if (caughtUp) {
      // A head read that did not reach the last newest leaves a gap below it: the head stays, the next run reads on.
      state.headMessageId = Math.max(state.headMessageId ?? 0, headMax ?? 0) || null;
      state.readAt = now;
      result.fullRead = true;
    }
    if (caughtUp && headMin !== null) state.tailMessageId = Math.min(state.tailMessageId ?? headMin, headMin);
    // The head read down to the group's first message: there is nothing left to backfill.
    if (reachedEnd) state.backfillDoneAt ??= now;

    // 2. The backfill, below the oldest message read.
    while (state.backfillDoneAt === null && state.tailMessageId !== null && result.messages < maxMessages) {
      const page = await read(state.tailMessageId);
      if (page.ids.length === 0) {
        state.backfillDoneAt = now;
        break;
      }
      state.tailMessageId = Math.min(state.tailMessageId, ...page.ids);
    }
  } catch (error) {
    if (!(error instanceof BlocklistFloodWait)) throw error;
    state.floodUntil = new Date(now.getTime() + error.seconds * 1000);
    result.status = "flood_wait";
    result.floodSeconds = error.seconds;
  } finally {
    state.messagesRead += result.messages;
    await saveFanslyBlocklistReaderState(db, state);
  }
  result.backfillDone = state.backfillDoneAt !== null;
  return result;
}

// ── the job ──────────────────────────────────────────────────────────────────

const said = new Set<string>();
/** A state the log says once per process (off, not a member yet). */
function sayOnce(app: AppContext, key: string, detail: Record<string, unknown>, message: string) {
  if (said.has(key)) return;
  said.add(key);
  app.logger.info(detail, message);
}

export interface BlocklistRunSummary {
  status: "off" | "not_configured" | "refused" | "read" | "flood_wait";
  reason?: string;
  result?: BlocklistReadResult;
}

export async function runFanslyBlocklistRead(
  app: AppContext,
  deps: { connect?: (config: AppContext["config"]) => Promise<BlocklistTelegram>; now?: () => Date } = {},
): Promise<BlocklistRunSummary> {
  const config = app.config;
  if ((config.tgReaderSession ?? null) === null) {
    sayOnce(app, "off", {}, "FANSLY BLOCKLIST reader is off: TG_READER_SESSION is empty");
    return { status: "off" };
  }
  if ((config.tgReaderApiId ?? null) === null || (config.tgReaderApiHash ?? null) === null) {
    sayOnce(app, "not_configured", {}, "FANSLY BLOCKLIST reader is off: TG_READER_API_ID and TG_READER_API_HASH must be set with the session");
    return { status: "not_configured" };
  }
  const telegram = await (deps.connect ?? connectBlocklistTelegram)(config);
  try {
    const opened = await telegram.open(config.fanslyBlocklistInvite ?? "UBpb0x7HoY8xN2Fi");
    if ("refused" in opened) {
      sayOnce(app, `refused:${opened.refused}`, { reason: opened.refused }, "FANSLY BLOCKLIST reader cannot read the group yet");
      return { status: "refused", reason: opened.refused };
    }
    const result = await readBlocklistHistory(app.db, opened.history, { now: deps.now?.() ?? new Date() });
    if (result.status === "flood_wait") {
      app.logger.warn({ floodSeconds: result.floodSeconds, requests: result.requests }, "FANSLY BLOCKLIST reader: Telegram asked to wait");
    } else if (result.postsWritten > 0 || result.deleted > 0 || !result.backfillDone) {
      app.logger.info({ ...result }, "FANSLY BLOCKLIST read");
    }
    return { status: result.status, result };
  } finally {
    await telegram.close();
  }
}

export async function ensureFanslyBlocklistQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, FANSLY_BLOCKLIST_QUEUE, QUEUE_OPTIONS, createdQueues);
}

export async function ensureFanslyBlocklistSchedule(boss: QueueCreationClient) {
  await boss.schedule?.(FANSLY_BLOCKLIST_QUEUE, SCHEDULE, null, { tz: "UTC" });
}
