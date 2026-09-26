// Wave 2 corrections — the message-fact candidate reducer (build spec Wave 2
// + v7 amendment 8: "the candidate reducer REPLACES both wave-1 merge paths
// (no competing writers)"). Every material writer — webhook cold-archive,
// REST readthrough, command sends-as-facts — builds a MessageFactCandidate
// and reduces it here. The amendment-3 per-field precedence tables are pinned
// VERBATIM in mergeCandidate below; the Wave-1 SQL merges are superseded
// history.
//
// Per-field presence: `undefined` = the source did not observe the field
// (never participates in the merge); `null` = observed-as-null. The merged
// row is the REDUCED HEAD; material_fingerprint is computed from it (never
// from raw inputs — amendment 8). emitted_* bookkeeping follows design note
// §1: webhook INSERTs set emitted = material (the same journal row feeds the
// canonicalizer, which emits the first ledger event with this material);
// REST/command INSERTs leave emitted NULL (no canonicalizer emits message
// events for them — the corrections reconciler appends their first events);
// UPDATEs never touch emitted (the reconciler owns advancing it).
//
// Concurrency: the erasure fence shared try-lock + scope check run inside
// the same transaction (inherited from Wave 1, decision #121); the row is
// SELECTed FOR UPDATE so concurrent candidates for one message serialize;
// an INSERT race is resolved by onConflictDoNothing + re-select.

import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { dmMessageArchive } from "../schema.ts";
import {
  computeDmMaterialFingerprint,
  type DmMaterialTuple,
} from "./dm-material-fingerprint.ts";
import {
  isDmArchiveScopeFenced,
  tryAcquireDmArchiveWriterFenceLock,
} from "./erasure-fence.ts";
import type { DmMessageArchiveMediaItem } from "./dm-message-archive.ts";

export type DmCandidateSource = "webhook" | "rest_reconcile" | "command";

type ArchiveRow = typeof dmMessageArchive.$inferSelect;

export interface MessageFactCandidate {
  source: DmCandidateSource;
  platform: "onlyfans";
  platformAccountId: number;
  ofapiAccountId: string;
  platformMessageId: string;
  /** Material fields; undefined = not observed by this source. */
  platformConversationId?: string | null;
  fanPlatformUserId?: string | null;
  senderPlatformUserId?: string | null;
  senderRole?: "fan" | "model" | "system" | "unknown";
  isSentByMe?: boolean;
  messageCreatedAt?: Date | null;
  textPlain?: string;
  priceMills?: bigint | null;
  isOpened?: boolean | null;
  isTip?: boolean;
  tipAmountMills?: bigint;
  inReplyToMessageId?: string | null;
  mediaMetadata?: DmMessageArchiveMediaItem[];
  /** Webhook provenance (required for source='webhook'). */
  sourceEventType?: "messages.received" | "messages.sent";
  sourceIdempotencyKey: string;
  sourceJournalId?: number | null;
  sourceFanoutSeq?: number | null;
  /** Producer receipt time: webhook received_at / observation received_at /
   * command confirm time. Drives the webhook W monotonicity predicate. */
  sourceReceivedAt: Date;
  /** REST provenance (required for source='rest_reconcile'). */
  restMaterialObservationId?: number;
  /** The platform's own edit time (REST changedAt) — Wave-2 ordering input. */
  restPlatformChangedAt?: Date | null;
  rawShapeVersion?: string;
  retentionPolicy: string;
  retainUntil: Date;
}

export type DmCandidateReduceStatus = "deferred" | "fenced" | "written" | "noop";

export interface DmCandidateReduceResult {
  status: DmCandidateReduceStatus;
  row?: ArchiveRow;
  /** True when the 13-field material tuple advanced (written only). */
  materialChanged?: boolean;
}

/** advance_opened(old,new): TRUE if either TRUE; else FALSE if either FALSE;
 * else NULL — monotone, never true→false (amendment 3). */
export function advanceOpened(
  oldValue: boolean | null,
  incoming: boolean | null | undefined,
): boolean | null {
  const next = incoming === undefined ? null : incoming;
  if (oldValue === true || next === true) return true;
  if (oldValue === false || next === false) return false;
  return null;
}

function maxBigint(a: bigint, b: bigint): bigint {
  return a >= b ? a : b;
}

