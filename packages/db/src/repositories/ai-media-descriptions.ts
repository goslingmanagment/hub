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

// ── Daily budget and refusal breaker (agency-wide, UTC day) ─────────────────

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
 * caps. Returns false (nothing reserved) when either cap would be crossed or
 * the refusal breaker has latched for the day.
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
      and breaker_tripped_at is null
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

/** Latches the breaker for the day; true only for the first trip. */
export async function tripAiMediaDescribeBreaker(
  db: Database,
  input: { day: string; reason: string; now: Date },
): Promise<boolean> {
  await db.execute(sql`
    insert into ai_media_describe_days (day, updated_at) values (${input.day}::date, ${input.now})
    on conflict (day) do nothing
  `);
  const tripped = await db.execute(sql`
    update ai_media_describe_days set breaker_tripped_at = ${input.now}, breaker_reason = ${input.reason},
      updated_at = ${input.now}
    where day = ${input.day}::date and breaker_tripped_at is null
    returning day
  `);
  return tripped.rows.length === 1;
}

/** Terminal provider outcomes since `since`, newest first, at most `limit`:
 * the refusal-share window of the breaker. */
export async function countRecentAiMediaDescribeOutcomes(
  db: Database,
  input: { since: Date; limit: number },
): Promise<{ total: number; refused: number }> {
  const result = await db.execute<{ total: string; refused: string }>(sql`
    select count(*)::text as total, count(*) filter (where status = 'refused')::text as refused
    from (
      select status from ai_media_descriptions
      where described_at >= ${input.since}
        and status in ('described', 'refused')
        and usage_event_id is not null
      order by described_at desc
      limit ${input.limit}
    ) recent
  `);
  const row = result.rows[0];
  return { total: Number(row?.total ?? 0), refused: Number(row?.refused ?? 0) };
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

// ── Fansly accelerator (0213) ────────────────────────────────────────────────

export async function requestAiMediaAcceleratorRead(
  db: Database,
  input: {
    pageId: number;
    groupRef: string;
    messageRef: string;
    now: Date;
    /** 'fast' when the hub's own WS frame routed it (0215). */
    lane?: "chunk" | "fast";
    frameReceivedAt?: Date | null;
    generation?: string | null;
  },
): Promise<boolean> {
  const inserted = await db.execute(sql`
    insert into ai_media_accelerator_reads (page_id, group_ref, message_ref, requested_at, lane, frame_received_at, generation)
    values (${input.pageId}, ${input.groupRef}, ${input.messageRef}, ${input.now},
      ${input.lane ?? "chunk"}, ${input.frameReceivedAt ?? null}, ${input.generation ?? null})
    on conflict (page_id, message_ref) do nothing
    returning id
  `);
  return inserted.rows.length === 1;
}

export interface AiMediaAcceleratorClaim {
  id: number;
  groupRef: string;
  messageRef: string;
}

/**
 * The oldest pending read for the page whose conversation was not read by the
 * accelerator within `perConversationGapMs`. Stale requests (the ordinary DM
 * sync has had time to catch up) are closed as skipped on the way.
 */
export async function claimAiMediaAcceleratorRead(
  db: Database,
  input: {
    pageId: number;
    now: Date;
    perConversationGapMs: number;
    staleAfterMs: number;
    /** Only requests at least this old (the chunk step leaves fresh ones to
     * the fast lane while it serves the page). */
    minAgeMs?: number;
  },
): Promise<AiMediaAcceleratorClaim | null> {
  await db.execute(sql`
    update ai_media_accelerator_reads set status = 'skipped', outcome = 'stale', finished_at = ${input.now}
    where page_id = ${input.pageId} and status = 'pending'
      and requested_at < ${new Date(input.now.getTime() - input.staleAfterMs)}
  `);
  const gapStart = new Date(input.now.getTime() - input.perConversationGapMs);
  const result = await db.execute<{ id: string; group_ref: string; message_ref: string }>(sql`
    select r.id::text as id, r.group_ref, r.message_ref from ai_media_accelerator_reads r
    where r.page_id = ${input.pageId} and r.status = 'pending'
      and r.requested_at <= ${new Date(input.now.getTime() - (input.minAgeMs ?? 0))}
      and not exists (
        select 1 from ai_media_accelerator_reads a
        where a.page_id = r.page_id and a.group_ref = r.group_ref
          and a.admitted_at is not null and a.admitted_at >= ${gapStart}
      )
    order by r.requested_at asc, r.id asc
    limit 1
    for update skip locked
  `);
  const row = result.rows[0];
  return row ? { id: Number(row.id), groupRef: row.group_ref, messageRef: row.message_ref } : null;
}

/**
 * Admits one physical attempt against the agency-wide rolling 24 h cap
 * (shared by the chunk step and the fast lane). Compare-and-set on the
 * pending status: two lanes that both picked the request cannot both send.
 * Returns true only when this caller admitted it; see
 * `admitAiMediaAcceleratorReadOutcome` for why not.
 */
export async function admitAiMediaAcceleratorRead(
  db: Database,
  input: { id: number; requestId: string; limit24h: number; now: Date },
): Promise<boolean> {
  return (await admitAiMediaAcceleratorReadOutcome(db, input)) === "admitted";
}

export async function admitAiMediaAcceleratorReadOutcome(
  db: Database,
  input: { id: number; requestId: string; limit24h: number; now: Date },
): Promise<"admitted" | "cap" | "taken"> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await database.execute(sql`select pg_advisory_xact_lock(815403, 1)`);
    const used = await database.execute<{ n: string }>(sql`
      select count(*)::text as n from ai_media_accelerator_reads
      where admitted_at is not null and admitted_at > ${new Date(input.now.getTime() - 24 * 60 * 60 * 1000)}
    `);
    if (Number(used.rows[0]?.n ?? 0) >= input.limit24h) {
      return "cap" as const;
    }
    const admitted = await database.execute(sql`
      update ai_media_accelerator_reads set status = 'admitted', admitted_at = ${input.now}, request_id = ${input.requestId}
      where id = ${input.id} and status = 'pending'
      returning id
    `);
    return admitted.rows.length === 1 ? "admitted" as const : "taken" as const;
  });
}

