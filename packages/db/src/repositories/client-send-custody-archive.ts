import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { reportClientSentOnProof, type ClientSentOnProofResult } from "./client-claim.ts";
import type { ClientClaimPurpose, ClientCustodyRow, ClientCustodyStoredState } from "./client-claim-transition.ts";
import { insertObservation } from "./observations.ts";

// A Fansly greeting held only because Fansly's live channel dropped its echo
// (owner, 2026-11-07). Since 2026-11-05 Fansly broadcasts no new-message event
// for some messages it took; the extension reports `sent` only on that echo, so
// such a greeting stays `dispatching` past its ticket (uncertain-held) although
// Fansly gave it a message id and Hub's own archive of the page has it. Hub
// closes it itself, on behalf of the install that dispatched it, when its own
// tables prove that very message went out:
//
//   1. the same person reported a send to this fan within ±30 s of the dispatch
//      (client_send_attributions: the receipt's message id), and it is the
//      only such report not already another send's;
//   2. the page's archive (message_archive) has that message as the page's own,
//      in the attribution's chat, not deleted;
//   3. no other send carries that message id (another custody row of the page,
//      or the fan's greeting as another attempt's first part).
//
// The archive's copy is the confirmation, as the extension's own history read
// is: the rule "Fansly's response plus a confirmation" stands. Database only:
// nothing here sends, re-sends or asks Fansly anything. The close is the
// dispatcher's `sent` report through the same rules (reportClientSentOnProof),
// under the fan's lock, journaled in `observations` first; a report of the
// extension that lands first wins and the close then writes nothing.

/** How far from the dispatch the person's own report of the send may be. */
export const CLIENT_SEND_ARCHIVE_PROOF_WINDOW_MS = 30_000;
/** How long past its ticket a send waits before Hub looks: a late echo of the client wins. */
export const CLIENT_SEND_ARCHIVE_GRACE_MS = 60_000;
/** The journal's kind of one close (apps/runtime services/observation-kinds.ts). */
export const CLIENT_SEND_ARCHIVE_PROOF_KIND = "client.send_custody_archive_proof.v1";
export const CLIENT_SEND_ARCHIVE_PROOF_PRODUCER = "hub:send-custody-archive";

export interface HeldSendArchiveCustody {
  attemptId: string;
  pageId: number;
  fanRef: string;
  userId: number;
  instanceId: string;
  /** The page's platform. */
  platform: string;
  origin: ClientCustodyRow["origin"];
  purpose: ClientClaimPurpose;
  partCount: number;
  state: ClientCustodyStoredState;
  ticketExpiresAt: Date | null;
  createdAt: Date;
}

export interface HeldSendArchiveAttribution {
  platformMessageId: string;
  userId: number;
  fanRef: string;
  conversationRef: string | null;
  observedAt: Date;
  source: string;
  composedWith: string | null;
  observationId: number | null;
  /** Another send carries this message id: another custody row of the page, or the fan's greeting as another attempt's first part. */
  boundElsewhere: boolean;
  /** The page's own archive copy of the message; null when Hub has none. */
  archive: {
    id: number;
    sentByMe: boolean;
    deleted: boolean;
    conversationRef: string | null;
    occurredAt: Date | null;
  } | null;
}

/** One held send and every report of a send to its fan around its dispatch. */
export interface HeldSendArchiveEvidence {
  now: Date;
  custody: HeldSendArchiveCustody;
  attributions: readonly HeldSendArchiveAttribution[];
}

export type HeldSendArchiveSkipReason =
  /** Not a dispatch past its ticket and the grace (sent, failed, resolved, set aside, or still in flight). */
  | "not_held"
  /** Not a one-part greeting sent from the preview on Fansly. */
  | "not_fansly_greeting"
  /** No report of a send by the dispatcher to this fan within the window. */
  | "no_attribution"
  /** Every such report is another send's already. */
  | "taken"
  /** More than one report could be this send: Hub cannot tell which, a person resolves it. */
  | "ambiguous"
  /** The one report's message is not in the page's archive as its own, in that chat, not deleted. */
  | "not_in_archive";

export type HeldSendArchiveDecision =
  | { close: true; attribution: HeldSendArchiveAttribution; platformMessageId: string; sentAt: Date }
  | { close: false; reason: HeldSendArchiveSkipReason };