function sortedMediaKey(media: Array<Record<string, unknown>>): string {
  return JSON.stringify(
    [...media].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? ""))),
  );
}

interface MergedMaterial extends DmMaterialTuple {
  /** Field names whose merged value the CANDIDATE set/changed — the
   * material_field_provenance update set. */
  fieldsSetByCandidate: string[];
}

function tupleOfRow(row: ArchiveRow): DmMaterialTuple {
  return {
    senderPlatformUserId: row.senderPlatformUserId,
    senderRole: row.senderRole,
    isSentByMe: row.isSentByMe,
    messageCreatedAt: row.messageCreatedAt,
    textPlain: row.textPlain,
    priceMills: row.priceMills,
    isOpened: row.isOpened,
    isTip: row.isTip,
    tipAmountMills: row.tipAmountMills,
    inReplyToMessageId: row.inReplyToMessageId,
    platformConversationId: row.platformConversationId,
    fanPlatformUserId: row.fanPlatformUserId,
    mediaMetadata: row.mediaMetadata,
  };
}

function materialEquals(a: DmMaterialTuple, b: DmMaterialTuple): boolean {
  return a.senderPlatformUserId === b.senderPlatformUserId
    && a.senderRole === b.senderRole
    && a.isSentByMe === b.isSentByMe
    && (a.messageCreatedAt?.getTime() ?? null) === (b.messageCreatedAt?.getTime() ?? null)
    && a.textPlain === b.textPlain
    && (a.priceMills ?? null) === (b.priceMills ?? null)
    && a.isOpened === b.isOpened
    && a.isTip === b.isTip
    && a.tipAmountMills === b.tipAmountMills
    && a.inReplyToMessageId === b.inReplyToMessageId
    && a.platformConversationId === b.platformConversationId
    && a.fanPlatformUserId === b.fanPlatformUserId
    && sortedMediaKey(a.mediaMetadata) === sortedMediaKey(b.mediaMetadata);
}

/** The amendment-3 precedence tables, pinned. `old` is the current reduced
 * head; returns the next head. Fill semantics: an `undefined` candidate
 * field NEVER participates. */
