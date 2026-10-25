import { sql } from "drizzle-orm";

import {
  PUBLICATION_ACTIVE_STATUSES,
  PUBLICATION_DEFAULT_REPOST_THRESHOLD_DAYS,
  PUBLICATION_VOLUME_BASELINE_DAYS,
  type PublicationActorKind,
  type PublicationAttachmentAccess,
  type PublicationAuthorKind,
  type PublicationKind,
  type PublicationReplyLock,
  type PublicationStatus,
} from "@agency_hub_core/shared";

import type { Database } from "../client.ts";

// Publications (0297, docs/plans/2026-10-23-wall-posts): the rows, their status
// journal, the frozen approvals, the pages' publishing settings, and the facts
// the draft checks read (spec §8.1). Status rules live in
// @agency_hub_core/shared publications.ts and in the runtime service; this file
// only reads and writes.

/** One advisory lock per page around approval: two approvals of one file on one
 * page cannot both pass (spec §8.1 "Повтор"). Unused elsewhere. */
export const PUBLICATION_PAGE_LOCK_NAMESPACE = 58_230;

export type PublicationMediaRole = "media" | "preview";
export type PublicationMediaSource = "vault" | "file";

export interface PublicationMediaItem {
  role: PublicationMediaRole;
  position: number;
  source: PublicationMediaSource;
  /** The platform's media id (Fansly media, OnlyFans vault media) when source is vault. */
  platformMediaRef: string | null;
  fileId: number | null;
  /** Its attachment: 0 the post's own, 1… an extra one (0319). */
  attachment: number;
}

/** An extra attachment of a Fansly post (0319) and who sees it: everyone; the
 *  subscribers (of every tier or of `tierRefs`; with a price, anyone else
 *  buys it); or whoever pays (only subscribers, when `subscribersOnly`). */
export interface PublicationExtraAttachment {
  /** 1…: its place after the post's own attachment. */
  attachment: number;
  access: PublicationAttachmentAccess;
  tierRefs: readonly string[];
  priceMills: bigint | null;
  subscribersOnly: boolean;
}

export interface PublicationRecord {
  id: number;
  pageId: number;
  pageLabel: string;
  platform: string;
  kind: PublicationKind;
  status: PublicationStatus;
  version: number;
  text: string;
  publishAt: Date;
  expiresAt: Date | null;
  wallRefs: string[];
  tierRefs: string[];
  priceMills: bigint | null;
  repost: boolean;
  /** Fansly: the walls the post is pinned on (0317). */
  pinWallRefs: string[];
  /** Fansly: who may reply, any of them (0317); empty: everyone. */
  replyLock: PublicationReplyLock[];
  /** Fansly: a paid post only subscribers may buy (0317). */
  subscribersOnly: boolean;
  /** Fansly: the post's extra attachments, in order (0319). */
  extraAttachments: PublicationExtraAttachment[];
  findings: unknown[];
  authorKind: PublicationAuthorKind;
  authorUserId: number | null;
  authorAgentKeyId: number | null;
  idempotencyKey: string | null;
  approvedRevisionId: number | null;
  platformPostRef: string | null;
  statusReason: string | null;
  previousPublicationId: number | null;
  createdAt: Date;
  updatedAt: Date;
  statusChangedAt: Date;
  media: PublicationMediaItem[];
  /** Its withdrawal command, when Hub sent one (plan PR 5b): the owner action's state. */
  withdrawal: PublicationWithdrawalFacts | null;
  /** The deletion of its published Fansly post, when the owner asked for one
   *  (0305): its `post_delete` command's state, in the withdrawal's words. */
  deletion: PublicationWithdrawalFacts | null;
}

export interface PublicationWithdrawalFacts {
  state: string;
  errorCode: string | null;
  at: Date;
}

export interface PublicationContent {
  kind: PublicationKind;
  text: string;
  publishAt: Date;
  expiresAt: Date | null;
  wallRefs: readonly string[];
  tierRefs: readonly string[];
  priceMills: bigint | null;
  repost: boolean;
  pinWallRefs: readonly string[];
  replyLock: readonly PublicationReplyLock[];
  subscribersOnly: boolean;
  extraAttachments: readonly PublicationExtraAttachment[];
  media: readonly PublicationMediaItem[];
}

export interface PublicationActor {
  kind: PublicationActorKind;
  userId?: number | null;
  agentKeyId?: number | null;
}

export interface PublicationStatusEventRecord {
  id: number;
  fromStatus: PublicationStatus | null;
  toStatus: PublicationStatus;
  actorKind: PublicationActorKind;
  actorUserId: number | null;
  actorAgentKeyId: number | null;
  reason: string | null;
  revisionId: number | null;
  at: Date;
}

export interface PublicationRevisionRecord {
  id: number;
  publicationId: number;
  fingerprint: string;
  form: Record<string, unknown>;
  pageId: number;
  platformAccountRef: string | null;
  ofapiAccountRef: string | null;
  ofapiBindingGeneration: number;
  modelId: number;
  approvedByUserId: number;
  approvedAt: Date;
}

export interface PagePublishingSettingsRecord {
  pageId: number;
  enabled: boolean;
  autostopReason: string | null;
  autostoppedAt: Date | null;
  paidPriceMinMills: bigint | null;
  paidPriceMaxMills: bigint | null;
  repostThresholdDays: number;
  dailyLimit: number | null;
  updatedByUserId: number | null;
  updatedAt: Date | null;
}

/** The page as a publication sees it: who owns it and which account it is now. */
export interface PublicationPageFacts {
  id: number;
  label: string;
  platform: string;
  status: string;
  modelId: number;
  username: string | null;
  platformAccountRef: string | null;
  ofapiAccountRef: string | null;
  ofapiBindingGeneration: number;
}

type Row = Record<string, unknown>;

async function inTransaction<T>(db: Database, body: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => body(tx as unknown as Database));
}

function num(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`publications: expected a safe integer, got ${String(value)}`);
  }
  return parsed;
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function bigintOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  return typeof value === "bigint" ? value : BigInt(String(value));
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function toMediaItem(row: Row): PublicationMediaItem {
  return {
    role: row.role as PublicationMediaRole,
    position: num(row.position),
    source: row.source as PublicationMediaSource,
    platformMediaRef: (row.platform_media_ref as string | null) ?? null,
    fileId: nullableNum(row.file_id),
    attachment: row.attachment === undefined ? 0 : num(row.attachment),
  };
}

function toExtraAttachments(value: unknown): PublicationExtraAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const item = raw as Record<string, unknown>;
    return {
      attachment: num(item.attachment),
      access: item.access as PublicationAttachmentAccess,
      tierRefs: stringArray(item.tierRefs),
      priceMills: bigintOrNull(item.priceMills),
      subscribersOnly: item.subscribersOnly === true,
    };
  });
}

function toRecord(row: Row, media: PublicationMediaItem[]): PublicationRecord {
  return {
    id: num(row.id),
    pageId: num(row.page_id),
    pageLabel: String(row.page_label),
    platform: String(row.platform),
    kind: row.kind as PublicationKind,
    status: row.status as PublicationStatus,
    version: num(row.version),
    text: String(row.text),
    publishAt: date(row.publish_at),
    expiresAt: nullableDate(row.expires_at),
    wallRefs: stringArray(row.wall_refs),
    tierRefs: stringArray(row.tier_refs),
    priceMills: bigintOrNull(row.price_mills),
    repost: row.repost === true,
    pinWallRefs: stringArray(row.pin_wall_refs),
    replyLock: stringArray(row.reply_lock) as PublicationReplyLock[],
    subscribersOnly: row.subscribers_only === true,
    extraAttachments: toExtraAttachments(row.extra_attachments),
    findings: Array.isArray(row.findings) ? row.findings : [],
    authorKind: row.author_kind as PublicationAuthorKind,
    authorUserId: nullableNum(row.author_user_id),
    authorAgentKeyId: nullableNum(row.author_agent_key_id),
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    approvedRevisionId: nullableNum(row.approved_revision_id),
    platformPostRef: (row.platform_post_ref as string | null) ?? null,
    statusReason: (row.status_reason as string | null) ?? null,
    previousPublicationId: nullableNum(row.previous_publication_id),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    statusChangedAt: date(row.status_changed_at),
    media,
    withdrawal: toWithdrawal(row.withdrawal),
    deletion: toWithdrawal(row.deletion),
  };
}

function toWithdrawal(value: unknown): PublicationWithdrawalFacts | null {
  const raw = value as Row | null | undefined;
  if (!raw || typeof raw !== "object") return null;
  return { state: String(raw.state ?? "unknown"), errorCode: (raw.errorCode as string | null) ?? null, at: date(raw.at) };
}

/**
 * A Fansly withdrawal's state in the words of an OnlyFans owner action (plan PR
 * 9), so the screen reads both alike: its cancel command queued or on the wire
 * → dispatching; answered → confirmed (the read after decides "Снят");
 * rejected and unknown as they are; refused — it never left, press again →
 * prepared.
 */
const FANSLY_WITHDRAW_STATE_SQL = sql`case c.state
  when 'queued' then 'dispatching' when 'sending' then 'dispatching' when 'answered' then 'confirmed'
  when 'rejected' then 'rejected' when 'unknown' then 'unknown' when 'refused' then 'prepared' end`;