/** The rule, without a database. Every condition must hold, or the send is left as it is. */
export function decideHeldSendArchiveProof(evidence: HeldSendArchiveEvidence): HeldSendArchiveDecision {
  const { custody, now } = evidence;
  if (custody.platform !== "fansly" || custody.origin !== "preview-send" || custody.purpose !== "greeting"
    || custody.partCount !== 1) return { close: false, reason: "not_fansly_greeting" };
  if (custody.state !== "dispatching" || custody.ticketExpiresAt === null
    || custody.ticketExpiresAt.getTime() > now.getTime() - CLIENT_SEND_ARCHIVE_GRACE_MS) {
    return { close: false, reason: "not_held" };
  }
  const near = evidence.attributions.filter((row) => row.userId === custody.userId && row.fanRef === custody.fanRef
    && Math.abs(row.observedAt.getTime() - custody.createdAt.getTime()) <= CLIENT_SEND_ARCHIVE_PROOF_WINDOW_MS);
  if (near.length === 0) return { close: false, reason: "no_attribution" };
  const free = near.filter((row) => !row.boundElsewhere);
  if (free.length === 0) return { close: false, reason: "taken" };
  if (free.length > 1) return { close: false, reason: "ambiguous" };
  const attribution = free[0]!;
  const copy = attribution.archive;
  if (copy === null || !copy.sentByMe || copy.deleted || attribution.conversationRef === null
    || copy.conversationRef !== attribution.conversationRef) return { close: false, reason: "not_in_archive" };
  // Dated by Fansly's own clock, the one the fan's answers carry (the openers' A/B reads replies after it).
  const sentAt = copy.occurredAt ?? custody.createdAt;
  return {
    close: true, attribution, platformMessageId: attribution.platformMessageId,
    sentAt: sentAt.getTime() > now.getTime() ? now : sentAt,
  };
}

export interface HeldSendRef {
  attemptId: string;
  pageId: number;
  fanRef: string;
}

/**
 * The held one-part Fansly greetings past their ticket and the grace, newest first. A held send is
 * the fan's one open send: client_send_custody_one_open (0241) finds them, a handful.
 */
export async function listHeldSendsForArchiveProof(db: Database, input: { limit: number }): Promise<HeldSendRef[]> {
  const result = await db.execute<{ attempt_id: string; page_id: string | number; fan_ref: string }>(sql`
    select c.attempt_id::text, c.page_id, c.fan_ref
    from client_send_custody c
    join pages p on p.id = c.page_id
    where c.state = 'dispatching'
      and c.ticket_expires_at <= clock_timestamp() - make_interval(secs => ${CLIENT_SEND_ARCHIVE_GRACE_MS / 1000})
      and c.origin = 'preview-send' and c.purpose = 'greeting' and c.part_count = 1 and p.platform = 'fansly'
    order by c.created_at desc
    limit ${input.limit}`);
  return result.rows.map((row) => ({ attemptId: row.attempt_id, pageId: Number(row.page_id), fanRef: row.fan_ref }));
}

type CustodyEvidenceRow = {
  attempt_id: string; page_id: string | number; fan_ref: string; user_id: string | number; instance_id: string;
  platform: string; origin: ClientCustodyRow["origin"]; purpose: ClientClaimPurpose; part_count: number;
  state: ClientCustodyStoredState; ticket_expires_at: Date | string | null; created_at: Date | string; now: Date | string;
};

type AttributionEvidenceRow = {
  platform_message_id: string; user_id: string | number; fan_ref: string; conversation_ref: string | null;
  observed_at: Date | string; source: string; composed_with: string | null; observation_id: string | number | null;
  bound_elsewhere: boolean; archive_id: string | number | null; archive_sent_by_me: boolean | null;
  archive_deleted: boolean | null; archive_conversation_ref: string | null; archive_occurred_at: Date | string | null;
};

const date = (value: Date | string) => new Date(value);

/**
 * The evidence of one send: its custody row, and every report of a send to its fan on its page
 * observed within the window around its dispatch, each with its archive copy and whether another
 * send carries its message. Null when the page has no such attempt. The fan's reports are read
 * through client_send_attributions_fan (page, fan), the copy by the archive's unique key.
 */