export function mergeCandidate(
  old: DmMaterialTuple & { restMaterialObservationId: number | null; sourceReceivedAt: Date },
  candidate: MessageFactCandidate,
): MergedMaterial {
  // P := tombstone-stub hydration predicate (existing row lacks createdAt).
  const P = old.messageCreatedAt === null;
  // W := webhook may replace webhook-owned material; once REST advanced the
  // row, webhook is fill-only + monotone (until platform-change ordering).
  const W = candidate.source === "webhook"
    && (P || (old.restMaterialObservationId === null
      && candidate.sourceReceivedAt.getTime() >= old.sourceReceivedAt.getTime()));

  const setBy: string[] = [];
  const pick = <T>(field: string, next: T, current: T, changed: (x: T, y: T) => boolean = (x, y) => x !== y): T => {
    if (changed(next, current)) {
      setBy.push(field);
    }
    return next;
  };
  const coalesce = <T>(a: T | null | undefined, b: T | null): T | null =>
    a === undefined || a === null ? b : a;

  // ids / createdAt / price / reply / scope refs.
  const fillOrPrefer = <T>(field: string, incoming: T | null | undefined, current: T | null): T | null => {
    const next = W
      ? coalesce(incoming, current)
      : coalesce(current, incoming === undefined ? null : incoming);
    return pick(field, next, current);
  };

  const senderPlatformUserId = fillOrPrefer("senderPlatformUserId", candidate.senderPlatformUserId, old.senderPlatformUserId);
  const platformConversationId = fillOrPrefer("platformConversationId", candidate.platformConversationId, old.platformConversationId);
  const fanPlatformUserId = fillOrPrefer("fanPlatformUserId", candidate.fanPlatformUserId, old.fanPlatformUserId);
  const inReplyToMessageId = fillOrPrefer("inReplyToMessageId", candidate.inReplyToMessageId, old.inReplyToMessageId);
  const priceMills = fillOrPrefer("priceMills", candidate.priceMills, old.priceMills);
  const messageCreatedAt = pick(
    "messageCreatedAt",
    W
      ? candidate.messageCreatedAt ?? old.messageCreatedAt
      : old.messageCreatedAt ?? candidate.messageCreatedAt ?? null,
    old.messageCreatedAt,
    (x, y) => (x?.getTime() ?? null) !== (y?.getTime() ?? null),
  );

  // sender_role: incoming when W; else incoming only when old='unknown'.
  const senderRole = pick(
    "senderRole",
    candidate.senderRole !== undefined && (W || old.senderRole === "unknown")
      ? candidate.senderRole
      : old.senderRole,
    old.senderRole,
  );

  // is_sent_by_me: incoming only when P (stub hydration).
  const isSentByMe = pick(
    "isSentByMe",
    P && candidate.isSentByMe !== undefined ? candidate.isSentByMe : old.isSentByMe,
    old.isSentByMe,
  );

  // text: W → replace when incoming non-empty; else fill only an empty old.
  const incomingText = candidate.textPlain;
  const textPlain = pick(
    "textPlain",
    incomingText !== undefined && incomingText !== "" && (W || old.textPlain === "")
      ? incomingText
      : old.textPlain,
    old.textPlain,
  );

  // media: W → replace when incoming non-empty; else fill only an empty old.
  const incomingMedia = candidate.mediaMetadata as unknown as
    | Array<Record<string, unknown>>
    | undefined;
  const mediaMetadata = pick(
    "mediaMetadata",
    incomingMedia !== undefined && incomingMedia.length > 0
      && (W || old.mediaMetadata.length === 0)
      ? incomingMedia
      : old.mediaMetadata,
    old.mediaMetadata,
    (x, y) => sortedMediaKey(x) !== sortedMediaKey(y),
  );

  // is_opened ALWAYS advances monotonically; is_tip ORs; tip GREATESTs.
  const isOpened = pick("isOpened", advanceOpened(old.isOpened, candidate.isOpened), old.isOpened);
  const isTip = pick("isTip", old.isTip || (candidate.isTip ?? false), old.isTip);
  const tipAmountMills = pick(
    "tipAmountMills",
    candidate.tipAmountMills === undefined
      ? old.tipAmountMills
      : maxBigint(old.tipAmountMills, candidate.tipAmountMills),
    old.tipAmountMills,
  );

  return {
    senderPlatformUserId,
    senderRole,
    isSentByMe,
    messageCreatedAt,
    textPlain,
    priceMills,
    isOpened,
    isTip,
    tipAmountMills,
    inReplyToMessageId,
    platformConversationId,
    fanPlatformUserId,
    mediaMetadata,
    fieldsSetByCandidate: setBy,
  };
}

function earliest(...dates: Array<Date | null | undefined>): Date {
  const known = dates.filter((value): value is Date => value != null);
  return known.reduce((min, value) => (value < min ? value : min));
}

function provenanceUpdate(
  current: Record<string, string>,
  fields: readonly string[],
  source: DmCandidateSource | "ppv_unlocked",
): Record<string, string> {
  if (fields.length === 0) {
    return current;
  }
  const next = { ...current };
  for (const field of fields) {
    next[field] = source;
  }
  return next;
}

async function selectRowForUpdate(
  db: Database,
  candidate: MessageFactCandidate,
): Promise<ArchiveRow | null> {
  const [row] = await db
    .select()
    .from(dmMessageArchive)
    .where(and(
      eq(dmMessageArchive.platform, candidate.platform),
      eq(dmMessageArchive.ofapiAccountId, candidate.ofapiAccountId),
      eq(dmMessageArchive.platformMessageId, candidate.platformMessageId),
    ))
    .for("update");
  return row ?? null;
}

/**
 * Reduce one candidate into the material head. Ordering per amendment 8 is
 * the CALLER pipeline's: this projects the candidate merge and advances
 * material_fingerprint; the corrections reconciler appends ledger events and
 * advances emitted_* separately.
 */