const PUBLICATION_COLUMNS = sql`
  p.id, p.page_id, pg.label as page_label, pg.platform::text as platform, p.kind, p.status, p.version,
  p.text, p.publish_at, p.expires_at, p.wall_refs, p.tier_refs, p.price_mills, p.repost,
  p.pin_wall_refs, p.reply_lock, p.subscribers_only, p.findings,
  p.author_kind, p.author_user_id, p.author_agent_key_id, p.idempotency_key, p.approved_revision_id,
  p.platform_post_ref, p.status_reason, p.previous_publication_id, p.created_at, p.updated_at,
  p.status_changed_at,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'attachment', a.attachment, 'access', a.access, 'tierRefs', a.tier_refs,
            'priceMills', a.price_mills::text, 'subscribersOnly', a.subscribers_only) order by a.attachment), '[]'::jsonb)
     from publication_attachments a where a.publication_id = p.id) as extra_attachments,
  (select jsonb_build_object(
            'state', coalesce(i.state, ${FANSLY_WITHDRAW_STATE_SQL}, 'unknown'),
            'errorCode', coalesce(i.error_code, c.state_reason),
            'at', coalesce(c.created_at, d.created_at))
     from publication_dispatches d
     left join ofapi_action_intents i on i.id = d.ofapi_action_intent_id
     left join lateral (
       select fc.state, fc.state_reason, fc.created_at from fansly_write_commands fc
        where fc.dispatch_id = d.id and fc.step = 'post_cancel' order by fc.id desc limit 1
     ) c on d.platform = 'fansly'
    where d.publication_id = p.id and d.kind = 'withdraw') as withdrawal,
  (select jsonb_build_object('state', ${FANSLY_WITHDRAW_STATE_SQL}, 'errorCode', c.state_reason, 'at', c.created_at)
     from publication_dispatches d
     join lateral (
       select fc.state, fc.state_reason, fc.created_at from fansly_write_commands fc
        where fc.dispatch_id = d.id and fc.step = 'post_delete' order by fc.id desc limit 1
     ) c on true
    where d.publication_id = p.id and d.kind = 'delete') as deletion
`;

async function attachMedia(db: Database, rows: Row[]): Promise<PublicationRecord[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => num(row.id));
  const media = await db.execute<Row>(sql`
    select publication_id, role, position, source, platform_media_ref, file_id, attachment
      from publication_media
     where publication_id = any(${sql.param(ids)}::bigint[])
     order by publication_id, role, position
  `);
  const byPublication = new Map<number, PublicationMediaItem[]>();
  for (const row of media.rows) {
    const id = num(row.publication_id);
    const list = byPublication.get(id) ?? [];
    list.push(toMediaItem(row));
    byPublication.set(id, list);
  }
  return rows.map((row) => toRecord(row, byPublication.get(num(row.id)) ?? []));
}

export async function getPublication(
  db: Database,
  id: number,
  options: { forUpdate?: boolean } = {},
): Promise<PublicationRecord | null> {
  const result = await db.execute<Row>(sql`
    select ${PUBLICATION_COLUMNS}
      from publications p
      join pages pg on pg.id = p.page_id
     where p.id = ${id}
     ${options.forUpdate ? sql`for update of p` : sql``}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return (await attachMedia(db, [row]))[0] ?? null;
}

export interface ListPublicationsFilter {
  pageIds?: readonly number[] | null;
  statuses?: readonly PublicationStatus[] | null;
  from?: Date | null;
  to?: Date | null;
  limit: number;
}

/** Publications by publish time, earliest first, within the filter. */
export async function listPublications(db: Database, filter: ListPublicationsFilter): Promise<PublicationRecord[]> {
  const result = await db.execute<Row>(sql`
    select ${PUBLICATION_COLUMNS}
      from publications p
      join pages pg on pg.id = p.page_id
     where true
       ${filter.pageIds ? sql`and p.page_id = any(${sql.param([...filter.pageIds])}::bigint[])` : sql``}
       ${filter.statuses ? sql`and p.status = any(${sql.param([...filter.statuses])}::text[])` : sql``}
       ${filter.from ? sql`and p.publish_at >= ${filter.from}` : sql``}
       ${filter.to ? sql`and p.publish_at < ${filter.to}` : sql``}
     order by p.publish_at, p.id
     limit ${filter.limit}
  `);
  return attachMedia(db, result.rows);
}

async function writeMedia(
  tx: Database,
  publicationId: number,
  media: readonly PublicationMediaItem[],
  extraAttachments: readonly PublicationExtraAttachment[],
) {
  await tx.execute(sql`delete from publication_media where publication_id = ${publicationId}`);
  await tx.execute(sql`delete from publication_attachments where publication_id = ${publicationId}`);
  for (const item of media) {
    await tx.execute(sql`
      insert into publication_media (publication_id, role, position, source, platform_media_ref, file_id, attachment)
      values (${publicationId}, ${item.role}, ${item.position}, ${item.source}, ${item.platformMediaRef}, ${item.fileId}, ${item.attachment})
    `);
  }
  for (const extra of extraAttachments) {
    await tx.execute(sql`
      insert into publication_attachments (publication_id, attachment, access, tier_refs, price_mills, subscribers_only)
      values (${publicationId}, ${extra.attachment}, ${extra.access}, ${sql.param([...extra.tierRefs])}::text[],
              ${extra.priceMills}, ${extra.subscribersOnly})
    `);
  }
}

async function appendStatusEvent(tx: Database, input: {
  publicationId: number;
  from: PublicationStatus | null;
  to: PublicationStatus;
  actor: PublicationActor;
  reason?: string | null;
  revisionId?: number | null;
}) {
  await tx.execute(sql`
    insert into publication_status_events (
      publication_id, from_status, to_status, actor_kind, actor_user_id, actor_agent_key_id, reason, revision_id
    ) values (
      ${input.publicationId}, ${input.from}, ${input.to}, ${input.actor.kind},
      ${input.actor.kind === "human" ? input.actor.userId ?? null : null},
      ${input.actor.kind === "agent" ? input.actor.agentKeyId ?? null : null},
      ${input.reason ?? null}, ${input.revisionId ?? null}
    )
  `);
}

export interface InsertPublicationInput extends PublicationContent {
  pageId: number;
  author: { kind: "human"; userId: number } | { kind: "agent"; agentKeyId: number };
  idempotencyKey: string | null;
  findings: unknown[];
  previousPublicationId?: number | null;
}

/**
 * A new draft with its media and its first journal row. An agent's create with
 * an idempotency key it already used returns the existing row instead
 * (`created: false`); the caller compares the bodies.
 */
export async function insertPublication(
  db: Database,
  input: InsertPublicationInput,
): Promise<{ created: boolean; id: number }> {
  return inTransaction(db, async (tx) => {
    const authorUserId = input.author.kind === "human" ? input.author.userId : null;
    const authorAgentKeyId = input.author.kind === "agent" ? input.author.agentKeyId : null;
    const inserted = await tx.execute<Row>(sql`
      insert into publications (
        page_id, kind, status, text, publish_at, expires_at, wall_refs, tier_refs, price_mills, repost,
        pin_wall_refs, reply_lock, subscribers_only,
        findings, author_kind, author_user_id, author_agent_key_id, idempotency_key, previous_publication_id
      ) values (
        ${input.pageId}, ${input.kind}, 'draft', ${input.text}, ${input.publishAt}, ${input.expiresAt},
        ${sql.param([...input.wallRefs])}::text[], ${sql.param([...input.tierRefs])}::text[],
        ${input.priceMills}, ${input.repost},
        ${sql.param([...input.pinWallRefs])}::text[], ${sql.param([...input.replyLock])}::text[], ${input.subscribersOnly},
        ${JSON.stringify(input.findings)}::jsonb,
        ${input.author.kind}, ${authorUserId}, ${authorAgentKeyId}, ${input.idempotencyKey},
        ${input.previousPublicationId ?? null}
      )
      ${input.idempotencyKey === null ? sql`` : sql`
        on conflict (author_agent_key_id, idempotency_key) where idempotency_key is not null do nothing`}
      returning id
    `);
    const insertedId = inserted.rows[0]?.id;
    if (insertedId === undefined) {
      const existing = await tx.execute<Row>(sql`
        select id from publications
         where author_agent_key_id = ${authorAgentKeyId} and idempotency_key = ${input.idempotencyKey}
      `);
      return { created: false, id: num(existing.rows[0]?.id) };
    }
    const id = num(insertedId);
    await writeMedia(tx, id, input.media, input.extraAttachments);
    await appendStatusEvent(tx, {
      publicationId: id,
      from: null,
      to: "draft",
      actor: input.author.kind === "human"
        ? { kind: "human", userId: input.author.userId }
        : { kind: "agent", agentKeyId: input.author.agentKeyId },
    });
    return { created: true, id };
  });
}

/**
 * Replace a publication's content (compare-and-set on `version`). An approved
 * one returns to draft in the same statement and its approval is dropped
 * (spec §3.3). Returns null when the version moved or the status is no longer
 * editable; the caller re-reads to say which.
 */
export async function updatePublicationContent(
  db: Database,
  input: { id: number; expectedVersion: number; content: PublicationContent; findings: unknown[]; actor: PublicationActor },
): Promise<{ id: number; fromStatus: PublicationStatus; version: number } | null> {
  return inTransaction(db, async (tx) => {
    const { content } = input;
    const updated = await tx.execute<Row>(sql`
      with before as (
        select id, status from publications
         where id = ${input.id} and version = ${input.expectedVersion} and status in ('draft', 'approved')
         for update
      )
      update publications p set
        kind = ${content.kind}, text = ${content.text}, publish_at = ${content.publishAt},
        expires_at = ${content.expiresAt},
        wall_refs = ${sql.param([...content.wallRefs])}::text[],
        tier_refs = ${sql.param([...content.tierRefs])}::text[],
        price_mills = ${content.priceMills}, repost = ${content.repost},
        pin_wall_refs = ${sql.param([...content.pinWallRefs])}::text[],
        reply_lock = ${sql.param([...content.replyLock])}::text[],
        subscribers_only = ${content.subscribersOnly},
        findings = ${JSON.stringify(input.findings)}::jsonb,
        version = p.version + 1, status = 'draft', approved_revision_id = null,
        status_changed_at = case when before.status = 'draft' then p.status_changed_at else now() end,
        status_reason = case when before.status = 'draft' then p.status_reason else 'edited' end,
        updated_at = now()
        from before
       where p.id = before.id
      returning p.id, before.status as from_status, p.version
    `);
    const row = updated.rows[0];
    if (!row) return null;
    await writeMedia(tx, input.id, content.media, content.extraAttachments);
    const fromStatus = row.from_status as PublicationStatus;
    if (fromStatus !== "draft") {
      await appendStatusEvent(tx, { publicationId: input.id, from: fromStatus, to: "draft", actor: input.actor, reason: "edited" });
    }
    return { id: input.id, fromStatus, version: num(row.version) };
  });
}

export async function setPublicationFindings(db: Database, id: number, findings: unknown[]) {
  await db.execute(sql`
    update publications set findings = ${JSON.stringify(findings)}::jsonb where id = ${id}
  `);
}

export interface TransitionPublicationInput {
  id: number;
  from: PublicationStatus;
  to: PublicationStatus;
  actor: PublicationActor;
  reason?: string | null;
  /** Approval: the revision the publication now carries. */
  approvedRevisionId?: number;
  /** Back to draft drops the approval. */
  clearApproval?: boolean;
  /** Only while the publication still carries this approval: a sender
   *  claims what it checked, never a newer approval made in between. */
  onlyIfRevisionId?: number;
  platformPostRef?: string | null;
  findings?: unknown[];
}

/** Why an approved publication was held back this minute (no status change):
 *  the screen shows it, and a miss at its window's end names it. */
export async function notePublicationHeld(db: Database, id: number, reason: string): Promise<void> {
  await db.execute(sql`
    update publications set status_reason = ${`held: ${reason}`.slice(0, 300)}, updated_at = now()
     where id = ${id} and status = 'approved'
  `);
}

/**
 * One status change, only from the status the caller saw (no lost updates):
 * returns false when the row is no longer in `from`. The journal row is
 * written in the same transaction. Who may make which change is the caller's
 * rule (canTransitionPublication); this only records it.
 */
export async function transitionPublication(db: Database, input: TransitionPublicationInput): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    const updated = await tx.execute<Row>(sql`
      update publications set
        status = ${input.to},
        status_reason = ${input.reason ?? null},
        status_changed_at = now(),
        updated_at = now()
        ${input.approvedRevisionId !== undefined ? sql`, approved_revision_id = ${input.approvedRevisionId}` : sql``}
        ${input.clearApproval ? sql`, approved_revision_id = null, version = version + 1` : sql``}
        ${input.platformPostRef !== undefined ? sql`, platform_post_ref = ${input.platformPostRef}` : sql``}
        ${input.findings !== undefined ? sql`, findings = ${JSON.stringify(input.findings)}::jsonb` : sql``}
       where id = ${input.id} and status = ${input.from}
         ${input.onlyIfRevisionId !== undefined ? sql`and approved_revision_id = ${input.onlyIfRevisionId}` : sql``}
      returning id
    `);
    if (updated.rows.length === 0) return false;
    await appendStatusEvent(tx, {
      publicationId: input.id,
      from: input.from,
      to: input.to,
      actor: input.actor,
      reason: input.reason ?? null,
      revisionId: input.approvedRevisionId ?? null,
    });
    return true;
  });
}

export async function listPublicationStatusEvents(db: Database, publicationId: number): Promise<PublicationStatusEventRecord[]> {
  const result = await db.execute<Row>(sql`
    select id, from_status, to_status, actor_kind, actor_user_id, actor_agent_key_id, reason, revision_id, at
      from publication_status_events
     where publication_id = ${publicationId}
     order by id
  `);
  return result.rows.map((row) => ({
    id: num(row.id),
    fromStatus: (row.from_status as PublicationStatus | null) ?? null,
    toStatus: row.to_status as PublicationStatus,
    actorKind: row.actor_kind as PublicationActorKind,
    actorUserId: nullableNum(row.actor_user_id),
    actorAgentKeyId: nullableNum(row.actor_agent_key_id),
    reason: (row.reason as string | null) ?? null,
    revisionId: nullableNum(row.revision_id),
    at: date(row.at),
  }));
}

export async function insertPublicationRevision(db: Database, input: Omit<PublicationRevisionRecord, "id" | "approvedAt">): Promise<number> {
  const inserted = await db.execute<Row>(sql`
    insert into publication_revisions (
      publication_id, fingerprint, form, page_id, platform_account_ref, ofapi_account_ref,
      ofapi_binding_generation, model_id, approved_by_user_id
    ) values (
      ${input.publicationId}, ${input.fingerprint}, ${JSON.stringify(input.form)}::jsonb, ${input.pageId},
      ${input.platformAccountRef}, ${input.ofapiAccountRef}, ${input.ofapiBindingGeneration}, ${input.modelId},
      ${input.approvedByUserId}
    )
    returning id
  `);
  return num(inserted.rows[0]?.id);
}

export async function getPublicationRevision(db: Database, id: number): Promise<PublicationRevisionRecord | null> {
  const result = await db.execute<Row>(sql`
    select id, publication_id, fingerprint, form, page_id, platform_account_ref, ofapi_account_ref,
           ofapi_binding_generation, model_id, approved_by_user_id, approved_at
      from publication_revisions where id = ${id}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: num(row.id),
    publicationId: num(row.publication_id),
    fingerprint: String(row.fingerprint),
    form: row.form as Record<string, unknown>,
    pageId: num(row.page_id),
    platformAccountRef: (row.platform_account_ref as string | null) ?? null,
    ofapiAccountRef: (row.ofapi_account_ref as string | null) ?? null,
    ofapiBindingGeneration: num(row.ofapi_binding_generation),
    modelId: num(row.model_id),
    approvedByUserId: num(row.approved_by_user_id),
    approvedAt: date(row.approved_at),
  };
}

