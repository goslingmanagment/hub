import { createHash } from "node:crypto";

import {
  CHAT_UNAVAILABILITY_OWNER_NOTE_MAX,
  insertAuditEvent,
  listPageChatUnavailability,
  writeChatUnavailabilityOwnerNote,
  type ChatUnavailabilityEpisode,
  type Database,
  type PageChatUnavailability,
} from "@agency_hub_core/db";

import { findSyncPageByLabel, SyncOwnerLeverError } from "./inspect.ts";

// The owner's view of the chats Fansly does not serve to a page (arena
// "vanished chat", plan §4; the episodes are `page_dm_thread_unavailability`,
// written by the page's actor — `repositories/sync/chat-unavailability.ts`):
//   pnpm cli sync chats unavailable --page P [--ended] [--json]   read-only
//   pnpm cli sync chats note --page P --chat G --note "…" [--at <iso>]
// Neither sends anything to Fansly: the list reads the database, the note
// writes the episode's `owner_note` / `owner_note_at` only — the two columns
// the actor never writes — with an audit row in the same transaction.

/** The owner's note on an episode in the audit log. */
export const SYNC_CHAT_UNAVAILABILITY_NOTE_AUDIT_EVENT = "admin.sync_chat_unavailability_note";

const GROUP_ID = /^[0-9]{1,30}$/;

