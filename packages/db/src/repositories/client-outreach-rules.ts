import { normalizeDmMessageText } from "@agency_hub_core/shared";

// «Рассылки» kept by Hub (0346, docs/plans/2026-11-01-outreach-store/spec.md
// §5): the rules of one fan's send, as a pure function over what the
// repository reads under the fan's advisory lock (client-outreaches.ts), and
// the archive's proof that an uncertain send went. No SQL here, so every row
// of the spec's table has a unit test (tests/client-outreach-rules.test.ts).
//
// One claim per fan of an outreach, ever, unless the platform proved it was
// refused (`failed`); one claim on its way per fan of the page across all its
// outreaches. A claim not reported within its ticket reads `uncertain`
// everywhere and is never claimed again; only the claim's own attempt
// reports it. Nothing here is ever retried by itself.

/** The contract's OUTREACH_SEND_TICKET_SECONDS. */
export const OUTREACH_SEND_TICKET_MS = 120_000;
/** The contract's OUTREACH_RECORD_MAX_AGE_DAYS: a send made before Hub is taken this old at most. */
export const OUTREACH_RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** A record or a first save from a browser whose clock runs ahead by this much is taken as now. */
export const OUTREACH_CLOCK_SKEW_MS = 5 * 60_000;
/** A first save's own `createdAt` is taken this old at most. */
export const OUTREACH_CREATED_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** The archive is asked about an uncertain send this long after its click (§5). */
export const OUTREACH_EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** The page's message proves the send when it was written from a minute before the click… */
export const OUTREACH_EVIDENCE_BEFORE_MS = 60_000;
/** …to the contract's OUTREACH_EVIDENCE_MINUTES after it. */
export const OUTREACH_EVIDENCE_AFTER_MS = 30 * 60_000;
/** The normalized texts agree on this many characters (or all of a shorter one). */
export const OUTREACH_EVIDENCE_PREFIX = 60;

export type OutreachSendState = "sending" | "sent" | "uncertain" | "failed";
export type OutreachSendOutcome = "ok" | "taken" | "busy" | "not_yours";

/** A fan's send as the row stores it. */
export interface OutreachSendRow {
  state: OutreachSendState;
  /** Lowercase. */
  attemptId: string;
  senderUserId: number;
  clickedAt: Date;
  ticketUntil: Date | null;
}

/** Everything the rules read about one fan of one outreach, under the fan's lock. */
export interface OutreachSendSnapshot {
  now: Date;
  /** The fan's send in this outreach; null — none (no row, or a row with a version only). */
  send: OutreachSendRow | null;
  /** The fan's stored `sending` claims in the page's other outreaches, live or past their ticket. */
  othersSending: ReadonlyArray<{ outreachId: string; ticketUntil: Date | null }>;
}

type Media = Record<string, unknown> | null;

export type OutreachSendRequest =
  | { action: "claim"; attemptId: string; userId: number; text: string; media: Media }
  | { action: "sent"; attemptId: string; userId: number; platformMessageId: string | null }
  | { action: "failed"; attemptId: string; userId: number; code: string }
  | { action: "uncertain"; attemptId: string; userId: number }
  | {
    action: "record"; attemptId: string; userId: number; state: "sent" | "uncertain"; clickedAt: Date; sentAt: Date | null;
    text: string; media: Media; platformMessageId: string | null;
  };

export type OutreachSendWrite =
  /** Another outreach's claim past its ticket, stored `uncertain`: the fan's one slot is free for this claim. */
  | { kind: "settle_other"; outreachId: string }
  | { kind: "claim"; attemptId: string; userId: number; clickedAt: Date; ticketUntil: Date; text: string; media: Media }
  | { kind: "sent"; sentAt: Date; platformMessageId: string | null }
  | { kind: "failed"; code: string }
  | { kind: "uncertain" }
  | {
    kind: "record"; attemptId: string; userId: number; state: "sent" | "uncertain"; clickedAt: Date; sentAt: Date | null;
    text: string; media: Media; platformMessageId: string | null;
  };

export interface OutreachSendDecision {
  outcome: OutreachSendOutcome;
  writes: OutreachSendWrite[];
}