/** Serialize approvals per page, in one order so two batches never deadlock. */
export async function lockPublicationPages(tx: Database, pageIds: readonly number[]) {
  for (const pageId of [...new Set(pageIds)].sort((a, b) => a - b)) {
    await tx.execute(sql`select pg_advisory_xact_lock(${PUBLICATION_PAGE_LOCK_NAMESPACE}::integer, ${pageId}::integer)`);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function toSettings(pageId: number, row: Row | undefined): PagePublishingSettingsRecord {
  return {
    pageId,
    enabled: row?.enabled === true,
    autostopReason: (row?.autostop_reason as string | null | undefined) ?? null,
    autostoppedAt: nullableDate(row?.autostopped_at),
    paidPriceMinMills: bigintOrNull(row?.paid_price_min_mills),
    paidPriceMaxMills: bigintOrNull(row?.paid_price_max_mills),
    repostThresholdDays: row ? num(row.repost_threshold_days) : PUBLICATION_DEFAULT_REPOST_THRESHOLD_DAYS,
    dailyLimit: nullableNum(row?.daily_limit),
    updatedByUserId: nullableNum(row?.updated_by_user_id),
    updatedAt: nullableDate(row?.updated_at),
  };
}

/** A page without a row has the defaults: off, no price range, 30 days, no limit. */
export async function getPagePublishingSettings(db: Database, pageId: number): Promise<PagePublishingSettingsRecord> {
  const result = await db.execute<Row>(sql`select * from page_publishing_settings where page_id = ${pageId}`);
  return toSettings(pageId, result.rows[0]);
}

export async function listPagePublishingSettings(db: Database, pageIds: readonly number[]): Promise<PagePublishingSettingsRecord[]> {
  const result = await db.execute<Row>(sql`
    select * from page_publishing_settings where page_id = any(${sql.param([...pageIds])}::bigint[])
  `);
  const byPage = new Map(result.rows.map((row) => [num(row.page_id), row]));
  return pageIds.map((pageId) => toSettings(pageId, byPage.get(pageId)));
}

export async function upsertPagePublishingSettings(db: Database, input: {
  pageId: number;
  enabled: boolean;
  paidPriceMinMills: bigint | null;
  paidPriceMaxMills: bigint | null;
  repostThresholdDays: number;
  dailyLimit: number | null;
  updatedByUserId: number;
}): Promise<PagePublishingSettingsRecord> {
  // Turning publishing on is the owner's answer to an autostop (spec §8.3):
  // it clears the stop. Turning it off keeps the reason visible.
  const result = await db.execute<Row>(sql`
    insert into page_publishing_settings (
      page_id, enabled, paid_price_min_mills, paid_price_max_mills, repost_threshold_days, daily_limit,
      updated_by_user_id, updated_at
    ) values (
      ${input.pageId}, ${input.enabled}, ${input.paidPriceMinMills}, ${input.paidPriceMaxMills},
      ${input.repostThresholdDays}, ${input.dailyLimit}, ${input.updatedByUserId}, now()
    )
    on conflict (page_id) do update set
      enabled = excluded.enabled,
      autostop_reason = case when excluded.enabled then null else page_publishing_settings.autostop_reason end,
      autostopped_at = case when excluded.enabled then null else page_publishing_settings.autostopped_at end,
      paid_price_min_mills = excluded.paid_price_min_mills,
      paid_price_max_mills = excluded.paid_price_max_mills,
      repost_threshold_days = excluded.repost_threshold_days,
      daily_limit = excluded.daily_limit,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = now()
    returning *
  `);
  return toSettings(input.pageId, result.rows[0]);
}

// ---------------------------------------------------------------------------
// Facts for the draft checks (spec §8.1)
// ---------------------------------------------------------------------------

export async function getPublicationPageFacts(db: Database, pageId: number): Promise<PublicationPageFacts | null> {
  const result = await db.execute<Row>(sql`
    select id, label, platform::text as platform, status, model_id, username, external_page_id,
           ofapi_account_id, ofapi_binding_generation
      from pages where id = ${pageId}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: num(row.id),
    label: String(row.label),
    platform: String(row.platform),
    status: String(row.status),
    modelId: num(row.model_id),
    username: (row.username as string | null) ?? null,
    platformAccountRef: (row.external_page_id as string | null) ?? null,
    ofapiAccountRef: (row.ofapi_account_id as string | null) ?? null,
    ofapiBindingGeneration: num(row.ofapi_binding_generation),
  };
}

export interface PublicationFileFacts {
  id: number;
  modelId: number;
  contentSha256: string;
  /** Null for a row PR 1 recorded before files had bytes. */
  byteSize: number | null;
  /** Set once retention deleted the bytes (0299); a new upload of the same bytes clears it. */
  bytesDeletedAt: Date | null;
}

export async function getPublicationFiles(db: Database, fileIds: readonly number[]): Promise<PublicationFileFacts[]> {
  if (fileIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select id, model_id, content_sha256, byte_size, bytes_deleted_at from publication_files
     where id = any(${sql.param([...fileIds])}::bigint[])
  `);
  return result.rows.map((row) => ({
    id: num(row.id),
    modelId: num(row.model_id),
    contentSha256: String(row.content_sha256),
    byteSize: nullableNum(row.byte_size),
    bytesDeletedAt: nullableDate(row.bytes_deleted_at),
  }));
}

/**
 * The vault refs among `refs` that are this page's own media and can be sent.
 * Fansly: media Hub collected for the page. OnlyFans: the vault catalog of the
 * page's current OnlyFansAPI account, ready and viewable — the same rows the
 * owner action checks before it sends (ofapi-action-media.ts), so an approval
 * never passes a file the send would refuse.
 */
export async function findPageMediaRefs(db: Database, pageId: number, refs: readonly string[]): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const result = await db.execute<Row>(sql`
    select m.media_ref from pages pg
      join creator_raw_media m on m.page_id = pg.id
     where pg.id = ${pageId} and pg.platform::text <> 'onlyfans'
       and m.media_ref = any(${sql.param([...refs])}::text[])
    union
    select c.media_ref from pages pg
      join ofapi_media_catalog c on c.page_id = pg.id and c.account_id = pg.ofapi_account_id
     where pg.id = ${pageId} and pg.platform::text = 'onlyfans' and c.material_kind = 'vault'
       and c.is_ready is true and c.has_error is not true and c.can_view is not false
       and c.media_ref = any(${sql.param([...refs])}::text[])
  `);
  return new Set(result.rows.map((row) => String(row.media_ref)));
}

export interface PublicationWallFacts {
  wallRef: string;
  defaultWall: boolean;
}

/** The page's Fansly walls Hub still sees (a wall gone from the page has missing_since). */
export async function listPublicationPageWalls(db: Database, pageId: number): Promise<PublicationWallFacts[]> {
  const result = await db.execute<Row>(sql`
    select wall_ref, coalesce(default_wall, false) as default_wall
      from page_walls where page_id = ${pageId} and missing_since is null
     order by pos nulls last, wall_ref
  `);
  return result.rows.map((row) => ({ wallRef: String(row.wall_ref), defaultWall: row.default_wall === true }));
}

export async function listPublicationPageTiers(db: Database, pageId: number): Promise<string[]> {
  const result = await db.execute<Row>(sql`
    select tier_ref from page_subscription_tiers where page_id = ${pageId} and missing_since is null
  `);
  return result.rows.map((row) => String(row.tier_ref));
}

/** One file's history on one page: its newest post and its closest live publication. */
export interface PublicationMediaHistory {
  /** `vault:<ref>` or `file:<id>`. */
  key: string;
  lastPostedAt: Date | null;
  lastPostRef: string | null;
  nearestPublicationId: number | null;
  nearestPublicationAt: Date | null;
  /** The entry of the platform's own schedule (the page's latest read) with
   *  the file, put there by hand or by another tool, closest to `publishAt`. */
  scheduledAt: Date | null;
  scheduledPostRef: string | null;
}

/**
 * The page's latest schedule read: its entries with the file, closest to
 * `publishAt` first, but Hub's own (a publication of the page names the
 * entry's post) — those are publications already. On Fansly an entry carries
 * the file by its media id when the read named it, or by an attachment that
 * is one of the file's offers or a bundle of them.
 */
function scheduledWithFile(input: { pageId: number; platform: string; publishAt: Date; ref: string }) {
  const byAttachment = input.platform === "fansly"
    ? sql`or exists (
        select 1 from jsonb_array_elements_text(coalesce(e->'attachmentRefs', '[]'::jsonb)) a(content_id)
         where a.content_id in (
           select media_offer_ref from creator_media where page_id = ${input.pageId} and media_ref = ${input.ref}
           union
           select b.bundle_ref from creator_media_bundles b
            where b.page_id = ${input.pageId}
              and b.member_refs && array(select media_offer_ref from creator_media where page_id = ${input.pageId} and media_ref = ${input.ref})
         ))`
    : sql``;
  return sql`
    select (e->>'publishAt')::timestamptz as scheduled_at, coalesce(e->>'postRef', e->>'queueId') as post_ref
      from publication_queue_snapshots s
      cross join lateral jsonb_array_elements(s.entries) e
     where s.page_id = ${input.pageId} and e->>'publishAt' is not null
       and (coalesce(e->'mediaRefs', '[]'::jsonb) @> jsonb_build_array(${input.ref}::text) ${byAttachment})
       and not exists (
         select 1 from publications p
          where p.page_id = ${input.pageId} and p.platform_post_ref is not null
            and p.platform_post_ref in (e->>'postRef', e->>'queueId'))
     order by abs(extract(epoch from (e->>'publishAt')::timestamptz - ${input.publishAt}::timestamptz))
     limit 1
  `;
}

/**
 * When each media of a draft last went out on its page, or is booked to (spec
 * §8.1 "Повтор"): among the page's posts Hub collected — on Fansly a post
 * points at an offer (accountMedia) or a bundle of offers that wrap the file,
 * on OnlyFans straight at the vault media id — among the page's live
 * publications (approved, on the way, on the platform, unknown), the one
 * closest in time to `publishAt`, and in the platform's own schedule (the
 * page's latest read), the entry put there by hand or by another tool.
 */
export async function readPublicationMediaHistory(db: Database, input: {
  pageId: number;
  platform: string;
  excludePublicationId: number | null;
  publishAt: Date;
  vaultRefs: readonly string[];
  fileIds: readonly number[];
}): Promise<PublicationMediaHistory[]> {
  const out: PublicationMediaHistory[] = [];
  const active = sql.param([...PUBLICATION_ACTIVE_STATUSES]);
  const exclude = input.excludePublicationId ?? 0;
  const posted = (ref: string) => input.platform === "fansly"
    ? db.execute<Row>(sql`
        with offers as (
          select media_offer_ref as content_id from creator_media
           where page_id = ${input.pageId} and media_ref = ${ref}
        ), ids as (
          select content_id from offers
          union
          select b.bundle_ref from creator_media_bundles b
           where b.page_id = ${input.pageId}
             and b.member_refs && array(select content_id from offers)
        )
        select cp.published_at, cp.platform_post_id
          from ids
          cross join lateral (
            select published_at, platform_post_id from creator_posts
             where account_id = ${input.pageId}
               and attachment_refs @> jsonb_build_array(jsonb_build_object('contentId', ids.content_id))
             order by published_at desc limit 1
          ) cp
         order by cp.published_at desc limit 1
      `)
    : db.execute<Row>(sql`
        select published_at, platform_post_id from creator_posts
         where account_id = ${input.pageId}
           and attachment_refs @> jsonb_build_array(jsonb_build_object('contentId', ${ref}::text))
         order by published_at desc limit 1
      `);
  const scheduled = (ref: string) => db.execute<Row>(scheduledWithFile({ pageId: input.pageId, platform: input.platform, publishAt: input.publishAt, ref }));
  for (const ref of new Set(input.vaultRefs)) {
    const last = await posted(ref);
    const nearest = await db.execute<Row>(sql`
      select p.id, p.publish_at from publications p
        join publication_media pm on pm.publication_id = p.id
       where p.page_id = ${input.pageId} and p.id <> ${exclude} and p.status = any(${active}::text[])
         and pm.role = 'media' and pm.platform_media_ref = ${ref}
       order by abs(extract(epoch from p.publish_at - ${input.publishAt}::timestamptz)), p.id
       limit 1
    `);
    const booked = await scheduled(ref);
    out.push({
      key: `vault:${ref}`,
      lastPostedAt: nullableDate(last.rows[0]?.published_at),
      lastPostRef: (last.rows[0]?.platform_post_id as string | undefined) ?? null,
      nearestPublicationId: nullableNum(nearest.rows[0]?.id),
      nearestPublicationAt: nullableDate(nearest.rows[0]?.publish_at),
      scheduledAt: nullableDate(booked.rows[0]?.scheduled_at),
      scheduledPostRef: (booked.rows[0]?.post_ref as string | undefined) ?? null,
    });
  }
  for (const fileId of new Set(input.fileIds)) {
    // A new file's bytes Hub already uploaded to this Fansly page are the
    // media they became (`listFanslyUploadedMedia`): its posts and the
    // schedule know it by that media id.
    const known = input.platform === "fansly" ? await db.execute<Row>(sql`
      select s.result->>'mediaId' as media_ref
        from publication_files f
        join fansly_write_commands c
          on c.page_id = ${input.pageId} and c.step = 'upload_create' and c.request->'facts'->>'fileSha256' = f.content_sha256
        join fansly_write_commands s
          on s.dispatch_id = c.dispatch_id and s.step = 'upload_status' and s.state = 'answered'
         and s.result->>'done' = 'true' and coalesce(s.result->>'mediaId', '') <> ''
         and left(s.item, length(c.item) + 6) = c.item || '/poll:'
       where f.id = ${fileId}
       order by s.id desc
       limit 1
    `) : null;
    const ref = (known?.rows[0]?.media_ref as string | undefined) ?? null;
    const nearest = await db.execute<Row>(sql`
      select p.id, p.publish_at from publications p
        join publication_media pm on pm.publication_id = p.id
       where p.page_id = ${input.pageId} and p.id <> ${exclude} and p.status = any(${active}::text[])
         and pm.role = 'media' and (pm.file_id = ${fileId} or (${ref}::text is not null and pm.platform_media_ref = ${ref}::text))
       order by abs(extract(epoch from p.publish_at - ${input.publishAt}::timestamptz)), p.id
       limit 1
    `);
    const last = ref === null ? null : await posted(ref);
    const booked = ref === null ? null : await scheduled(ref);
    out.push({
      key: `file:${fileId}`,
      lastPostedAt: nullableDate(last?.rows[0]?.published_at),
      lastPostRef: (last?.rows[0]?.platform_post_id as string | undefined) ?? null,
      nearestPublicationId: nullableNum(nearest.rows[0]?.id),
      nearestPublicationAt: nullableDate(nearest.rows[0]?.publish_at),
      // A file Hub never uploaded to the page has no media id the schedule could name.
      scheduledAt: nullableDate(booked?.rows[0]?.scheduled_at),
      scheduledPostRef: (booked?.rows[0]?.post_ref as string | undefined) ?? null,
    });
  }
  return out;
}

/**
 * A post of the page's own (spec §8.1 "Объём"): one that names no other
 * account. Promotions of other creators mention them by @handle; on lora-of
 * they are 10 963 of 10 981 posts in 30 days (2026-10-23) and would make any
 * "usual day" meaningless.
 */
const OWN_POST = sql`not exists (
  select 1 from regexp_matches(cp.text_plain, '@([A-Za-z0-9_.]+)', 'g') as mention(groups)
   where lower(mention.groups[1]) <> lower(coalesce(pg.username, ''))
)`;

export interface PublicationDayVolume {
  /** Posts (not stories) on the publish day: live publications plus the page's own posts not claimed by one. */
  dayCount: number;
  /** The page's own posts per day over the last 30 days. */
  usualPerDay: number;
}

/** The volume of the UTC day `publishAt` falls on, without `excludePublicationId`. */
export async function readPublicationDayVolume(db: Database, input: {
  pageId: number;
  excludePublicationId: number | null;
  publishAt: Date;
  now: Date;
}): Promise<PublicationDayVolume> {
  const dayStart = new Date(Date.UTC(input.publishAt.getUTCFullYear(), input.publishAt.getUTCMonth(), input.publishAt.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const baselineFrom = new Date(input.now.getTime() - PUBLICATION_VOLUME_BASELINE_DAYS * 24 * 60 * 60 * 1000);
  const result = await db.execute<Row>(sql`
    select
      (select count(*) from publications p
        where p.page_id = ${input.pageId} and p.id <> ${input.excludePublicationId ?? 0} and p.kind <> 'story'
          and p.status = any(${sql.param([...PUBLICATION_ACTIVE_STATUSES])}::text[])
          and p.publish_at >= ${dayStart} and p.publish_at < ${dayEnd})
      + (select count(*) from creator_posts cp join pages pg on pg.id = cp.account_id
          where cp.account_id = ${input.pageId} and cp.published_at >= ${dayStart} and cp.published_at < ${dayEnd}
            and ${OWN_POST}
            and not exists (select 1 from publications claimed
                             where claimed.page_id = cp.account_id and claimed.platform_post_ref = cp.platform_post_id))
        as day_count,
      (select count(*) from creator_posts cp join pages pg on pg.id = cp.account_id
        where cp.account_id = ${input.pageId} and cp.published_at >= ${baselineFrom} and cp.published_at < ${input.now}
          and ${OWN_POST}) as baseline_count
  `);
  const row = result.rows[0] ?? {};
  return {
    dayCount: num(row.day_count ?? 0),
    usualPerDay: num(row.baseline_count ?? 0) / PUBLICATION_VOLUME_BASELINE_DAYS,
  };
}

/** The active pages, for the settings screen and label lookups. */
export async function listPublicationPages(db: Database): Promise<Array<{ id: number; label: string; platform: string }>> {
  const result = await db.execute<Row>(sql`
    select id, label, platform::text as platform from pages
     where status = 'active' and deleted_at is null
     order by label
  `);
  return result.rows.map((row) => ({ id: num(row.id), label: String(row.label), platform: String(row.platform) }));
}

// ---------------------------------------------------------------------------
// Dispatches (0298): what Hub sent to a platform for a publication, once.
// ---------------------------------------------------------------------------

/** `delete` (0305): the owner's deletion of a published Fansly post. */
export type PublicationDispatchKind = "create" | "withdraw" | "delete";
export type PublicationDispatchMode = "scheduled" | "now" | "story" | "withdraw" | "delete";

export interface PublicationDispatchRecord {
  id: number;
  publicationId: number;
  revisionId: number;
  kind: PublicationDispatchKind;
  platform: string;
  ofapiActionIntentId: string | null;
  mode: PublicationDispatchMode;
  createdAt: Date;
}

function toDispatch(row: Row): PublicationDispatchRecord {
  return {
    id: num(row.id),
    publicationId: num(row.publication_id),
    revisionId: num(row.revision_id),
    kind: row.kind as PublicationDispatchKind,
    platform: String(row.platform),
    ofapiActionIntentId: (row.ofapi_action_intent_id as string | null) ?? null,
    mode: row.mode as PublicationDispatchMode,
    createdAt: date(row.created_at),
  };
}

/** The one dispatch of this kind; null when another worker recorded it first. */
export async function insertPublicationDispatch(db: Database, input: Omit<PublicationDispatchRecord, "id" | "createdAt">): Promise<PublicationDispatchRecord | null> {
  const inserted = await db.execute<Row>(sql`
    insert into publication_dispatches (publication_id, page_id, revision_id, kind, platform, ofapi_action_intent_id, mode)
    select ${input.publicationId}, p.page_id, ${input.revisionId}, ${input.kind}, ${input.platform}, ${input.ofapiActionIntentId}::uuid, ${input.mode}
      from publications p where p.id = ${input.publicationId}
    on conflict (publication_id, kind) do nothing
    returning *
  `);
  const row = inserted.rows[0];
  return row ? toDispatch(row) : null;
}

export async function getPublicationDispatch(db: Database, publicationId: number, kind: PublicationDispatchKind): Promise<PublicationDispatchRecord | null> {
  const result = await db.execute<Row>(sql`
    select * from publication_dispatches where publication_id = ${publicationId} and kind = ${kind}
  `);
  const row = result.rows[0];
  return row ? toDispatch(row) : null;
}

/** OnlyFans publications whose post or story command has not settled yet. */
export async function listSubmittingOnlyfansPublications(db: Database): Promise<Array<{ publicationId: number; pageId: number; pageEnabled: boolean; dispatch: PublicationDispatchRecord }>> {
  const result = await db.execute<Row>(sql`
    select d.*, p.page_id, coalesce(s.enabled and s.autostopped_at is null, false) as page_enabled
      from publications p
      join publication_dispatches d on d.publication_id = p.id and d.kind = 'create'
      left join page_publishing_settings s on s.page_id = p.page_id
     where p.status = 'submitting' and d.platform = 'onlyfans'
     order by p.publish_at, p.id
  `);
  return result.rows.map((row) => ({
    publicationId: num(row.publication_id), pageId: num(row.page_id), pageEnabled: row.page_enabled === true, dispatch: toDispatch(row),
  }));
}

/**
 * Approved OnlyFans publications whose turn has come, earliest first: posts up
 * to `postsUntil` ahead (the platform's schedule takes them), stories once
 * their time is here. Only pages whose publishing is on and not stopped.
 */
export async function listDueOnlyfansPublications(db: Database, input: { now: Date; postsUntil: Date }): Promise<Array<{ id: number; pageId: number; kind: PublicationKind; publishAt: Date }>> {
  const result = await db.execute<Row>(sql`
    select p.id, p.page_id, p.kind, p.publish_at
      from publications p
      join pages pg on pg.id = p.page_id
      join page_publishing_settings s on s.page_id = p.page_id
     where p.status = 'approved' and pg.platform::text = 'onlyfans' and pg.status = 'active'
       and s.enabled and s.autostopped_at is null
       and ((p.kind <> 'story' and p.publish_at <= ${input.postsUntil})
         or (p.kind = 'story' and p.publish_at <= ${input.now}))
     order by p.publish_at, p.id
  `);
  return result.rows.map((row) => ({
    id: num(row.id), pageId: num(row.page_id), kind: row.kind as PublicationKind, publishAt: date(row.publish_at),
  }));
}

/**
 * Approved OnlyFans publications with a new file whose upload may start (plan
 * PR 4c): posts up to `postsUntil` ahead, stories up to `storiesUntil`; only
 * on pages whose publishing is on and not stopped. Earliest first.
 */
export async function listOnlyfansPublicationsForUpload(db: Database, input: { postsUntil: Date; storiesUntil: Date }): Promise<Array<{ id: number; pageId: number }>> {
  const result = await db.execute<Row>(sql`
    select p.id, p.page_id
      from publications p
      join pages pg on pg.id = p.page_id
      join page_publishing_settings s on s.page_id = p.page_id
     where p.status = 'approved' and pg.platform::text = 'onlyfans' and pg.status = 'active'
       and s.enabled and s.autostopped_at is null
       and exists (select 1 from publication_media m where m.publication_id = p.id and m.source = 'file')
       and ((p.kind <> 'story' and p.publish_at <= ${input.postsUntil})
         or (p.kind = 'story' and p.publish_at <= ${input.storiesUntil}))
     order by p.publish_at, p.id
  `);
  return result.rows.map((row) => ({ id: num(row.id), pageId: num(row.page_id) }));
}

/** Fansly publications whose post or story chain has not settled yet (plan PR 9), with their create dispatch. */
export async function listSubmittingFanslyPublications(db: Database): Promise<Array<{ publicationId: number; pageId: number; dispatch: PublicationDispatchRecord }>> {
  const result = await db.execute<Row>(sql`
    select d.*, p.page_id
      from publications p
      join publication_dispatches d on d.publication_id = p.id and d.kind = 'create'
     where p.status = 'submitting' and d.platform = 'fansly'
     order by p.publish_at, p.id
  `);
  return result.rows.map((row) => ({ publicationId: num(row.publication_id), pageId: num(row.page_id), dispatch: toDispatch(row) }));
}

/**
 * Approved Fansly publications whose turn has come, earliest first: posts up
 * to `postsUntil` ahead (Fansly's own schedule takes them), stories once their
 * time is here. Only active pages on their browser (spec §2.2) whose
 * publishing is on and not stopped.
 */
export async function listDueFanslyPublications(db: Database, input: { now: Date; postsUntil: Date; storiesUntil?: Date }): Promise<Array<{ id: number; pageId: number; kind: PublicationKind; publishAt: Date }>> {
  const result = await db.execute<Row>(sql`
    select p.id, p.page_id, p.kind, p.publish_at
      from publications p
      join pages pg on pg.id = p.page_id
      join page_publishing_settings s on s.page_id = p.page_id
      join sync_pages sp on sp.page_id = p.page_id
     where p.status = 'approved' and pg.platform::text = 'fansly' and pg.status = 'active'
       and s.enabled and s.autostopped_at is null and sp.transport = 'browser'
       and ((p.kind <> 'story' and p.publish_at <= ${input.postsUntil})
         or (p.kind = 'story' and p.publish_at <= ${input.storiesUntil ?? input.now}))
     order by p.publish_at, p.id
  `);
  return result.rows.map((row) => ({
    id: num(row.id), pageId: num(row.page_id), kind: row.kind as PublicationKind, publishAt: date(row.publish_at),
  }));
}

/** How many publication commands a page sent since `since` (the batch gate). */
export async function countPagePublicationDispatchesSince(db: Database, pageId: number, since: Date): Promise<number> {
  const result = await db.execute<Row>(sql`
    select count(*) as n from publication_dispatches where page_id = ${pageId} and created_at >= ${since}
  `);
  return num(result.rows[0]?.n ?? 0);
}

/** How many publication commands went to a platform since `since` (OnlyFans: 1 credit each). */
export async function countPlatformPublicationDispatchesSince(db: Database, platform: string, since: Date): Promise<number> {
  const result = await db.execute<Row>(sql`
    select count(*) as n from publication_dispatches where platform = ${platform} and created_at >= ${since}
  `);
  return num(result.rows[0]?.n ?? 0);
}

/** Autostop (spec §8.3): the page's publishing goes off with the reason; the owner turns it back on. */
export async function autostopPagePublishing(db: Database, pageId: number, reason: string): Promise<boolean> {
  const result = await db.execute<Row>(sql`
    update page_publishing_settings
       set enabled = false, autostop_reason = ${reason}, autostopped_at = now(), updated_at = now()
     where page_id = ${pageId} and autostopped_at is null
    returning page_id
  `);
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Checks (0301): did it go out, and the search for an unknown one (plan PR 5a).
// ---------------------------------------------------------------------------

export type PublicationCheckKind = "verify" | "search";
export type PublicationCheckOutcome =
  | "published" | "processing" | "scheduled" | "not_published" | "unknown" | "not_found" | "read_failed" | "withdrawn";

export interface PublicationCheckRecord {
  id: number;
  publicationId: number;
  kind: PublicationCheckKind;
  outcome: PublicationCheckOutcome;
  reason: string | null;
  platformPostRef: string | null;
  evidence: Record<string, unknown>;
  createdAt: Date;
}

function toCheck(row: Row): PublicationCheckRecord {
  return {
    id: num(row.id),
    publicationId: num(row.publication_id),
    kind: row.kind as PublicationCheckKind,
    outcome: row.outcome as PublicationCheckOutcome,
    reason: (row.reason as string | null) ?? null,
    platformPostRef: (row.platform_post_ref as string | null) ?? null,
    evidence: (row.evidence as Record<string, unknown> | null) ?? {},
    createdAt: date(row.created_at),
  };
}

export async function insertPublicationCheck(db: Database, input: {
  publicationId: number;
  kind: PublicationCheckKind;
  outcome: PublicationCheckOutcome;
  reason: string | null;
  platformPostRef: string | null;
  evidence: Record<string, unknown>;
  at?: Date;
}): Promise<void> {
  await db.execute(sql`
    insert into publication_checks (publication_id, page_id, kind, outcome, reason, platform_post_ref, evidence, created_at)
    select ${input.publicationId}, p.page_id, ${input.kind}, ${input.outcome}, ${input.reason}, ${input.platformPostRef},
           ${JSON.stringify(input.evidence)}::jsonb, ${input.at ?? new Date()}
      from publications p where p.id = ${input.publicationId}
  `);
}

export async function listPublicationChecks(db: Database, publicationId: number): Promise<PublicationCheckRecord[]> {
  const result = await db.execute<Row>(sql`
    select * from publication_checks where publication_id = ${publicationId} order by id
  `);
  return result.rows.map(toCheck);
}

/** An OnlyFans publication whose fate on the platform Hub still reads: its facts and its checks since its last status change. */
export interface OnlyfansCheckCandidate {
  id: number;
  pageId: number;
  kind: PublicationKind;
  status: PublicationStatus;
  publishAt: Date;
  statusChangedAt: Date;
  platformPostRef: string | null;
  approvedRevisionId: number;
  /** When the post or story command was recorded (its send). */
  dispatchedAt: Date | null;
  /** Its withdrawal's owner-action state, when Hub sent one (plan PR 5b). */
  withdrawState: string | null;
  checks: Array<{ kind: PublicationCheckKind; outcome: PublicationCheckOutcome; at: Date }>;
}

/** Scheduled, processing and unknown OnlyFans publications, earliest first. */
export async function listOnlyfansCheckCandidates(db: Database): Promise<OnlyfansCheckCandidate[]> {
  const result = await db.execute<Row>(sql`
    select p.id, p.page_id, p.kind, p.status, p.publish_at, p.status_changed_at, p.platform_post_ref,
           p.approved_revision_id, d.created_at as dispatched_at,
           (select i.state from publication_dispatches w join ofapi_action_intents i on i.id = w.ofapi_action_intent_id
             where w.publication_id = p.id and w.kind = 'withdraw') as withdraw_state,
           coalesce((
             select jsonb_agg(jsonb_build_object('kind', c.kind, 'outcome', c.outcome, 'at', c.created_at) order by c.id)
               from publication_checks c
              where c.publication_id = p.id and c.created_at >= p.status_changed_at
           ), '[]'::jsonb) as checks
      from publications p
      join pages pg on pg.id = p.page_id
      left join publication_dispatches d on d.publication_id = p.id and d.kind = 'create'
     where pg.platform::text = 'onlyfans' and p.status in ('scheduled', 'processing', 'unknown')
       and p.approved_revision_id is not null
     order by p.publish_at, p.id
  `);
  return result.rows.map((row) => ({
    id: num(row.id),
    pageId: num(row.page_id),
    kind: row.kind as PublicationKind,
    status: row.status as PublicationStatus,
    publishAt: date(row.publish_at),
    statusChangedAt: date(row.status_changed_at),
    platformPostRef: (row.platform_post_ref as string | null) ?? null,
    approvedRevisionId: num(row.approved_revision_id),
    dispatchedAt: nullableDate(row.dispatched_at),
    withdrawState: (row.withdraw_state as string | null) ?? null,
    checks: (Array.isArray(row.checks) ? row.checks as Row[] : []).map((check) => ({
      kind: check.kind as PublicationCheckKind,
      outcome: check.outcome as PublicationCheckOutcome,
      at: date(check.at),
    })),
  }));
}

/** A Fansly publication whose fate Hub still reads (plan PR 9): as OnlyFans', plus what its check reads came from. */
export interface FanslyCheckCandidate extends OnlyfansCheckCandidate {
  /** The `publish.verify` works its checks since the last status change concluded from. */
  consumedWorkIds: number[];
}

/**
 * Scheduled and unknown Fansly publications, earliest first. Not one whose
 * post the owner had Hub delete (0305): an unknown deletion is a person's to
 * decide — the posts Hub collected before it still show the post, and a
 * search would call it out again.
 */
export async function listFanslyCheckCandidates(db: Database): Promise<FanslyCheckCandidate[]> {
  const result = await db.execute<Row>(sql`
    select p.id, p.page_id, p.kind, p.status, p.publish_at, p.status_changed_at, p.platform_post_ref,
           p.approved_revision_id, d.created_at as dispatched_at,
           (select fc.state from publication_dispatches w join fansly_write_commands fc on fc.dispatch_id = w.id and fc.step = 'post_cancel'
             where w.publication_id = p.id and w.kind = 'withdraw' order by fc.id desc limit 1) as withdraw_state,
           coalesce((
             select jsonb_agg(jsonb_build_object('kind', c.kind, 'outcome', c.outcome, 'at', c.created_at, 'workId', c.evidence->'workId') order by c.id)
               from publication_checks c
              where c.publication_id = p.id and c.created_at >= p.status_changed_at
           ), '[]'::jsonb) as checks
      from publications p
      join pages pg on pg.id = p.page_id
      left join publication_dispatches d on d.publication_id = p.id and d.kind = 'create'
     where pg.platform::text = 'fansly' and p.status in ('scheduled', 'unknown')
       and p.approved_revision_id is not null
       and not exists (select 1 from publication_dispatches x where x.publication_id = p.id and x.kind = 'delete')
     order by p.publish_at, p.id
  `);
  return result.rows.map((row) => {
    const checks = Array.isArray(row.checks) ? row.checks as Row[] : [];
    return {
      id: num(row.id),
      pageId: num(row.page_id),
      kind: row.kind as PublicationKind,
      status: row.status as PublicationStatus,
      publishAt: date(row.publish_at),
      statusChangedAt: date(row.status_changed_at),
      platformPostRef: (row.platform_post_ref as string | null) ?? null,
      approvedRevisionId: num(row.approved_revision_id),
      dispatchedAt: nullableDate(row.dispatched_at),
      withdrawState: (row.withdraw_state as string | null) ?? null,
      checks: checks.map((check) => ({
        kind: check.kind as PublicationCheckKind,
        outcome: check.outcome as PublicationCheckOutcome,
        at: date(check.at),
      })),
      consumedWorkIds: checks.flatMap((check) => (typeof check.workId === "number" ? [check.workId] : [])),
    };
  });
}

/** The newest `publish.verify` work of a publication (its subject is the publication's id). */
export interface FanslyVerifyWorkFacts {
  id: number;
  state: string;
  createdAt: Date;
  closedAt: Date | null;
  closeReason: string | null;
  result: unknown;
}

export async function getLatestFanslyVerifyWork(db: Database, input: { pageId: number; publicationId: number }): Promise<FanslyVerifyWorkFacts | null> {
  const result = await db.execute<Row>(sql`
    select id, state, created_at, closed_at, close_reason, result from sync_work
     where page_id = ${input.pageId} and not shadow and resource = 'publish.verify' and subject = ${String(input.publicationId)}
     order by id desc limit 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: num(row.id),
    state: String(row.state),
    createdAt: date(row.created_at),
    closedAt: nullableDate(row.closed_at),
    closeReason: (row.close_reason as string | null) ?? null,
    result: row.result ?? null,
  };
}

/** A Fansly withdrawal Hub follows (plan PR 9): the publication, and its latest cancel command. */
export interface FanslyWithdrawalFacts {
  dispatchId: number;
  publicationId: number;
  pageId: number;
  status: PublicationStatus;
  publishAt: Date;
  platformPostRef: string | null;
  command: { id: number; state: string; stateReason: string | null; createdAt: Date; settledAt: Date | null } | null;
}

/** The withdrawals of Fansly posts still in the schedule (or whose cancel is under way). */
export async function listFanslyWithdrawals(db: Database): Promise<FanslyWithdrawalFacts[]> {
  const result = await db.execute<Row>(sql`
    select d.id as dispatch_id, p.id, p.page_id, p.status, p.publish_at, p.platform_post_ref,
           c.id as command_id, c.state, c.state_reason, c.created_at as command_created_at, c.settled_at
      from publication_dispatches d
      join publications p on p.id = d.publication_id
      left join lateral (
        select fc.id, fc.state, fc.state_reason, fc.created_at, fc.settled_at from fansly_write_commands fc
         where fc.dispatch_id = d.id and fc.step = 'post_cancel' order by fc.id desc limit 1
      ) c on true
     where d.kind = 'withdraw' and d.platform = 'fansly' and p.status = 'scheduled'
       -- Once the publication moved after its cancel settled (the follow-up
       -- said "unknown", then a read or a person said "scheduled"), the
       -- cancel has spoken: never undo them.
       and (c.settled_at is null or p.status_changed_at <= c.settled_at)
     order by p.publish_at, p.id
  `);
  return result.rows.map((row) => ({
    dispatchId: num(row.dispatch_id),
    publicationId: num(row.id),
    pageId: num(row.page_id),
    status: row.status as PublicationStatus,
    publishAt: date(row.publish_at),
    platformPostRef: (row.platform_post_ref as string | null) ?? null,
    command: row.command_id === null || row.command_id === undefined ? null : {
      id: num(row.command_id),
      state: String(row.state),
      stateReason: (row.state_reason as string | null) ?? null,
      createdAt: date(row.command_created_at),
      settledAt: nullableDate(row.settled_at),
    },
  }));
}

/** A deletion of a published Fansly post Hub follows (0305): the publication, and its latest delete command. */
export interface FanslyDeletionFacts {
  dispatchId: number;
  publicationId: number;
  pageId: number;
  platformPostRef: string | null;
  command: { id: number; state: string; stateReason: string | null; createdAt: Date; settledAt: Date | null };
}

/**
 * The deletions whose outcome is still open: the post still "published", its
 * delete command on its way, answered (a fresh read decides) or lost. One that
 * never left or that Fansly refused leaves the post as it is: not listed.
 */
export async function listFanslyDeletions(db: Database): Promise<FanslyDeletionFacts[]> {
  const result = await db.execute<Row>(sql`
    select d.id as dispatch_id, p.id, p.page_id, p.platform_post_ref,
           c.id as command_id, c.state, c.state_reason, c.created_at as command_created_at, c.settled_at
      from publication_dispatches d
      join publications p on p.id = d.publication_id
      join lateral (
        select fc.id, fc.state, fc.state_reason, fc.created_at, fc.settled_at from fansly_write_commands fc
         where fc.dispatch_id = d.id and fc.step = 'post_delete' order by fc.id desc limit 1
      ) c on true
     where d.kind = 'delete' and d.platform = 'fansly' and p.status = 'published'
       and c.state in ('queued', 'sending', 'answered', 'unknown')
       -- A person's "published" after the deletion's outcome stands.
       and (c.settled_at is null or p.status_changed_at <= c.settled_at)
     order by d.id
  `);
  return result.rows.map((row) => ({
    dispatchId: num(row.dispatch_id),
    publicationId: num(row.id),
    pageId: num(row.page_id),
    platformPostRef: (row.platform_post_ref as string | null) ?? null,
    command: {
      id: num(row.command_id),
      state: String(row.state),
      stateReason: (row.state_reason as string | null) ?? null,
      createdAt: date(row.command_created_at),
      settledAt: nullableDate(row.settled_at),
    },
  }));
}

/** An active Fansly page whose schedule Hub reads (plan PR 9): the latest read is its snapshot. */
export async function listFanslyQueuePages(db: Database): Promise<Array<{ pageId: number; pageLabel: string; inFlight: boolean }>> {
  const result = await db.execute<Row>(sql`
    select pg.id, pg.label,
           exists (select 1 from publications p
                    where p.page_id = pg.id and p.status in ('submitting', 'scheduled') and p.kind <> 'story') as in_flight
      from pages pg
      join sync_pages sp on sp.page_id = pg.id
     where pg.platform::text = 'fansly' and pg.status = 'active' and pg.deleted_at is null
     order by pg.label
  `);
  return result.rows.map((row) => ({ pageId: num(row.id), pageLabel: String(row.label), inFlight: row.in_flight === true }));
}

/** The platform post refs other publications of the page already claim (one post, one publication). */
export async function listClaimedPlatformPostRefs(db: Database, pageId: number, excludePublicationId: number): Promise<Set<string>> {
  const result = await db.execute<Row>(sql`
    select platform_post_ref from publications
     where page_id = ${pageId} and id <> ${excludePublicationId} and platform_post_ref is not null
  `);
  return new Set(result.rows.map((row) => String(row.platform_post_ref)));
}

export interface CollectedPostFacts {
  postRef: string;
  publishedAt: Date;
  text: string;
  attachmentCount: number;
  attachmentRefs: string[];
}

/** The page's posts Hub collected, published in [from, to] (the free half of the unknown search, spec §8.2). */
export async function listCollectedPostsBetween(db: Database, input: { pageId: number; from: Date; to: Date }): Promise<CollectedPostFacts[]> {
  const result = await db.execute<Row>(sql`
    select platform_post_id, published_at, text_plain, attachment_count,
           coalesce((select array_agg(ref->>'contentId') from jsonb_array_elements(
             case when jsonb_typeof(attachment_refs) = 'array' then attachment_refs else '[]'::jsonb end) ref
             where ref ? 'contentId'), '{}') as refs
      from creator_posts
     where account_id = ${input.pageId} and published_at >= ${input.from} and published_at <= ${input.to}
     order by published_at
     limit 500
  `);
  return result.rows.map((row) => ({
    postRef: String(row.platform_post_id),
    publishedAt: date(row.published_at),
    text: String(row.text_plain ?? ""),
    attachmentCount: num(row.attachment_count ?? 0),
    attachmentRefs: stringArray(row.refs),
  }));
}

// ---------------------------------------------------------------------------
// The platform's schedule (0302, plan PR 5b): the latest read per page.
// ---------------------------------------------------------------------------

export interface PublicationQueueEntryFacts {
  queueId: string;
  postRef: string | null;
  publishAt: string | null;
  text: string;
  mediaCount: number | null;
  /** The files (the platform's media ids) the entry carries, as far as the
   *  read named them; absent from reads before 2026-10-25. */
  mediaRefs?: string[];
  /** Fansly: its attachments' content ids (account media, bundles). */
  attachmentRefs?: string[];
}

export interface PublicationQueueSnapshotRecord {
  pageId: number;
  readAt: Date | null;
  windowFrom: string | null;
  windowTo: string | null;
  complete: boolean;
  incompleteReasons: string[];
  postsPerDay: Record<string, number>;
  entries: PublicationQueueEntryFacts[];
  refreshRequestedAt: Date | null;
  refreshRequestedByUserId: number | null;
  lastFailure: string | null;
  lastFailedAt: Date | null;
}

function dayText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function toSnapshot(row: Row): PublicationQueueSnapshotRecord {
  return {
    pageId: num(row.page_id),
    readAt: nullableDate(row.read_at),
    windowFrom: dayText(row.window_from),
    windowTo: dayText(row.window_to),
    complete: row.complete === true,
    incompleteReasons: stringArray(row.incomplete_reasons),
    postsPerDay: (row.posts_per_day as Record<string, number> | null) ?? {},
    entries: Array.isArray(row.entries) ? row.entries as PublicationQueueEntryFacts[] : [],
    refreshRequestedAt: nullableDate(row.refresh_requested_at),
    refreshRequestedByUserId: nullableNum(row.refresh_requested_by_user_id),
    lastFailure: (row.last_failure as string | null) ?? null,
    lastFailedAt: nullableDate(row.last_failed_at),
  };
}

export async function listPublicationQueueSnapshots(db: Database, pageIds: readonly number[]): Promise<PublicationQueueSnapshotRecord[]> {
  if (pageIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select * from publication_queue_snapshots where page_id = any(${sql.param([...pageIds])}::bigint[])
  `);
  return result.rows.map(toSnapshot);
}

/**
 * Clears the owner's refresh request the read answered (the one seen when it
 * began, compared in the database's own milliseconds); a newer press stays.
 */
function answeredRequest(answeredRequestAt: Date | null) {
  return sql`(publication_queue_snapshots.refresh_requested_at is not null and ${answeredRequestAt}::timestamptz is not null
    and date_trunc('milliseconds', publication_queue_snapshots.refresh_requested_at) <= ${answeredRequestAt}::timestamptz)`;
}

/** A good read replaces the page's snapshot; the refresh it answered is done. */
export async function savePublicationQueueSnapshot(db: Database, input: {
  pageId: number;
  answeredRequestAt: Date | null;
  readAt: Date;
  /** The UTC days the read covers; null: the whole schedule (Fansly's list is not windowed). */
  windowFrom: string | null;
  windowTo: string | null;
  complete: boolean;
  incompleteReasons: readonly string[];
  postsPerDay: Record<string, number>;
  entries: readonly PublicationQueueEntryFacts[];
  evidence: Record<string, unknown>;
}): Promise<void> {
  await db.execute(sql`
    insert into publication_queue_snapshots (
      page_id, read_at, window_from, window_to, complete, incomplete_reasons, posts_per_day, entries, evidence, updated_at
    ) values (
      ${input.pageId}, ${input.readAt}, ${input.windowFrom}::date, ${input.windowTo}::date, ${input.complete},
      ${sql.param([...input.incompleteReasons])}::text[], ${JSON.stringify(input.postsPerDay)}::jsonb,
      ${JSON.stringify(input.entries)}::jsonb, ${JSON.stringify(input.evidence)}::jsonb, now()
    )
    on conflict (page_id) do update set
      read_at = excluded.read_at, window_from = excluded.window_from, window_to = excluded.window_to,
      complete = excluded.complete, incomplete_reasons = excluded.incomplete_reasons,
      posts_per_day = excluded.posts_per_day, entries = excluded.entries, evidence = excluded.evidence,
      refresh_requested_at = case when ${answeredRequest(input.answeredRequestAt)}
        then null else publication_queue_snapshots.refresh_requested_at end,
      refresh_requested_by_user_id = case when ${answeredRequest(input.answeredRequestAt)}
        then null else publication_queue_snapshots.refresh_requested_by_user_id end,
      updated_at = now()
  `);
}

/** A failed read keeps the last good one beside it; the refresh it answered is done. */
export async function recordPublicationQueueFailure(db: Database, input: { pageId: number; answeredRequestAt: Date | null; failedAt: Date; reason: string }): Promise<void> {
  await db.execute(sql`
    insert into publication_queue_snapshots (page_id, last_failure, last_failed_at, updated_at)
    values (${input.pageId}, ${input.reason.slice(0, 300)}, ${input.failedAt}, now())
    on conflict (page_id) do update set
      last_failure = excluded.last_failure, last_failed_at = excluded.last_failed_at,
      refresh_requested_at = case when ${answeredRequest(input.answeredRequestAt)}
        then null else publication_queue_snapshots.refresh_requested_at end,
      refresh_requested_by_user_id = case when ${answeredRequest(input.answeredRequestAt)}
        then null else publication_queue_snapshots.refresh_requested_by_user_id end,
      updated_at = now()
  `);
}

/** The owner's "Обновить": the minutely job reads the page's schedule on its next turn. */
export async function requestPublicationQueueRefresh(db: Database, input: { pageId: number; userId: number }): Promise<void> {
  await db.execute(sql`
    insert into publication_queue_snapshots (page_id, refresh_requested_at, refresh_requested_by_user_id, updated_at)
    values (${input.pageId}, now(), ${input.userId}, now())
    on conflict (page_id) do update set
      refresh_requested_at = now(), refresh_requested_by_user_id = excluded.refresh_requested_by_user_id, updated_at = now()
  `);
}

/** An active, bound OnlyFans page whose schedule Hub reads, with what decides when and as whom. */
export interface OnlyfansQueuePageFacts {
  pageId: number;
  pageLabel: string;
  /** Hub posts of the page sent or being sent into the schedule, still ahead. */
  inFlight: boolean;
  publishingEnabled: boolean;
  /** The person a scheduled read runs as: who approved the page's latest publication, or who set its publishing. */
  defaultActorUserId: number | null;
}

export async function listOnlyfansQueuePages(db: Database, now: Date): Promise<OnlyfansQueuePageFacts[]> {
  const result = await db.execute<Row>(sql`
    select pg.id, pg.label,
           exists (select 1 from publications p
                    where p.page_id = pg.id and p.status in ('submitting', 'scheduled') and p.publish_at > ${now}) as in_flight,
           coalesce(s.enabled, false) as publishing_enabled,
           coalesce((select r.approved_by_user_id from publication_revisions r where r.page_id = pg.id order by r.id desc limit 1),
                    s.updated_by_user_id) as default_actor_user_id
      from pages pg
      left join page_publishing_settings s on s.page_id = pg.id
     where pg.platform::text = 'onlyfans' and pg.status = 'active' and pg.deleted_at is null
       and pg.ofapi_account_id is not null
     order by pg.label
  `);
  return result.rows.map((row) => ({
    pageId: num(row.id),
    pageLabel: String(row.label),
    inFlight: row.in_flight === true,
    publishingEnabled: row.publishing_enabled === true,
    defaultActorUserId: nullableNum(row.default_actor_user_id),
  }));
}

/** The page's publications that claim a platform post, by that post's ref. */
export async function listPublicationsByPlatformPostRef(db: Database, pageId: number): Promise<Map<string, { id: number; status: PublicationStatus }>> {
  const result = await db.execute<Row>(sql`
    select id, status, platform_post_ref from publications where page_id = ${pageId} and platform_post_ref is not null
  `);
  return new Map(result.rows.map((row) => [String(row.platform_post_ref), { id: num(row.id), status: row.status as PublicationStatus }]));
}

/** The page's Hub posts in the platform's schedule, earliest first ("Снять всё, что поставил Hub"). */
export async function listScheduledPublicationIds(db: Database, pageId: number): Promise<number[]> {
  const result = await db.execute<Row>(sql`
    select id from publications where page_id = ${pageId} and status = 'scheduled' and kind <> 'story'
     order by publish_at, id
  `);
  return result.rows.map((row) => num(row.id));
}

// ---------------------------------------------------------------------------
// Uploads (0303, plan PR 4c): new files of OnlyFans publications.
// ---------------------------------------------------------------------------

export interface PublicationUploadRecord {
  id: number;
  publicationId: number;
  revisionId: number;
  role: PublicationMediaRole;
  position: number;
  fileId: number;
  ofapiMediaSourceId: string;
  captureJobId: string;
  estimatedCredits: number;
  createdAt: Date;
  /** The upload job as it stands: its state, why it stopped, and its one-use id once complete. */
  jobState: string | null;
  jobReason: string | null;
  uploadStatus: string | null;
  mediaRef: string | null;
}

/** Record the upload of one file of one approval; the first record wins. */
export async function insertPublicationUpload(db: Database, input: {
  publicationId: number;
  revisionId: number;
  role: PublicationMediaRole;
  position: number;
  fileId: number;
  ofapiMediaSourceId: string;
  captureJobId: string;
  estimatedCredits: number;
}): Promise<void> {
  await db.execute(sql`
    insert into publication_uploads (publication_id, page_id, revision_id, role, position, file_id, ofapi_media_source_id, capture_job_id, estimated_credits)
    select ${input.publicationId}, p.page_id, ${input.revisionId}, ${input.role}, ${input.position}, ${input.fileId},
           ${input.ofapiMediaSourceId}::uuid, ${input.captureJobId}::uuid, ${input.estimatedCredits}
      from publications p where p.id = ${input.publicationId}
    on conflict (publication_id, revision_id, role, position) do nothing
  `);
}

/** The uploads of one approval of a publication, with their jobs' state. */
export async function listPublicationUploads(db: Database, publicationId: number, revisionId: number): Promise<PublicationUploadRecord[]> {
  const result = await db.execute<Row>(sql`
    select u.*, j.state as job_state, j.reason_code as job_reason, j.cursor->>'status' as upload_status,
           j.cursor->>'mediaRef' as media_ref
      from publication_uploads u
      left join ofapi_capture_jobs j on j.id = u.capture_job_id
     where u.publication_id = ${publicationId} and u.revision_id = ${revisionId}
     order by u.role, u.position
  `);
  return result.rows.map((row) => ({
    id: num(row.id),
    publicationId: num(row.publication_id),
    revisionId: num(row.revision_id),
    role: row.role as PublicationMediaRole,
    position: num(row.position),
    fileId: num(row.file_id),
    ofapiMediaSourceId: String(row.ofapi_media_source_id),
    captureJobId: String(row.capture_job_id),
    estimatedCredits: num(row.estimated_credits),
    createdAt: date(row.created_at),
    jobState: (row.job_state as string | null) ?? null,
    jobReason: (row.job_reason as string | null) ?? null,
    uploadStatus: (row.upload_status as string | null) ?? null,
    mediaRef: (row.media_ref as string | null) ?? null,
  }));
}

/** OnlyFansAPI credits publications' uploads were allowed since `since` (their estimates). */
export async function sumPublicationUploadCreditsSince(db: Database, since: Date): Promise<number> {
  const result = await db.execute<Row>(sql`
    select coalesce(sum(estimated_credits), 0) as n from publication_uploads where created_at >= ${since}
  `);
  return num(result.rows[0]?.n ?? 0);
}

/**
 * Whether a page's Fansly schedule is worth reading (`GET /post/scheduled`):
 * its publishing is on, or Hub has a post of the page in flight there. A page
 * with publishing off and nothing of Hub's on it gets no new kind of request.
 */
export async function fanslyScheduleReadWanted(db: Database, pageId: number): Promise<boolean> {
  const result = await db.execute<Row>(sql`
    select exists(
      select 1 from page_publishing_settings where page_id = ${pageId} and enabled
    ) or exists(
      select 1 from publications p
        join publication_dispatches d on d.publication_id = p.id and d.platform = 'fansly'
       where p.page_id = ${pageId} and p.status in ('submitting', 'scheduled', 'processing', 'unknown')
    ) as wanted
  `);
  return result.rows[0]?.wanted === true;
}
