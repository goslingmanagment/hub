import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import type { AiMediaDescriptionStatus } from "../schema.ts";
import { isDmArchiveScopeFenced, tryAcquireDmArchiveWriterFenceLock } from "./erasure-fence.ts";

// AI media describer (0212, docs/runbooks/ai-media-describe.md). Restricted
// class: description text and where a file appeared. Nothing here stores or
// returns a URL or image bytes.

export type AiMediaPlatform = "fansly" | "onlyfans";
export type AiMediaVariant = "full" | "poster" | "preview";
export type AiMediaKind = "photo" | "video" | "gif" | "bundle";
export type AiMediaSenderRole = "fan" | "model";

/** Statuses the sweep may pick up. */
export const AI_MEDIA_DUE_STATUSES = ["pending", "budget_deferred"] as const;

/** Terminal statuses: never sent again by the sweep. */
export const AI_MEDIA_TERMINAL_STATUSES = [
  "described",
  "refused",
  "unavailable",
  "failed",
  "outcome_unknown",
  "skipped_policy",
] as const satisfies readonly AiMediaDescriptionStatus[];

export interface AiMediaDescriptionRow {
  id: number;
  pageId: number;
  platform: AiMediaPlatform;
  mediaRef: string;
  variant: AiMediaVariant;
  mediaKind: AiMediaKind;
  senderRole: AiMediaSenderRole;
  fanPlatformUserId: string | null;
  status: AiMediaDescriptionStatus;
  description: string | null;
  sourceObservationId: number | null;
  contentSha256: string | null;
  attempts: number;
  firstMessageAt: Date | null;
  nextAttemptAt: Date;
  /** The claim's ownership token (0214); every settle must present it. */
  leaseToken: string | null;
}

export interface AiMediaDescriptionLinkInput {
  messageRef: string;
  conversationRef: string | null;
  fanPlatformUserId: string | null;
  senderRole: AiMediaSenderRole;
  messageAt: Date | null;
}

export interface UpsertAiMediaCandidateInput {
  pageId: number;
  platform: AiMediaPlatform;
  mediaRef: string;
  variant: AiMediaVariant;
  mediaKind: AiMediaKind;
  senderRole: AiMediaSenderRole;
  /** The fan who sent a fan-sent file; NULL for creator media. */
  fanPlatformUserId: string | null;
  /** 'pending' when a source is known, 'awaiting_source' otherwise;
   * 'dormant' when known but only a generation should trigger it. */
  status: "pending" | "awaiting_source" | "dormant";
  sourceObservationId: number | null;
  link: AiMediaDescriptionLinkInput;
  /** When the material was observed (erasure fence bound). */
  observedAt: Date;
  now?: Date;
}

export type UpsertAiMediaCandidateResult =
  | { status: "applied"; descriptionId: number; descriptionStatus: AiMediaDescriptionStatus }
  | { status: "deferred" | "erasure_fenced" };

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value : new Date(String(value));
}

function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function mapRow(row: Record<string, unknown>): AiMediaDescriptionRow {
  return {
    id: Number(row.id),
    pageId: Number(row.page_id),
    platform: row.platform as AiMediaPlatform,
    mediaRef: String(row.media_ref),
    variant: row.variant as AiMediaVariant,
    mediaKind: row.media_kind as AiMediaKind,
    senderRole: row.sender_role as AiMediaSenderRole,
    fanPlatformUserId: (row.fan_platform_user_id as string | null) ?? null,
    status: row.status as AiMediaDescriptionStatus,
    description: (row.description as string | null) ?? null,
    sourceObservationId: toNumberOrNull(row.source_observation_id),
    contentSha256: (row.content_sha256 as string | null) ?? null,
    attempts: Number(row.attempts ?? 0),
    firstMessageAt: toDate(row.first_message_at),
    nextAttemptAt: toDate(row.next_attempt_at) ?? new Date(0),
    leaseToken: (row.lease_token as string | null) ?? null,
  };
}

/**
 * Candidate write (projector / generation fallback). Idempotent: a replayed
 * event re-applies the same row and link. An existing row only ever learns a
 * newer source observation and an earlier first message; a row waiting for a
 * source becomes pending when one arrives. Terminal rows are never reopened.
 * Serialized against a running erasure through the DM archive fence, so a
 * sweep can never resurrect an erased fan's media.
 */