/** How a stored send reads: a claim past its ticket is `uncertain`. */
export function outreachSendViewState(send: Pick<OutreachSendRow, "state" | "ticketUntil">, now: Date): OutreachSendState {
  if (send.state !== "sending") return send.state;
  return send.ticketUntil === null || send.ticketUntil.getTime() <= now.getTime() ? "uncertain" : "sending";
}

const done = (outcome: OutreachSendOutcome): OutreachSendDecision => ({ outcome, writes: [] });

/**
 * One action on one fan of one outreach (spec §5):
 *
 * - `claim` passes when the fan has no send in this outreach or it `failed`, and no other outreach of the page holds a
 *   live claim on the fan: `sending` with a ticket of OUTREACH_SEND_TICKET_MS. Else `taken` (this outreach's send went,
 *   may have or is on its way) or `busy` (another outreach's is on its way). The same attempt claiming again inside its
 *   ticket is a repeat: `ok`, nothing changes. Other outreaches' claims past their ticket are stored `uncertain` first:
 *   the fan's one slot of the page is the claim's.
 * - `sent` / `failed` — the claim's own attempt only (`not_yours` else), from `sending` (live or past its ticket) or
 *   `uncertain`: a late report still lands. The same report again is `ok`.
 * - `uncertain` — the claim's own attempt, from `sending`; again — `ok`.
 * - `record` — a send made before the outreach reached Hub: taken for a fan with no send (or a failed one), as the
 *   client knew it, `sent` or `uncertain`; the same record again is `ok`; else `taken`.
 *
 * A sent report's moment is the report's, but never later than the claim's ticket: a report that comes late went
 * near its click.
 */
export function decideOutreachSend(snapshot: OutreachSendSnapshot, request: OutreachSendRequest): OutreachSendDecision {
  const { now, send } = snapshot;
  const view = send === null ? null : outreachSendViewState(send, now);
  const mine = send !== null && send.attemptId === request.attemptId.toLowerCase() && send.senderUserId === request.userId;
  switch (request.action) {
    case "claim": {
      if (send !== null) {
        if (mine && view === "sending") return done("ok");
        if (view !== "failed") return done("taken");
      }
      if (snapshot.othersSending.some((other) => other.ticketUntil !== null && other.ticketUntil.getTime() > now.getTime())) {
        return done("busy");
      }
      return {
        outcome: "ok",
        writes: [
          ...snapshot.othersSending.map((other): OutreachSendWrite => ({ kind: "settle_other", outreachId: other.outreachId })),
          {
            kind: "claim", attemptId: request.attemptId.toLowerCase(), userId: request.userId, clickedAt: now,
            ticketUntil: new Date(now.getTime() + OUTREACH_SEND_TICKET_MS), text: request.text, media: request.media,
          },
        ],
      };
    }
    case "sent": {
      if (!mine) return done("not_yours");
      if (send.state === "sent") return done("ok");
      if (send.state === "failed") return done("not_yours");
      const sentAt = new Date(Math.min(now.getTime(), send.clickedAt.getTime() + OUTREACH_SEND_TICKET_MS));
      return { outcome: "ok", writes: [{ kind: "sent", sentAt, platformMessageId: request.platformMessageId }] };
    }
    case "failed": {
      if (!mine) return done("not_yours");
      if (send.state === "failed") return done("ok");
      if (send.state === "sent") return done("not_yours");
      return { outcome: "ok", writes: [{ kind: "failed", code: request.code }] };
    }
    case "uncertain": {
      if (!mine) return done("not_yours");
      if (send.state === "uncertain") return done("ok");
      if (send.state !== "sending") return done("not_yours");
      return { outcome: "ok", writes: [{ kind: "uncertain" }] };
    }
    case "record": {
      if (send !== null) {
        // The same attempt recorded again: «may have gone» becomes «went» when the client knows it went (another tab
        // of the person recorded it while it was still on its way); anything else changes nothing.
        if (mine) {
          if (request.state === "sent" && view === "uncertain") {
            const clickedAt = request.clickedAt.getTime();
            const sentAt = new Date(Math.min(now.getTime(), Math.max(clickedAt, request.sentAt?.getTime() ?? clickedAt)));
            return { outcome: "ok", writes: [{ kind: "sent", sentAt, platformMessageId: request.platformMessageId }] };
          }
          return done("ok");
        }
        if (view !== "failed") return done("taken");
      }
      const clicked = request.clickedAt.getTime();
      const sentAt = request.state === "sent"
        ? new Date(Math.min(now.getTime(), Math.max(clicked, request.sentAt?.getTime() ?? clicked)))
        : null;
      return {
        outcome: "ok",
        writes: [{
          kind: "record", attemptId: request.attemptId.toLowerCase(), userId: request.userId, state: request.state,
          clickedAt: request.clickedAt, sentAt, text: request.text, media: request.media,
          platformMessageId: request.state === "sent" ? request.platformMessageId : null,
        }],
      };
    }
  }
}