export async function reduceDmMessageCandidate(
  db: Database,
  candidate: MessageFactCandidate,
): Promise<DmCandidateReduceResult> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    if (!(await tryAcquireDmArchiveWriterFenceLock(database, candidate.platformAccountId))) {
      return { status: "deferred" as const };
    }
    if (
      await isDmArchiveScopeFenced(database, {
        pageId: candidate.platformAccountId,
        refs: [
          candidate.fanPlatformUserId,
          candidate.platformConversationId,
          candidate.senderPlatformUserId,
        ],
        materialAt: earliest(candidate.messageCreatedAt, candidate.sourceReceivedAt),
      })
    ) {
      return { status: "fenced" as const };
    }

    let existing = await selectRowForUpdate(database, candidate);

    if (!existing) {
      const insertMaterial: DmMaterialTuple = {
        senderPlatformUserId: candidate.senderPlatformUserId ?? null,
        senderRole: candidate.senderRole ?? "unknown",
        isSentByMe: candidate.isSentByMe ?? false,
        messageCreatedAt: candidate.messageCreatedAt ?? null,
        textPlain: candidate.textPlain ?? "",
        priceMills: candidate.priceMills ?? null,
        isOpened: candidate.isOpened ?? null,
        isTip: candidate.isTip ?? false,
        tipAmountMills: candidate.tipAmountMills ?? 0n,
        inReplyToMessageId: candidate.inReplyToMessageId ?? null,
        platformConversationId: candidate.platformConversationId ?? null,
        fanPlatformUserId: candidate.fanPlatformUserId ?? null,
        mediaMetadata: (candidate.mediaMetadata ?? []) as unknown as Array<Record<string, unknown>>,
      };
      const fingerprint = computeDmMaterialFingerprint(insertMaterial);
      const observedFields = Object.entries(candidate)
        .filter(([key, value]) => value !== undefined && key in insertMaterial)
        .map(([key]) => key);
      const [inserted] = await database
        .insert(dmMessageArchive)
        .values({
          platform: candidate.platform,
          platformAccountId: candidate.platformAccountId,
          ofapiAccountId: candidate.ofapiAccountId,
          platformConversationId: insertMaterial.platformConversationId,
          fanPlatformUserId: insertMaterial.fanPlatformUserId,
          platformMessageId: candidate.platformMessageId,
          senderPlatformUserId: insertMaterial.senderPlatformUserId,
          senderRole: insertMaterial.senderRole as "fan" | "model" | "system" | "unknown",
          isSentByMe: insertMaterial.isSentByMe,
          messageCreatedAt: insertMaterial.messageCreatedAt,
          textPlain: insertMaterial.textPlain,
          priceMills: insertMaterial.priceMills,
          isOpened: insertMaterial.isOpened,
          isTip: insertMaterial.isTip,
          tipAmountMills: insertMaterial.tipAmountMills,
          inReplyToMessageId: insertMaterial.inReplyToMessageId,
          source: candidate.source === "rest_reconcile" ? "rest_reconcile" : candidate.source,
          sourceEventType: candidate.sourceEventType
            ?? (insertMaterial.isSentByMe ? "messages.sent" : "messages.received"),
          sourceIdempotencyKey: candidate.sourceIdempotencyKey,
          sourceJournalId: candidate.sourceJournalId ?? null,
          sourceFanoutSeq: candidate.sourceFanoutSeq ?? null,
          sourceReceivedAt: candidate.sourceReceivedAt,
          rawShapeVersion: candidate.rawShapeVersion ?? "ofapi-message-v1",
          mediaMetadata: insertMaterial.mediaMetadata,
          retentionPolicy: candidate.retentionPolicy,
          retainUntil: candidate.retainUntil,
          materialFingerprint: fingerprint,
          // Design note §1: webhook first-writes are (or will be) in the
          // ledger via the canonicalizer over the same journal row — emitted
          // = material keeps the reconciler from re-appending; REST/command
          // rows have no canonicalizer lane, emitted stays NULL and the
          // reconciler appends their FIRST event.
          emittedFingerprint: candidate.source === "webhook" ? fingerprint : null,
          emittedEventId: null,
          revisionNo: 1,
          materialFieldProvenance: provenanceUpdate({}, observedFields, candidate.source),
          ...(candidate.source === "rest_reconcile"
            ? {
              restMaterialObservationId: candidate.restMaterialObservationId ?? null,
              restMaterialObservedAt: candidate.sourceReceivedAt,
              restPlatformChangedAt: candidate.restPlatformChangedAt ?? null,
            }
            : {}),
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [
            dmMessageArchive.platform,
            dmMessageArchive.ofapiAccountId,
            dmMessageArchive.platformMessageId,
          ],
        })
        .returning();
      if (inserted) {
        return { status: "written" as const, row: inserted, materialChanged: true };
      }
      // Lost the insert race — reduce as an update against the winner.
      existing = await selectRowForUpdate(database, candidate);
      if (!existing) {
        // Winner's tx not yet visible — defer to the caller's retry lane.
        return { status: "deferred" as const };
      }
    }

    const merged = mergeCandidate(
      {
        ...tupleOfRow(existing),
        restMaterialObservationId: existing.restMaterialObservationId,
        sourceReceivedAt: existing.sourceReceivedAt,
      },
      candidate,
    );
    if (materialEquals(merged, tupleOfRow(existing))) {
      return { status: "noop" as const, row: existing };
    }

    const fingerprint = computeDmMaterialFingerprint(merged);
    const isWebhook = candidate.source === "webhook";
    const isRest = candidate.source === "rest_reconcile";
    const [updated] = await database
      .update(dmMessageArchive)
      .set({
        senderPlatformUserId: merged.senderPlatformUserId,
        senderRole: merged.senderRole as "fan" | "model" | "system" | "unknown",
        isSentByMe: merged.isSentByMe,
        messageCreatedAt: merged.messageCreatedAt,
        textPlain: merged.textPlain,
        priceMills: merged.priceMills,
        isOpened: merged.isOpened,
        isTip: merged.isTip,
        tipAmountMills: merged.tipAmountMills,
        inReplyToMessageId: merged.inReplyToMessageId,
        platformConversationId: merged.platformConversationId,
        fanPlatformUserId: merged.fanPlatformUserId,
        mediaMetadata: merged.mediaMetadata,
        materialFingerprint: fingerprint,
        materialFieldProvenance: provenanceUpdate(
          existing.materialFieldProvenance,
          merged.fieldsSetByCandidate,
          candidate.source,
        ),
        // Webhook provenance moves only on material change (Wave-1 guard
        // semantics); REST provenance likewise; command updates touch none.
        ...(isWebhook
          ? {
            source: "webhook" as const,
            sourceEventType: candidate.sourceEventType
              ?? (merged.isSentByMe ? "messages.sent" as const : "messages.received" as const),
            sourceIdempotencyKey: candidate.sourceIdempotencyKey,
            sourceJournalId: candidate.sourceJournalId ?? null,
            sourceFanoutSeq: candidate.sourceFanoutSeq ?? null,
            sourceReceivedAt: candidate.sourceReceivedAt,
            rawShapeVersion: candidate.rawShapeVersion ?? "ofapi-message-v1",
            retentionPolicy: candidate.retentionPolicy,
            retainUntil: candidate.retainUntil,
          }
          : {}),
        ...(isRest
          ? {
            restMaterialObservationId: candidate.restMaterialObservationId ?? null,
            restMaterialObservedAt: candidate.sourceReceivedAt,
            restPlatformChangedAt: candidate.restPlatformChangedAt
              ?? existing.restPlatformChangedAt,
          }
          : {}),
        updatedAt: now,
      })
      .where(eq(dmMessageArchive.id, existing.id))
      .returning();

    return { status: "written" as const, row: updated!, materialChanged: true };
  });
}