/** One episode as the owner reads it: the chat, its state and the evidence. */
export interface UnavailableChatView {
  episodeId: number;
  /** The chat's Fansly group id. */
  chat: string;
  /** Who the chat is with, as the thread names them. */
  partner: { platformUserId: string | null; username: string | null };
  /** `refusing`: Fansly refused the chat's head; `established`: refused five
   *  times — the chat's work closed `chat_unavailable`, nothing reads its head
   *  before `retryNotBefore`. `ended`: an applied head read (or the chat
   *  excluded or unbound since) ended it. */
  state: "refusing" | "established" | "ended";
  openedAt: string;
  establishedAt: string | null;
  endedAt: string | null;
  endReason: ChatUnavailabilityEpisode["endReason"];
  refusals: number;
  lastRefusalAt: string;
  lastHttpStatus: number | null;
  /** No key reads the chat's head before this instant (established only). */
  retryNotBefore: string | null;
  /** The attempts (`sync_attempts`, kept 30 days) and the raw answers
   *  (`observations`) that prove it: the first refusal and the latest. */
  evidence: {
    firstAttemptId: number;
    lastAttemptId: number;
    firstObservation: { id: number; receivedAt: string };
    lastObservation: { id: number; receivedAt: string };
  };
  /** The newest list head the episode already answered with a read. */
  handledListHeadId: string | null;
  ownerNote: { text: string; at: string } | null;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function unavailableChatView(episode: PageChatUnavailability): UnavailableChatView {
  return {
    episodeId: episode.id,
    chat: episode.groupId,
    partner: { ...episode.partner },
    state: episode.endedAt !== null ? "ended" : episode.state,
    openedAt: episode.openedAt.toISOString(),
    establishedAt: iso(episode.establishedAt),
    endedAt: iso(episode.endedAt),
    endReason: episode.endReason,
    refusals: episode.refusals,
    lastRefusalAt: episode.lastRefusalAt.toISOString(),
    lastHttpStatus: episode.lastHttpStatus,
    retryNotBefore: iso(episode.retryNotBefore),
    evidence: {
      firstAttemptId: episode.firstAttemptId,
      lastAttemptId: episode.lastAttemptId,
      firstObservation: { id: episode.firstObservation.id, receivedAt: episode.firstObservation.receivedAt.toISOString() },
      lastObservation: { id: episode.lastObservation.id, receivedAt: episode.lastObservation.receivedAt.toISOString() },
    },
    handledListHeadId: episode.handledListHeadId,
    ownerNote: episode.ownerNote === null || episode.ownerNoteAt === null
      ? null
      : { text: episode.ownerNote, at: episode.ownerNoteAt.toISOString() },
  };
}

export interface UnavailableChatsReport {
  page: string;
  /** Only the open episodes (refusing and established), or every one. */
  ended: boolean;
  /** Open episodes that are established: the counter of the page summary. */
  established: number;
  refusing: number;
  episodes: UnavailableChatView[];
}

/** `sync chats unavailable`: the page's open episodes (with `ended`, every
 *  episode of the page), open first, then the newest. Read-only. */
export async function readUnavailableChats(
  db: Database,
  input: { pageLabel: string; ended: boolean },
): Promise<UnavailableChatsReport> {
  const page = await findSyncPageByLabel(db, input.pageLabel);
  const episodes = (await listPageChatUnavailability(db, { pageId: page.pageId, ended: input.ended })).map(unavailableChatView);
  return {
    page: input.pageLabel,
    ended: input.ended,
    established: episodes.filter((episode) => episode.state === "established").length,
    refusing: episodes.filter((episode) => episode.state === "refusing").length,
    episodes,
  };
}

/** The owner's note as `sync chats note` takes it: trimmed, 1–2000 characters. */
export function parseOwnerNote(value: string): string {
  const note = value.trim();
  if (note.length === 0 || note.length > CHAT_UNAVAILABILITY_OWNER_NOTE_MAX) {
    throw new SyncOwnerLeverError(`a note is 1–${CHAT_UNAVAILABILITY_OWNER_NOTE_MAX} characters (received ${note.length})`);
  }
  return note;
}

export interface UnavailableChatNoteResult {
  page: string;
  episode: UnavailableChatView;
  /** The episode carried a note before, which this one replaced. */
  replaced: boolean;
  auditId: number;
}

/**
 * `sync chats note`: the owner's observation on a chat's episode — its open
 * one, else its newest — with the instant it was made (`at`, default now).
 * Writes `owner_note` and `owner_note_at` only and audits it, in one
 * transaction; sends nothing to Fansly. The audit row keeps the note's digest
 * and length, not its text: the audit outlives an erasure of the chat, and
 * the note is erased with the chat's thread.
 */
export async function noteUnavailableChat(
  db: Database,
  input: { pageLabel: string; chat: string; note: string; at?: Date | null; actor: string },
): Promise<UnavailableChatNoteResult> {
  if (!GROUP_ID.test(input.chat)) throw new SyncOwnerLeverError(`--chat is a Fansly group id (digits), received "${input.chat}"`);
  const note = parseOwnerNote(input.note);
  const page = await findSyncPageByLabel(db, input.pageLabel);
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const written = await writeChatUnavailabilityOwnerNote(txDb, {
      pageId: page.pageId,
      groupId: input.chat,
      note,
      at: input.at ?? null,
    });
    if (written === null) {
      throw new SyncOwnerLeverError(
        `${input.pageLabel} has no unavailability episode for chat ${input.chat}: sync chats unavailable --page ${input.pageLabel} --ended`,
      );
    }
    const [listed] = (await listPageChatUnavailability(txDb, { pageId: page.pageId, groupId: input.chat, ended: true }))
      .filter((episode) => episode.id === written.episode.id);
    const view = unavailableChatView(listed ?? { ...written.episode, partner: { platformUserId: null, username: null } });
    const audit = await insertAuditEvent(txDb, {
      platformAccountId: page.pageId,
      source: "cli",
      eventType: SYNC_CHAT_UNAVAILABILITY_NOTE_AUDIT_EVENT,
      metadata: {
        actor: input.actor,
        pageLabel: input.pageLabel,
        chat: input.chat,
        episodeId: view.episodeId,
        episodeState: view.state,
        noteAt: view.ownerNote?.at ?? null,
        noteChars: note.length,
        noteSha256: createHash("sha256").update(note).digest("hex"),
        replaced: written.previousNote !== null,
      },
    });
    return { page: input.pageLabel, episode: view, replaced: written.previousNote !== null, auditId: Number(audit!.id) };
  });
}