/**
 * When a `record`'s click is taken: at most OUTREACH_RECORD_MAX_AGE_MS old and not in the future, a browser's clock
 * running up to OUTREACH_CLOCK_SKEW_MS ahead read as now. Null — refused.
 */
export function outreachRecordClickedAt(clickedAt: Date, now: Date): Date | null {
  const at = clickedAt.getTime();
  if (!Number.isFinite(at)) return null;
  if (at > now.getTime() + OUTREACH_CLOCK_SKEW_MS || at < now.getTime() - OUTREACH_RECORD_MAX_AGE_MS) return null;
  return at > now.getTime() ? now : clickedAt;
}

/** A first save's moment of making: its own `createdAt` within [now − 30 days, now], else the nearest bound. */
export function outreachCreatedAt(createdAt: Date | null, now: Date): Date {
  if (createdAt === null || !Number.isFinite(createdAt.getTime())) return now;
  const at = Math.min(now.getTime(), Math.max(now.getTime() - OUTREACH_CREATED_MAX_AGE_MS, createdAt.getTime()));
  return new Date(at);
}

// ── the archive's proof ────────────────────────────────────────────────────

/**
 * A message's text as the archive and the client compare it (spec §5): HTML tags away, entities decoded, every run
 * of white space one space, lower case.
 */
export function normalizeOutreachText(text: string): string {
  return normalizeDmMessageText(text).normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

const prefixOf = (text: string) => Array.from(normalizeOutreachText(text)).slice(0, OUTREACH_EVIDENCE_PREFIX).join("");

/** The archived text is the sent one: their first OUTREACH_EVIDENCE_PREFIX normalized characters agree. */
export function outreachTextMatches(sentText: string, archivedText: string): boolean {
  const sent = prefixOf(sentText);
  return sent !== "" && sent === prefixOf(archivedText);
}

/** Whether an uncertain-reading send is asked of the archive now: within OUTREACH_EVIDENCE_MAX_AGE_MS of its click. */
export function outreachEvidenceDue(send: Pick<OutreachSendRow, "state" | "ticketUntil" | "clickedAt">, now: Date): boolean {
  return outreachSendViewState(send, now) === "uncertain" && send.clickedAt.getTime() > now.getTime() - OUTREACH_EVIDENCE_MAX_AGE_MS;
}

/** The window the page's message must have been written in. */
export function outreachEvidenceWindow(clickedAt: Date): { from: Date; to: Date } {
  return {
    from: new Date(clickedAt.getTime() - OUTREACH_EVIDENCE_BEFORE_MS),
    to: new Date(clickedAt.getTime() + OUTREACH_EVIDENCE_AFTER_MS),
  };
}

/**
 * The page's message in the fan's chats that proves the send: written in the window, with the sent text; the
 * earliest of them. Null — the archive proves nothing (it never proves a send did not go).
 */
export function pickOutreachEvidence<M extends { at: Date; text: string }>(
  send: { clickedAt: Date; text: string },
  messages: readonly M[],
): M | null {
  const { from, to } = outreachEvidenceWindow(send.clickedAt);
  let best: M | null = null;
  for (const message of messages) {
    const at = message.at.getTime();
    if (at < from.getTime() || at > to.getTime() || !outreachTextMatches(send.text, message.text)) continue;
    if (best === null || at < best.at.getTime()) best = message;
  }
  return best;
}