export async function upsertAiMediaDescriptionCandidate(
  db: Database,
  input: UpsertAiMediaCandidateInput,
): Promise<UpsertAiMediaCandidateResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    if (!(await tryAcquireDmArchiveWriterFenceLock(database, input.pageId))) {
      return { status: "deferred" } as const;
    }
    const messageAt = input.link.messageAt;
    const materialAt = messageAt !== null && messageAt < input.observedAt ? messageAt : input.observedAt;
    if (
      await isDmArchiveScopeFenced(database, {
        pageId: input.pageId,
        platform: input.platform,
        refs: [input.fanPlatformUserId, input.link.fanPlatformUserId, input.link.conversationRef],
        materialAt,
      })
    ) {
      return { status: "erasure_fenced" } as const;
    }

    const upserted = await database.execute<{ id: string; status: AiMediaDescriptionStatus }>(sql`
      insert into ai_media_descriptions (
        page_id, platform, media_ref, variant, media_kind, sender_role,
        fan_platform_user_id, status, source_observation_id, first_message_at,
        next_attempt_at, created_at, updated_at
      ) values (
        ${input.pageId}, ${input.platform}, ${input.mediaRef}, ${input.variant},
        ${input.mediaKind}, ${input.senderRole}, ${input.fanPlatformUserId},
        ${input.status}, ${input.sourceObservationId}, ${messageAt},
        ${now}, ${now}, ${now}
      )
      on conflict (page_id, platform, media_ref, variant) do update set
        -- A generation may not know the sender; the capture later does.
        fan_platform_user_id = coalesce(ai_media_descriptions.fan_platform_user_id, excluded.fan_platform_user_id),
        source_observation_id = case
          when excluded.source_observation_id is not null
            and (ai_media_descriptions.source_observation_id is null
              or excluded.source_observation_id > ai_media_descriptions.source_observation_id)
            then excluded.source_observation_id
          else ai_media_descriptions.source_observation_id
        end,
        first_message_at = case
          when ai_media_descriptions.first_message_at is null then excluded.first_message_at
          when excluded.first_message_at is null then ai_media_descriptions.first_message_at
          else least(ai_media_descriptions.first_message_at, excluded.first_message_at)
        end,
        -- A row waiting for a source becomes due once one arrives (a
        -- generation already asked for it); a dormant row is promoted to
        -- pending by a later candidate that is itself due.
        status = case
          when ai_media_descriptions.status = 'awaiting_source'
            and excluded.source_observation_id is not null then 'pending'
          when ai_media_descriptions.status = 'dormant'
            and excluded.status = 'pending' then 'pending'
          else ai_media_descriptions.status
        end,
        next_attempt_at = case
          when (ai_media_descriptions.status = 'awaiting_source'
              and excluded.source_observation_id is not null)
            or (ai_media_descriptions.status = 'dormant' and excluded.status = 'pending')
            then excluded.next_attempt_at
          else ai_media_descriptions.next_attempt_at
        end,
        -- Checks while waiting for a source were not failures: a row that
        -- finally has one starts its retry budget afresh.
        attempts = case
          when ai_media_descriptions.status = 'awaiting_source'
            and excluded.source_observation_id is not null then 0
          else ai_media_descriptions.attempts
        end,
        updated_at = excluded.updated_at
      returning id, status
    `);
    const row = upserted.rows[0];
    if (!row) {
      throw new Error("ai_media_descriptions upsert returned no row");
    }
    const descriptionId = Number(row.id);
    await database.execute(sql`
      insert into ai_media_description_links (
        description_id, page_id, platform, message_ref, conversation_ref,
        fan_platform_user_id, sender_role, message_at, created_at
      ) values (
        ${descriptionId}, ${input.pageId}, ${input.platform}, ${input.link.messageRef},
        ${input.link.conversationRef}, ${input.link.fanPlatformUserId},
        ${input.link.senderRole}, ${messageAt}, ${now}
      )
      on conflict (description_id, message_ref) do nothing
    `);
    return { status: "applied", descriptionId, descriptionStatus: row.status } as const;
  });
}

/**
 * Claims the next due row: sets lease_until (the single-flight guard), a fresh
 * ownership token and counts the attempt. A row whose lease is live is never
 * claimed twice, so two workers cannot double-send one file. One row per call,
 * so a fresh file never waits behind a batch: rows whose first message is
 * newer than `freshSince` come first, then the oldest due.
 */