export type DmPurchaseFactStatus =
  /** is_opened moved to TRUE. */
  | "written"
  /** Already TRUE — nothing to do (monotonic, idempotent). */
  | "noop"
  /** No material row for this message (yet) — never inserted from here. */
  | "missing";

/**
 * H2 (INC-001): records a PPV PURCHASE on the OF material head —
 * `is_opened` moves to TRUE and never back (advance_opened, amendment 3).
 *
 * A dedicated single-field writer, not a reducer candidate: a purchase is an
 * annotation on a message that already exists, so it NEVER inserts (a stub
 * built from a notification would be a message with no material), and it
 * touches no source_* provenance (the webhook candidate path would overwrite
 * the message's own journal lineage with the notification's). UPDATE-only,
 * so there is nothing for the erasure fence to guard against resurrecting.
 *
 * Fingerprints: material_fingerprint is recomputed from the reduced head, as
 * every material write must. emitted_fingerprint advances WITH it only when
 * the row was in sync before (emitted = old material): the purchase's ledger
 * lane is message.ppv_unlocked, and letting the corrections reconciler mint a
 * superseding message.* event for it would put every purchase on the stream
 * twice — and a backfill would replay hundreds of old messages to every
 * connected client as live frames. A row that was already out of sync stays
 * flagged; the reconciler's next superseding head then simply carries
 * isOpened = true. A row the fingerprint backfill has not reached yet (or a
 * null-ref stub) keeps NULL fingerprints — the backfill computes them from the
 * row, purchase included.
 */
