import { sql } from "drizzle-orm";

import {
  PUBLICATION_ACTIVE_STATUSES,
  PUBLICATION_DEFAULT_REPOST_THRESHOLD_DAYS,
  PUBLICATION_VOLUME_BASELINE_DAYS,
  type PublicationActorKind,
  type PublicationAuthorKind,
  type PublicationKind,
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
  };
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
  };
}

const PUBLICATION_COLUMNS = sql`
  p.id, p.page_id, pg.label as page_label, pg.platform::text as platform, p.kind, p.status, p.version,
  p.text, p.publish_at, p.expires_at, p.wall_refs, p.tier_refs, p.price_mills, p.repost, p.findings,
  p.author_kind, p.author_user_id, p.author_agent_key_id, p.idempotency_key, p.approved_revision_id,
  p.platform_post_ref, p.status_reason, p.previous_publication_id, p.created_at, p.updated_at,
  p.status_changed_at
`;

async function attachMedia(db: Database, rows: Row[]): Promise<PublicationRecord[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => num(row.id));
  const media = await db.execute<Row>(sql`
    select publication_id, role, position, source, platform_media_ref, file_id
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

async function writeMedia(tx: Database, publicationId: number, media: readonly PublicationMediaItem[]) {
  await tx.execute(sql`delete from publication_media where publication_id = ${publicationId}`);
  for (const item of media) {
    await tx.execute(sql`
      insert into publication_media (publication_id, role, position, source, platform_media_ref, file_id)
      values (${publicationId}, ${item.role}, ${item.position}, ${item.source}, ${item.platformMediaRef}, ${item.fileId})
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
        findings, author_kind, author_user_id, author_agent_key_id, idempotency_key, previous_publication_id
      ) values (
        ${input.pageId}, ${input.kind}, 'draft', ${input.text}, ${input.publishAt}, ${input.expiresAt},
        ${sql.param([...input.wallRefs])}::text[], ${sql.param([...input.tierRefs])}::text[],
        ${input.priceMills}, ${input.repost}, ${JSON.stringify(input.findings)}::jsonb,
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
    await writeMedia(tx, id, input.media);
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
    await writeMedia(tx, input.id, content.media);
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
  platformPostRef?: string | null;
  findings?: unknown[];
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
}

export async function getPublicationFiles(db: Database, fileIds: readonly number[]): Promise<PublicationFileFacts[]> {
  if (fileIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select id, model_id, content_sha256 from publication_files
     where id = any(${sql.param([...fileIds])}::bigint[])
  `);
  return result.rows.map((row) => ({ id: num(row.id), modelId: num(row.model_id), contentSha256: String(row.content_sha256) }));
}

/** The vault refs among `refs` that Hub collected as this page's own media. */
export async function findPageMediaRefs(db: Database, pageId: number, refs: readonly string[]): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const result = await db.execute<Row>(sql`
    select media_ref from creator_raw_media
     where page_id = ${pageId} and media_ref = any(${sql.param([...refs])}::text[])
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
}

/**
 * When each media of a draft last went out on its page, or is booked to (spec
 * §8.1 "Повтор"): among the page's posts Hub collected — on Fansly a post
 * points at an offer (accountMedia) or a bundle of offers that wrap the file,
 * on OnlyFans straight at the vault media id — and among the page's live
 * publications (approved, on the way, on the platform, unknown), the one
 * closest in time to `publishAt`. The platforms' own schedule reads join here
 * when they exist (plan PR 5, PR 9).
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
  for (const ref of new Set(input.vaultRefs)) {
    const posted = input.platform === "fansly"
      ? await db.execute<Row>(sql`
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
      : await db.execute<Row>(sql`
          select published_at, platform_post_id from creator_posts
           where account_id = ${input.pageId}
             and attachment_refs @> jsonb_build_array(jsonb_build_object('contentId', ${ref}::text))
           order by published_at desc limit 1
        `);
    const nearest = await db.execute<Row>(sql`
      select p.id, p.publish_at from publications p
        join publication_media pm on pm.publication_id = p.id
       where p.page_id = ${input.pageId} and p.id <> ${exclude} and p.status = any(${active}::text[])
         and pm.role = 'media' and pm.platform_media_ref = ${ref}
       order by abs(extract(epoch from p.publish_at - ${input.publishAt}::timestamptz)), p.id
       limit 1
    `);
    out.push({
      key: `vault:${ref}`,
      lastPostedAt: nullableDate(posted.rows[0]?.published_at),
      lastPostRef: (posted.rows[0]?.platform_post_id as string | undefined) ?? null,
      nearestPublicationId: nullableNum(nearest.rows[0]?.id),
      nearestPublicationAt: nullableDate(nearest.rows[0]?.publish_at),
    });
  }
  for (const fileId of new Set(input.fileIds)) {
    const nearest = await db.execute<Row>(sql`
      select p.id, p.publish_at from publications p
        join publication_media pm on pm.publication_id = p.id
       where p.page_id = ${input.pageId} and p.id <> ${exclude} and p.status = any(${active}::text[])
         and pm.role = 'media' and pm.file_id = ${fileId}
       order by abs(extract(epoch from p.publish_at - ${input.publishAt}::timestamptz)), p.id
       limit 1
    `);
    out.push({
      key: `file:${fileId}`,
      lastPostedAt: null,
      lastPostRef: null,
      nearestPublicationId: nullableNum(nearest.rows[0]?.id),
      nearestPublicationAt: nullableDate(nearest.rows[0]?.publish_at),
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

export type PublicationDispatchKind = "create" | "withdraw";
export type PublicationDispatchMode = "scheduled" | "now" | "story" | "withdraw";

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
