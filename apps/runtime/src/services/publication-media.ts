import type { PublicationPageMediaWire } from "@agency_hub_core/contracts";
import {
  getPagePublishingSettings,
  listPublicationPageMedia,
  type Database,
  type PublicationPageMediaRecord,
  type PublicationPageMediaType,
} from "@agency_hub_core/db";
import type { PublicationStatus } from "@agency_hub_core/shared";

// The media a page can publish, for the agents who draft (wall posts, plan PR
// 10, spec §7, §9): which files there are, when each last went out on the page
// and which live publication already uses it. Read only.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One file on the wire. `repostWithinThreshold` is the repeat check's own
 * test (evaluatePublicationFindings: the last post or the nearest live
 * publication closer to the publish time than the page's threshold), so an
 * agent can skip the files a draft would be blocked for.
 */
export function toPublicationPageMediaWire(
  record: PublicationPageMediaRecord,
  input: { publishAt: Date; repostThresholdDays: number },
): PublicationPageMediaWire {
  const thresholdMs = input.repostThresholdDays * DAY_MS;
  const close = (at: Date | null) => at !== null && Math.abs(input.publishAt.getTime() - at.getTime()) < thresholdMs;
  return {
    mediaRef: record.mediaRef,
    type: record.type,
    mimeType: record.mimeType,
    width: record.width,
    height: record.height,
    durationMs: record.durationMs,
    byteSize: record.byteSize,
    filename: record.filename,
    createdAt: record.createdAt?.toISOString() ?? null,
    lastPost: record.lastPostedAt !== null && record.lastPostRef !== null
      ? { at: record.lastPostedAt.toISOString(), postRef: record.lastPostRef }
      : null,
    nearestPublication: record.nearestPublicationId !== null && record.nearestPublicationAt !== null
      ? {
        id: record.nearestPublicationId,
        publishAt: record.nearestPublicationAt.toISOString(),
        status: record.nearestPublicationStatus as PublicationStatus,
      }
      : null,
    repostWithinThreshold: close(record.lastPostedAt) || close(record.nearestPublicationAt),
  };
}

/** One page of the page's media, newest first, and the page's repeat threshold. */
export async function listPublicationPageMediaWire(db: Database, input: {
  page: { id: number; platform: string };
  publishAt: Date;
  type: PublicationPageMediaType | null;
  afterMediaRef: string | null;
  limit: number;
}): Promise<{ repostThresholdDays: number; media: PublicationPageMediaWire[] }> {
  const settings = await getPagePublishingSettings(db, input.page.id);
  const records = await listPublicationPageMedia(db, {
    pageId: input.page.id,
    platform: input.page.platform,
    at: input.publishAt,
    type: input.type,
    afterMediaRef: input.afterMediaRef,
    limit: input.limit,
  });
  const wire = { publishAt: input.publishAt, repostThresholdDays: settings.repostThresholdDays };
  return {
    repostThresholdDays: settings.repostThresholdDays,
    media: records.map((record) => toPublicationPageMediaWire(record, wire)),
  };
}