/** Reads admitted in the rolling 24 h (both lanes). */
export async function countAiMediaAcceleratorAdmissions24h(db: Database, now: Date): Promise<number> {
  const used = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from ai_media_accelerator_reads
    where admitted_at is not null and admitted_at > ${new Date(now.getTime() - 24 * 60 * 60 * 1000)}
  `);
  return Number(used.rows[0]?.n ?? 0);
}

/** Closes a read; a completed read also settles every other pending request
 * of the same conversation it covered — only the messages the response
 * really carried when `coveredMessageRefs` is given. */
export async function finishAiMediaAcceleratorRead(
  db: Database,
  input: {
    id: number;
    pageId: number;
    groupRef: string;
    status: "done" | "skipped" | "failed";
    outcome: string;
    now: Date;
    startedAt: Date;
    httpStatus?: number | null;
    coveredMessageRefs?: readonly string[];
  },
): Promise<void> {
  await db.execute(sql`
    update ai_media_accelerator_reads set status = ${input.status}, outcome = ${input.outcome}, finished_at = ${input.now},
      http_status = coalesce(${input.httpStatus ?? null}, http_status)
    where id = ${input.id}
  `);
  if (input.status === "done" && input.coveredMessageRefs) {
    if (input.coveredMessageRefs.length > 0) {
      const refs = sql.join(input.coveredMessageRefs.map((ref) => sql`${ref}`), sql`, `);
      await db.execute(sql`
        update ai_media_accelerator_reads set status = 'done', outcome = 'covered', finished_at = ${input.now}
        where page_id = ${input.pageId} and status = 'pending' and message_ref in (${refs})
      `);
    }
    return;
  }
  if (input.status === "done") {
    await db.execute(sql`
      update ai_media_accelerator_reads set status = 'done', outcome = 'covered', finished_at = ${input.now}
      where page_id = ${input.pageId} and group_ref = ${input.groupRef} and status = 'pending'
        and requested_at <= ${input.startedAt}
    `);
  }
}

// ── Fansly fast lane (0215) ──────────────────────────────────────────────────

/** The oldest pending read request of the page, any lane (the fast lane runs
 * right after the frame; stale requests are closed on the way). Not durable:
 * the admission's compare-and-set decides who sends. */
export async function peekAiMediaFastLaneRead(
  db: Database,
  input: { pageId: number; now: Date; staleAfterMs: number },
): Promise<(AiMediaAcceleratorClaim & { generation: string | null; frameReceivedAt: Date | null }) | null> {
  await db.execute(sql`
    update ai_media_accelerator_reads set status = 'skipped', outcome = 'stale', finished_at = ${input.now}
    where page_id = ${input.pageId} and status = 'pending' and lane = 'fast'
      and requested_at < ${new Date(input.now.getTime() - input.staleAfterMs)}
  `);
  const result = await db.execute<{ id: string; group_ref: string; message_ref: string; generation: string | null; frame_received_at: Date | string | null }>(sql`
    select id::text as id, group_ref, message_ref, generation, frame_received_at from ai_media_accelerator_reads
    where page_id = ${input.pageId} and status = 'pending' and lane = 'fast'
    order by requested_at asc, id asc
    limit 1
  `);
  const row = result.rows[0];
  return row
    ? {
      id: Number(row.id),
      groupRef: row.group_ref,
      messageRef: row.message_ref,
      generation: row.generation,
      frameReceivedAt: toDate(row.frame_received_at),
    }
    : null;
}

/** A request the fast lane declined stays pending for the ordinary in-chunk
 * accelerator (which reads under the page lease with its own checks). */
export async function handOffAiMediaFastLaneRead(db: Database, input: { id: number; reason: string }) {
  await db.execute(sql`
    update ai_media_accelerator_reads set lane = 'chunk', outcome = ${`handoff_${input.reason}`}
    where id = ${input.id} and status = 'pending' and lane = 'fast'
  `);
}

/** When the fast lane last dispatched a read of this conversation. */
export async function lastAiMediaFastLaneDispatch(
  db: Database,
  input: { pageId: number; groupRef: string },
): Promise<Date | null> {
  const result = await db.execute<{ at: Date | string | null }>(sql`
    select max(dispatched_at) as at from ai_media_accelerator_reads
    where page_id = ${input.pageId} and group_ref = ${input.groupRef} and lane = 'fast'
  `);
  return toDate(result.rows[0]?.at ?? null);
}

/**
 * The provider's recent answers to any Fansly request of these pages (sync
 * attempts): a 429 within `rateLimitMs`, a 5xx within `serverErrorMs`, a
 * 401/403 within `authMs`. The in-process retry of a 429 leaves no durable
 * cooldown yet — this is what the fast lane checks right before dispatch.
 */
export async function recentFanslyProviderRefusal(
  db: Database,
  input: { pageIds: readonly number[]; now: Date; rateLimitMs: number; serverErrorMs: number; authMs: number },
): Promise<"rate_limit" | "provider_5xx" | "auth" | null> {
  if (input.pageIds.length === 0) {
    return null;
  }
  const pageIds = sql.join(input.pageIds.map((id) => sql`${id}`), sql`, `);
  const since = new Date(input.now.getTime() - Math.max(input.rateLimitMs, input.serverErrorMs, input.authMs));
  const result = await db.execute<{ http_status: number; started_at: Date | string }>(sql`
    select http_status, started_at from sync_http_attempts
    where provider = 'fansly' and page_id in (${pageIds}) and started_at >= ${since}
      and (http_status = 429 or http_status >= 500 or http_status in (401, 403))
    order by started_at desc
    limit 20
  `);
  for (const row of result.rows) {
    const age = input.now.getTime() - (toDate(row.started_at)?.getTime() ?? 0);
    const status = Number(row.http_status);
    if (status === 429 && age <= input.rateLimitMs) return "rate_limit";
    if (status >= 500 && age <= input.serverErrorMs) return "provider_5xx";
    if ((status === 401 || status === 403) && age <= input.authMs) return "auth";
  }
  return null;
}

/** Whether any of these pages is in a lane cooldown (429/5xx/401/403 the lane itself met). */
export async function hasAiMediaFastLaneCooldown(
  db: Database,
  input: { pageIds: readonly number[]; now: Date },
): Promise<boolean> {
  if (input.pageIds.length === 0) {
    return false;
  }
  const pageIds = sql.join(input.pageIds.map((id) => sql`${id}`), sql`, `);
  const result = await db.execute<{ cooling: boolean }>(sql`
    select exists (
      select 1 from ai_media_fast_lane_health
      where page_id in (${pageIds}) and cooldown_until is not null and cooldown_until > ${input.now}
    ) as cooling
  `);
  return result.rows[0]?.cooling === true;
}

/** The physical HTTP start of an admitted read (after the pacing wait). */
export async function markAiMediaAcceleratorReadDispatched(db: Database, input: { id: number; now: Date }) {
  await db.execute(sql`update ai_media_accelerator_reads set dispatched_at = ${input.now} where id = ${input.id}`);
}

/** Whether a Fansly sync request of these pages started and has not finished
 * (the fast lane never starts a request while one is in flight on its egress). */
export async function hasUnfinishedFanslySyncAttempt(
  db: Database,
  input: { pageIds: readonly number[]; since: Date },
): Promise<boolean> {
  if (input.pageIds.length === 0) {
    return false;
  }
  const pageIds = sql.join(input.pageIds.map((id) => sql`${id}`), sql`, `);
  const result = await db.execute<{ busy: boolean }>(sql`
    select exists (
      select 1 from sync_http_attempts
      where provider = 'fansly' and state = 'started' and finished_at is null
        and started_at >= ${input.since} and page_id in (${pageIds})
    ) as busy
  `);
  return result.rows[0]?.busy === true;
}

/** Whether ordinary sync would hold off this page now: any stream cooling
 * down after a 429/5xx, the page under a provider hold (0219), or the DM
 * stream paused or blocked. */
export async function getFanslyFastLanePageSyncGate(
  db: Database,
  input: { pageId: number; now: Date; peerPageIds?: readonly number[] },
): Promise<{ cooldown: boolean; held: boolean }> {
  const cooling = [...new Set([input.pageId, ...(input.peerPageIds ?? [])])];
  const cooldownIds = sql.join(cooling.map((id) => sql`${id}`), sql`, `);
  const result = await db.execute<{ cooldown: boolean; held: boolean }>(sql`
    select
      exists (
        select 1 from page_sync_states
        where page_id in (${cooldownIds}) and retry_kind in ('rate_limit', 'provider_5xx')
          and retry_at is not null and retry_at > ${input.now}
      ) or exists (
        select 1 from page_sync_provider_holds
        where page_id in (${cooldownIds}) and hold_until > ${input.now}
      ) as cooldown,
      exists (
        select 1 from page_sync_states
        where page_id = ${input.pageId} and stream = 'dm_messages'
          and (status in ('paused', 'blocked') or blocker_kind is not null)
      ) as held
  `);
  const row = result.rows[0];
  return { cooldown: row?.cooldown === true, held: row?.held === true };
}

export interface AiMediaFastLaneHealthRow {
  pageId: number;
  unavailableSince: Date | null;
  reason: string | null;
  cooldownUntil: Date | null;
}

export async function listAiMediaFastLaneHealth(db: Database): Promise<AiMediaFastLaneHealthRow[]> {
  const result = await db.execute(sql`
    select page_id, unavailable_since, reason, cooldown_until from ai_media_fast_lane_health
  `);
  return result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      pageId: Number(row.page_id),
      unavailableSince: toDate(row.unavailable_since),
      reason: (row.reason as string | null) ?? null,
      cooldownUntil: toDate(row.cooldown_until),
    };
  });
}

/** Records whether the lane can work on the page; the first unavailable
 * moment is kept until it recovers (the > 10 min incident clock). */
export async function setAiMediaFastLaneHealth(
  db: Database,
  input: { pageId: number; available: boolean; reason: string | null; now: Date },
): Promise<void> {
  await db.execute(sql`
    insert into ai_media_fast_lane_health (page_id, unavailable_since, reason, updated_at)
    values (${input.pageId}, ${input.available ? null : input.now}, ${input.reason}, ${input.now})
    on conflict (page_id) do update set
      unavailable_since = case
        when ${input.available} then null
        else coalesce(ai_media_fast_lane_health.unavailable_since, excluded.unavailable_since)
      end,
      reason = excluded.reason,
      updated_at = excluded.updated_at
  `);
}

/** A provider answer (429/5xx/401/403) pauses the lane for the page; it
 * survives restarts. */
export async function setAiMediaFastLaneCooldown(
  db: Database,
  input: { pageId: number; until: Date; reason: string; now: Date },
): Promise<void> {
  await db.execute(sql`
    insert into ai_media_fast_lane_health (page_id, cooldown_until, reason, updated_at)
    values (${input.pageId}, ${input.until}, ${input.reason}, ${input.now})
    on conflict (page_id) do update set
      cooldown_until = greatest(coalesce(ai_media_fast_lane_health.cooldown_until, excluded.cooldown_until), excluded.cooldown_until),
      reason = excluded.reason,
      updated_at = excluded.updated_at
  `);
}