export async function applyDmMessagePurchaseFact(
  db: Database,
  input: {
    platform: "onlyfans";
    ofapiAccountId: string;
    platformMessageId: string;
  },
): Promise<{ status: DmPurchaseFactStatus; row?: ArchiveRow }> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const [existing] = await database
      .select()
      .from(dmMessageArchive)
      .where(and(
        eq(dmMessageArchive.platform, input.platform),
        eq(dmMessageArchive.ofapiAccountId, input.ofapiAccountId),
        eq(dmMessageArchive.platformMessageId, input.platformMessageId),
      ))
      .for("update");
    if (!existing) {
      return { status: "missing" as const };
    }
    const isOpened = advanceOpened(existing.isOpened, true);
    if (isOpened === existing.isOpened) {
      return { status: "noop" as const, row: existing };
    }

    const oldMaterial = existing.materialFingerprint;
    const nextMaterial = oldMaterial === null
      ? null
      : computeDmMaterialFingerprint({ ...tupleOfRow(existing), isOpened });
    const inSync = oldMaterial !== null
      && existing.emittedFingerprint !== null
      && existing.emittedFingerprint.equals(oldMaterial);
    const [updated] = await database
      .update(dmMessageArchive)
      .set({
        isOpened,
        materialFingerprint: nextMaterial,
        ...(inSync ? { emittedFingerprint: nextMaterial } : {}),
        materialFieldProvenance: provenanceUpdate(
          existing.materialFieldProvenance,
          ["isOpened"],
          "ppv_unlocked",
        ),
        updatedAt: new Date(),
      })
      .where(eq(dmMessageArchive.id, existing.id))
      .returning();
    return { status: "written" as const, row: updated! };
  });
}

/** Repair-signal work list for the corrections reconciler: rows whose
 * material advanced past the ledger (or never reached it). Null-ref stubs
 * are EXCLUDED here and counted by the caller separately (preamble 3):
 * a stub has message_created_at NULL and both fingerprints NULL, which the
 * partial index already skips; hydrated-but-refless rows are surfaced so
 * the runner can skip-and-count them explicitly. */
export async function listDmRepairSignalRows(
  db: Database,
  input: { afterId?: number | null; limit?: number },
): Promise<ArchiveRow[]> {
  const limit = input.limit ?? 100;
  const conditions = [
    sql`${dmMessageArchive.materialFingerprint} is distinct from ${dmMessageArchive.emittedFingerprint}`,
    sql`${dmMessageArchive.materialFingerprint} is not null`,
  ];
  if (input.afterId != null) {
    conditions.push(sql`${dmMessageArchive.id} > ${input.afterId}`);
  }
  return db
    .select()
    .from(dmMessageArchive)
    .where(and(...conditions))
    .orderBy(dmMessageArchive.id)
    .limit(limit);
}

/** Advance the ledger bookkeeping after an event append (reconciler only).
 * Guarded on the fingerprint still matching what was emitted — a concurrent
 * material advance keeps the row flagged for the next pass. */
export async function advanceDmEmittedFingerprint(
  db: Database,
  input: {
    rowId: number;
    fingerprint: Buffer;
    eventId: number;
    /** True when this was a SUPERSEDING append (bumps revision_no). */
    superseding: boolean;
  },
): Promise<boolean> {
  const result = await db
    .update(dmMessageArchive)
    .set({
      emittedFingerprint: input.fingerprint,
      emittedEventId: input.eventId,
      ...(input.superseding
        ? { revisionNo: sql`${dmMessageArchive.revisionNo} + 1` }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(dmMessageArchive.id, input.rowId),
      sql`${dmMessageArchive.materialFingerprint} = ${input.fingerprint}`,
    ))
    .returning({ id: dmMessageArchive.id });
  return result.length > 0;
}