export async function claimNextDueAiMediaDescription(
  db: Database,
  input: { pageIds: readonly number[]; now: Date; leaseMs: number; leaseToken: string; freshSince: Date },
): Promise<AiMediaDescriptionRow | null> {
  if (input.pageIds.length === 0) {
    return null;
  }
  const leaseUntil = new Date(input.now.getTime() + input.leaseMs);
  const pageIds = sql.join(input.pageIds.map((id) => sql`${id}`), sql`, `);
  const claimed = await db.execute(sql`
    update ai_media_descriptions d set
      lease_until = ${leaseUntil},
      lease_token = ${input.leaseToken}::uuid,
      attempts = d.attempts + 1,
      updated_at = ${input.now}
    where d.id = (
      select id from ai_media_descriptions
      -- awaiting_source rows come back on their retry time (OnlyFans: 1, 5,
      -- 30 min, then 6 h); a row with no retry waits for its 7-day expiry.
      where status in ('pending', 'budget_deferred', 'awaiting_source')
        and next_attempt_at <= ${input.now}
        and (lease_until is null or lease_until < ${input.now})
        and page_id in (${pageIds})
      order by (first_message_at is not null and first_message_at >= ${input.freshSince}) desc,
        next_attempt_at asc, id asc
      limit 1
      for update skip locked
    )
    returning d.*
  `);
  const row = claimed.rows[0] as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

/** Whether any row of these pages is due now (the describe loop's idle probe:
 * one select on the partial due index). */
export async function hasDueAiMediaDescriptions(
  db: Database,
  input: { pageIds: readonly number[]; now: Date },
): Promise<boolean> {
  if (input.pageIds.length === 0) {
    return false;
  }
  const pageIds = sql.join(input.pageIds.map((id) => sql`${id}`), sql`, `);
  const result = await db.execute<{ due: boolean }>(sql`
    select exists (
      select 1 from ai_media_descriptions
      where status in ('pending', 'budget_deferred', 'awaiting_source')
        and next_attempt_at <= ${input.now}
        and (lease_until is null or lease_until < ${input.now})
        and page_id in (${pageIds})
    ) as due
  `);
  return result.rows[0]?.due === true;
}

export interface FinishAiMediaDescriptionInput {
  id: number;
  /** The token of the claim being settled (compare-and-set). */
  leaseToken: string;
  status: AiMediaDescriptionStatus;
  /** The real settle time: a terminal status stamps it as `described_at`. */
  now: Date;
  description?: string | null;
  model?: string | null;
  descriptionVersion?: number | null;
  source?: string | null;
  contentSha256?: string | null;
  usageEventId?: number | null;
  errorCode?: string | null;
  /** Non-terminal statuses only: when the sweep may look again. */
  nextAttemptAt?: Date;
}

const TERMINAL = new Set<string>(AI_MEDIA_TERMINAL_STATUSES);

/**
 * Settles a claimed row and releases its lease. Only the holder of the
 * claim's token can settle it: false means the row was claimed again after
 * this lease expired, and nothing was written. The token itself is kept.
 */
export async function finishAiMediaDescription(
  db: Database,
  input: FinishAiMediaDescriptionInput,
): Promise<boolean> {
  const terminal = TERMINAL.has(input.status);
  const updated = await db.execute(sql`
    update ai_media_descriptions set
      status = ${input.status},
      description = ${input.description ?? null},
      model = coalesce(${input.model ?? null}, model),
      description_version = coalesce(${input.descriptionVersion ?? null}, description_version),
      source = coalesce(${input.source ?? null}, source),
      content_sha256 = coalesce(${input.contentSha256 ?? null}, content_sha256),
      usage_event_id = coalesce(${input.usageEventId ?? null}, usage_event_id),
      error_code = ${input.errorCode ?? null},
      next_attempt_at = ${input.nextAttemptAt ?? input.now},
      lease_until = null,
      described_at = ${terminal ? input.now : null},
      updated_at = ${input.now}
    where id = ${input.id} and lease_token = ${input.leaseToken}::uuid
  `);
  return Number((updated as { rowCount?: number | null }).rowCount ?? 0) === 1;
}

/** Refusal memory by file, across every variant of it. */
export async function isAiMediaRefRefused(
  db: Database,
  input: { pageId: number; platform: AiMediaPlatform; mediaRef: string },
): Promise<boolean> {
  const result = await db.execute<{ refused: boolean }>(sql`
    select exists (
      select 1 from ai_media_descriptions
      where page_id = ${input.pageId} and platform = ${input.platform}
        and media_ref = ${input.mediaRef} and status = 'refused'
    ) as refused
  `);
  return result.rows[0]?.refused === true;
}

/** Refusal memory by content: the same bytes refused anywhere, any variant. */
export async function isAiMediaContentRefused(db: Database, contentSha256: string): Promise<boolean> {
  const result = await db.execute<{ refused: boolean }>(sql`
    select exists (
      select 1 from ai_media_descriptions
      where status = 'refused' and content_sha256 = ${contentSha256}
    ) as refused
  `);
  return result.rows[0]?.refused === true;
}

/** An already-described copy of the same bytes (re-sent file, other page):
 * reused instead of paying for a second call. */
export async function findDescribedAiMediaByContent(
  db: Database,
  contentSha256: string,
): Promise<{ description: string; model: string | null; descriptionVersion: number | null } | null> {
  const result = await db.execute<{ description: string; model: string | null; description_version: number | null }>(sql`
    select description, model, description_version from ai_media_descriptions
    where status = 'described' and content_sha256 = ${contentSha256} and description is not null
    order by described_at desc nulls last
    limit 1
  `);
  const row = result.rows[0];
  return row
    ? { description: row.description, model: row.model, descriptionVersion: toNumberOrNull(row.description_version) }
    : null;
}

/** Rows waiting for a source longer than `olderThan` become unavailable. */
export async function expireAwaitingSourceAiMediaDescriptions(
  db: Database,
  input: { olderThan: Date; now: Date },
): Promise<number> {
  const updated = await db.execute(sql`
    update ai_media_descriptions set
      status = 'unavailable', error_code = 'source_expired',
      described_at = ${input.now}, lease_until = null, updated_at = ${input.now}
    where status = 'awaiting_source' and created_at < ${input.olderThan}
  `);
  return Number((updated as { rowCount?: number | null }).rowCount ?? 0);
}

export interface AiMediaDescriptionLinkRow {
  messageRef: string;
  conversationRef: string | null;
  fanPlatformUserId: string | null;
  senderRole: AiMediaSenderRole;
  messageAt: Date | null;
}

/** The earliest link of a description (who/where for the restricted record). */
export async function getFirstAiMediaDescriptionLink(
  db: Database,
  descriptionId: number,
): Promise<AiMediaDescriptionLinkRow | null> {
  const result = await db.execute(sql`
    select message_ref, conversation_ref, fan_platform_user_id, sender_role, message_at
    from ai_media_description_links
    where description_id = ${descriptionId}
    order by message_at asc nulls last, created_at asc
    limit 1
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row
    ? {
      messageRef: String(row.message_ref),
      conversationRef: (row.conversation_ref as string | null) ?? null,
      fanPlatformUserId: (row.fan_platform_user_id as string | null) ?? null,
      senderRole: row.sender_role as AiMediaSenderRole,
      messageAt: toDate(row.message_at),
    }
    : null;
}

export interface ReadyAiMediaDescription {
  mediaRef: string;
  variant: AiMediaVariant;
  status: AiMediaDescriptionStatus;
  description: string | null;
}

/**
 * The generation-path read: ONE indexed select (the unique key's prefix) of
 * every row for the window's media refs. No network, no writes.
 */
export async function listAiMediaDescriptionsByRefs(
  db: Database,
  input: { pageId: number; platform: AiMediaPlatform; mediaRefs: readonly string[] },
): Promise<ReadyAiMediaDescription[]> {
  if (input.mediaRefs.length === 0) {
    return [];
  }
  const refs = sql.join([...new Set(input.mediaRefs)].map((ref) => sql`${ref}`), sql`, `);
  const result = await db.execute(sql`
    select media_ref, variant, status, description
    from ai_media_descriptions
    where page_id = ${input.pageId} and platform = ${input.platform}
      and media_ref in (${refs})
  `);
  return result.rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      mediaRef: String(record.media_ref),
      variant: record.variant as AiMediaVariant,
      status: record.status as AiMediaDescriptionStatus,
      description: (record.description as string | null) ?? null,
    };
  });
}

// ── Daily budget and refusal count (agency-wide, UTC day) ───────────────────

export interface AiMediaDescribeDayRow {
  day: string;
  imagesReserved: number;
  microUsdReserved: number;
  refusals: number;
  breakerTrippedAt: Date | null;
  breakerReason: string | null;
}

export async function getAiMediaDescribeDay(db: Database, day: string): Promise<AiMediaDescribeDayRow | null> {
  const result = await db.execute(sql`
    select day::text as day, images_reserved, micro_usd_reserved, refusals, breaker_tripped_at, breaker_reason
    from ai_media_describe_days where day = ${day}::date
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row
    ? {
      day: String(row.day),
      imagesReserved: Number(row.images_reserved),
      microUsdReserved: Number(row.micro_usd_reserved),
      refusals: Number(row.refusals),
      breakerTrippedAt: toDate(row.breaker_tripped_at),
      breakerReason: (row.breaker_reason as string | null) ?? null,
    }
    : null;
}

/**
 * Atomic reservation of one image and its worst-case cost against the day's
 * caps. Returns false (nothing reserved) when either cap would be crossed.
 */
export async function reserveAiMediaDescribeBudget(
  db: Database,
  input: { day: string; microUsd: number; imageLimit: number; microUsdLimit: number; now: Date },
): Promise<boolean> {
  await db.execute(sql`
    insert into ai_media_describe_days (day, updated_at) values (${input.day}::date, ${input.now})
    on conflict (day) do nothing
  `);
  const reserved = await db.execute(sql`
    update ai_media_describe_days set
      images_reserved = images_reserved + 1,
      micro_usd_reserved = micro_usd_reserved + ${Math.max(0, Math.ceil(input.microUsd))},
      updated_at = ${input.now}
    where day = ${input.day}::date
      and images_reserved + 1 <= ${input.imageLimit}
      and micro_usd_reserved + ${Math.max(0, Math.ceil(input.microUsd))} <= ${input.microUsdLimit}
    returning day
  `);
  return reserved.rows.length === 1;
}

/**
 * Settles a reservation: `microUsdDelta` = real − reserved (negative returns
 * the unused part). `releaseImage` returns the image slot when the provider
 * provably never processed the request.
 */
export async function settleAiMediaDescribeBudget(
  db: Database,
  input: { day: string; microUsdDelta: number; releaseImage: boolean; now: Date },
): Promise<void> {
  await db.execute(sql`
    update ai_media_describe_days set
      micro_usd_reserved = greatest(0, micro_usd_reserved + ${Math.round(input.microUsdDelta)}),
      images_reserved = greatest(0, images_reserved - ${input.releaseImage ? 1 : 0}),
      updated_at = ${input.now}
    where day = ${input.day}::date
  `);
}

export async function incrementAiMediaDescribeRefusals(
  db: Database,
  input: { day: string; now: Date },
): Promise<number> {
  const result = await db.execute<{ refusals: number }>(sql`
    insert into ai_media_describe_days (day, refusals, updated_at) values (${input.day}::date, 1, ${input.now})
    on conflict (day) do update set refusals = ai_media_describe_days.refusals + 1, updated_at = ${input.now}
    returning refusals
  `);
  return Number(result.rows[0]?.refusals ?? 0);
}

// ── Fansly source helpers ────────────────────────────────────────────────────

/** A chat is "live" when a chatter ran an AI generation in it within the
 * window. Fansly features send either the fan account id or the groupId as
 * the conversation id, so both are checked. System rows never count. */
export async function hasRecentAiGenerationInConversation(
  db: Database,
  input: { pageId: number; conversationRefs: readonly string[]; since: Date },
): Promise<boolean> {
  const refs = [...new Set(input.conversationRefs.filter((ref) => ref.length > 0))];
  if (refs.length === 0) {
    return false;
  }
  const result = await db.execute<{ live: boolean }>(sql`
    select exists (
      select 1 from ai_usage_events
      where page_id = ${input.pageId}
        and completed_at >= ${input.since}
        and user_id is not null
        and conversation_id in (${sql.join(refs.map((ref) => sql`${ref}`), sql`, `)})
    ) as live
  `);
  return result.rows[0]?.live === true;
}

/** The newest captured observation that carried a message's attachments (or
 * a media offer), from the media plane's projected offers. */
export async function findLatestMediaOfferObservation(
  db: Database,
  input: { pageId: number; messageRef: string | null; mediaOfferRef: string },
): Promise<number | null> {
  const result = await db.execute<{ observation_id: string | null }>(sql`
    select max(source_observation_id)::text as observation_id from message_media_offers
    where page_id = ${input.pageId}
      and (${input.messageRef === null ? sql`false` : sql`message_ref = ${input.messageRef}`}
        or media_offer_ref = ${input.mediaOfferRef}
        or bundle_ref = ${input.mediaOfferRef})
  `);
  const value = result.rows[0]?.observation_id;
  return value === null || value === undefined ? null : Number(value);
}
