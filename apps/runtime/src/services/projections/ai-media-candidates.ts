import { sql } from "drizzle-orm";

import {
  getProjectionWatermark,
  hasRecentAiGenerationInConversation,
  listEventAccounts,
  listEventsSince,
  setProjectionWatermark,
  upsertAiMediaDescriptionCandidate,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import {
  aiMediaNotesPolicyForPage,
  isAfterAiMediaDescribeBoundary,
  type AiMediaDescribePagePolicy,
} from "../ai-media-describe/policy.ts";
import { loadEffectiveConfig } from "../effective-config.ts";

// AI media describer — Fansly candidates (plan §4). Consumes the canonical
// `message.attachments_observed` events (the same events the media plane
// projects; this projector writes only its own tables).
//
// Only pages with a describer policy are processed, and only messages
// strictly after the policy's `since`. Every other account's watermark is
// fast-forwarded to its head without reading events, so enabling a page never
// starts a historical pass and a new deploy never scans the ledger.
//
// Fan-sent media only: a PPV teaser or free creator media becomes a candidate
// when a generation shows it (Fansly teaser links live ~7 days). Operational
// state: descriptions are paid results — never truncated by a rebuild.

export const AI_MEDIA_CANDIDATES_PROJECTION = "ai_media_candidates";

const EVENT_PAGE_SIZE = 500;
const LIVE_CHAT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ATTACHMENTS_EVENT = "message.attachments_observed";

type ProjectorApp = Pick<AppContext, "db" | "logger"> & Partial<Pick<AppContext, "config">>;

function asText(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// Same classes as the extension's labels: any image (a GIF included) is a
// photo, so candidate and prompt keys agree.
function mediaKindFromMime(mime: string | null): "photo" | "video" | null {
  if (mime === null) {
    return null;
  }
  if (mime.startsWith("image/")) {
    return "photo";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  return null;
}

async function headSeq(app: ProjectorApp, accountId: number): Promise<number> {
  const result = await app.db.execute<{ seq: string | null }>(sql`
    select max(account_seq)::text as seq from domain_events where account_id = ${accountId}
  `);
  return Number(result.rows[0]?.seq ?? 0);
}

export interface AiMediaAttachmentsEvent {
  data: unknown;
  observationId: number;
  occurredAt: Date;
  messageRef: string | null;
  conversationRef: string | null;
}

/**
 * One canonical `message.attachments_observed` event → fan media candidates
 * (idempotent upsert); a replay of the same event has no effect. 'deferred'
 * means a running erasure holds the fence: stop and try again later.
 */
async function applyAiMediaAttachmentsEvent(
  app: ProjectorApp,
  input: {
    pageId: number;
    ownRef: string;
    policy: AiMediaDescribePagePolicy;
    liveChatOnly: boolean;
    event: AiMediaAttachmentsEvent;
  },
): Promise<{ status: "applied" | "deferred"; candidates: number; pendingIds: number[] }> {
  const data = asRecord(input.event.data) ?? {};
  const result = { status: "applied" as "applied" | "deferred", candidates: 0, pendingIds: [] as number[] };
  const messageRef = asText(data.messageId) ?? input.event.messageRef;
  const groupRef = asText(data.conversationRef) ?? input.event.conversationRef;
  const senderRef = asText(data.senderRef);
  const createdAtRaw = asText(data.messageCreatedAt);
  const messageAt = createdAtRaw ? new Date(createdAtRaw) : null;
  if (
    !messageRef || !groupRef || !senderRef || senderRef === input.ownRef
    || !isAfterAiMediaDescribeBoundary(input.policy, messageAt)
  ) {
    return result;
  }
  const attachments = Array.isArray(data.attachments) ? data.attachments.map(asRecord).filter((row) => row !== null) : [];
  if (attachments.length === 0) return result;
  const live = !input.liveChatOnly || await hasRecentAiGenerationInConversation(app.db, {
    pageId: input.pageId,
    conversationRefs: [groupRef, senderRef],
    since: new Date(Date.now() - LIVE_CHAT_WINDOW_MS),
  });
  for (const attachment of attachments) {
    const contentType = Number(attachment.contentType);
    const bundleRef = asText(attachment.bundleRef);
    const mediaRef = contentType === 2 ? bundleRef ?? asText(attachment.contentRef)
      : contentType === 1 ? asText(attachment.mediaOfferRef) ?? asText(attachment.contentRef) : null;
    if (!mediaRef) continue;
    const kind = contentType === 2 ? "bundle" : mediaKindFromMime(asText(attachment.mimeType));
    if (!kind) continue;
    const upserted = await upsertAiMediaDescriptionCandidate(app.db, {
      pageId: input.pageId,
      platform: "fansly",
      mediaRef,
      variant: kind === "photo" || kind === "bundle" ? "full" : "poster",
      mediaKind: kind,
      senderRole: "fan",
      fanPlatformUserId: senderRef,
      status: live ? "pending" : "dormant",
      sourceObservationId: input.event.observationId,
      link: {
        messageRef,
        conversationRef: groupRef,
        fanPlatformUserId: senderRef,
        senderRole: "fan",
        messageAt,
      },
      observedAt: input.event.occurredAt,
    });
    if (upserted.status === "deferred") {
      return { ...result, status: "deferred" };
    }
    if (upserted.status === "applied") {
      result.candidates += 1;
      if (upserted.descriptionStatus === "pending") result.pendingIds.push(upserted.descriptionId);
    }
  }
  return result;
}

export interface AiMediaCandidatesResult extends Record<string, unknown> {
  accounts: number;
  eventsSeen: number;
  candidates: number;
  fastForwarded: number;
}

export async function runAiMediaCandidatesProjection(
  app: ProjectorApp,
  input?: { accountId?: number | null },
): Promise<AiMediaCandidatesResult> {
  const totals: AiMediaCandidatesResult = { accounts: 0, eventsSeen: 0, candidates: 0, fastForwarded: 0 };
  if (!app.config) {
    // Diagnostic callers without config neither project nor move watermarks.
    return totals;
  }
  const effective = await loadEffectiveConfig(app.db, app.config);
  const accounts = input?.accountId != null ? [input.accountId] : await listEventAccounts(app.db);
  for (const accountId of accounts) {
    const page = (await app.db.execute<{ label: string; own_ref: string | null }>(sql`
      select label, external_page_id as own_ref from pages
      where id = ${accountId} and platform = 'fansly' and deleted_at is null
    `)).rows[0];
    if (!page) continue;
    totals.accounts += 1;
    const policy = aiMediaNotesPolicyForPage(effective, page.label);
    let watermark = await getProjectionWatermark(app.db, AI_MEDIA_CANDIDATES_PROJECTION, accountId);
    if (!policy || !page.own_ref) {
      const head = await headSeq(app, accountId);
      if (head > watermark) {
        await setProjectionWatermark(app.db, AI_MEDIA_CANDIDATES_PROJECTION, accountId, head);
        totals.fastForwarded += 1;
      }
      continue;
    }
    const liveChatOnly = effective.aiMediaDescribeLiveChatOnly !== false;
    for (;;) {
      const events = await listEventsSince(app.db, { accountId, afterSeq: watermark, limit: EVENT_PAGE_SIZE });
      if (events.length === 0) break;
      totals.eventsSeen += events.length;
      for (const event of events) {
        if (event.type !== ATTACHMENTS_EVENT || !event.observationId) continue;
        const applied = await applyAiMediaAttachmentsEvent(app, {
          pageId: accountId,
          ownRef: page.own_ref,
          policy,
          liveChatOnly,
          event: {
            data: event.data,
            observationId: event.observationId,
            occurredAt: event.occurredAt,
            messageRef: event.messageRef,
            conversationRef: event.conversationRef,
          },
        });
        if (applied.status === "deferred") {
          // A running erasure holds the fence: stop before this event and
          // resume from it on the next tick.
          return totals;
        }
        totals.candidates += applied.candidates;
      }
      watermark = events[events.length - 1]!.accountSeq;
      await setProjectionWatermark(app.db, AI_MEDIA_CANDIDATES_PROJECTION, accountId, watermark);
      if (events.length < EVENT_PAGE_SIZE) break;
    }
  }
  return totals;
}