export async function readHeldSendArchiveEvidence(db: Database, attemptId: string): Promise<HeldSendArchiveEvidence | null> {
  const row = (await db.execute<CustodyEvidenceRow>(sql`
    select c.attempt_id::text, c.page_id, c.fan_ref, c.user_id, c.instance_id::text, p.platform, c.origin, c.purpose,
      c.part_count, c.state, c.ticket_expires_at, c.created_at, clock_timestamp() as now
    from client_send_custody c join pages p on p.id = c.page_id
    where c.attempt_id = ${attemptId}::uuid`)).rows[0];
  if (!row) return null;
  const createdAt = date(row.created_at);
  const windowSecs = CLIENT_SEND_ARCHIVE_PROOF_WINDOW_MS / 1000;
  const attributions = (await db.execute<AttributionEvidenceRow>(sql`
    select a.platform_message_id, a.user_id, a.fan_ref, a.conversation_ref, a.observed_at, a.source, a.composed_with,
      a.observation_id,
      (exists (
        select 1 from client_send_custody o
        where o.page_id = a.page_id and o.platform_message_id = a.platform_message_id
          and o.attempt_id <> ${row.attempt_id}::uuid
      ) or exists (
        select 1 from client_greetings g
        where g.page_id = a.page_id and g.fan_ref = a.fan_ref and g.first_message_ref = a.platform_message_id
          and g.first_attempt_id is distinct from ${row.attempt_id}::uuid
      )) as bound_elsewhere,
      m.id as archive_id, m.is_sent_by_me as archive_sent_by_me, m.deleted_at is not null as archive_deleted,
      m.conversation_ref as archive_conversation_ref, m.occurred_at as archive_occurred_at
    from client_send_attributions a
    left join message_archive m
      on m.account_id = a.page_id and m.platform = a.platform and m.message_ref = a.platform_message_id
    where a.platform = ${row.platform} and a.page_id = ${row.page_id} and a.fan_ref = ${row.fan_ref}
      and a.observed_at between ${createdAt}::timestamptz - make_interval(secs => ${windowSecs})
        and ${createdAt}::timestamptz + make_interval(secs => ${windowSecs})
    order by a.observed_at, a.platform_message_id`)).rows;
  return {
    now: date(row.now),
    custody: {
      attemptId: row.attempt_id, pageId: Number(row.page_id), fanRef: row.fan_ref, userId: Number(row.user_id),
      instanceId: row.instance_id, platform: row.platform, origin: row.origin, purpose: row.purpose,
      partCount: Number(row.part_count), state: row.state,
      ticketExpiresAt: row.ticket_expires_at === null ? null : date(row.ticket_expires_at), createdAt,
    },
    attributions: attributions.map((a): HeldSendArchiveAttribution => ({
      platformMessageId: a.platform_message_id, userId: Number(a.user_id), fanRef: a.fan_ref,
      conversationRef: a.conversation_ref, observedAt: date(a.observed_at), source: a.source,
      composedWith: a.composed_with, observationId: a.observation_id === null ? null : Number(a.observation_id),
      boundElsewhere: a.bound_elsewhere,
      archive: a.archive_id === null ? null : {
        id: Number(a.archive_id), sentByMe: a.archive_sent_by_me === true, deleted: a.archive_deleted === true,
        conversationRef: a.archive_conversation_ref,
        occurredAt: a.archive_occurred_at === null ? null : date(a.archive_occurred_at),
      },
    })),
  };
}

export type HeldSendArchiveCloseResult =
  | { outcome: "gone" }
  | { outcome: "skipped"; reason: HeldSendArchiveSkipReason }
  | ClientSentOnProofResult;

/**
 * Closes one held send as sent when its evidence proves it (decideHeldSendArchiveProof). The rule
 * is read once without a lock, so a send that stays unproven costs no lock on its fan; a close
 * reads it again under the fan's lock, journals the evidence and reports `sent` for the dispatcher.
 */
export async function closeHeldSendOnArchiveProof(db: Database, ref: HeldSendRef): Promise<HeldSendArchiveCloseResult> {
  const first = await readHeldSendArchiveEvidence(db, ref.attemptId);
  if (first === null) return { outcome: "gone" };
  const decided = decideHeldSendArchiveProof(first);
  if (!decided.close) return { outcome: "skipped", reason: decided.reason };

  let proven: { evidence: HeldSendArchiveEvidence; decision: Extract<HeldSendArchiveDecision, { close: true }> } | null = null;
  return reportClientSentOnProof(db, { pageId: first.custody.pageId, fanRef: first.custody.fanRef, attemptId: ref.attemptId }, {
    prove: async (tx) => {
      const evidence = await readHeldSendArchiveEvidence(tx, ref.attemptId);
      const decision = evidence && decideHeldSendArchiveProof(evidence);
      if (!evidence || !decision?.close) return null;
      proven = { evidence, decision };
      return {
        userId: evidence.custody.userId, instanceId: evidence.custody.instanceId,
        platformMessageId: decision.platformMessageId, sentAt: decision.sentAt,
      };
    },
    journal: async (tx) => {
      const { evidence, decision } = proven!;
      const { custody } = evidence;
      const { attribution } = decision;
      const payload = {
        rule: "archive-copy.v1",
        windowMs: CLIENT_SEND_ARCHIVE_PROOF_WINDOW_MS,
        attemptId: custody.attemptId,
        pageId: custody.pageId,
        fanRef: custody.fanRef,
        userId: custody.userId,
        instanceId: custody.instanceId,
        dispatchedAt: custody.createdAt.toISOString(),
        ticketExpiresAt: custody.ticketExpiresAt?.toISOString() ?? null,
        platformMessageId: decision.platformMessageId,
        sentAt: decision.sentAt.toISOString(),
        attribution: {
          observedAt: attribution.observedAt.toISOString(),
          conversationRef: attribution.conversationRef,
          source: attribution.source,
          composedWith: attribution.composedWith,
          observationId: attribution.observationId,
        },
        archive: {
          messageArchiveId: attribution.archive!.id,
          conversationRef: attribution.archive!.conversationRef,
          occurredAt: attribution.archive!.occurredAt?.toISOString() ?? null,
        },
      };
      await insertObservation(tx, {
        source: "operator",
        producer: CLIENT_SEND_ARCHIVE_PROOF_PRODUCER,
        platform: custody.platform,
        accountId: custody.pageId,
        kind: CLIENT_SEND_ARCHIVE_PROOF_KIND,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
        idempotencyKey: `send_custody_archive_proof:${custody.attemptId}`,
        observedAt: decision.sentAt,
      });
    },
  });
}
