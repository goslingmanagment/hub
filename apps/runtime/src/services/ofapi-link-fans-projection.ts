// OnlyFans link ↔ fan (plan 2026-10-08, PR 8): the projection of the paid fan
// sweep's journal into page_link_fan_walks / page_link_fans /
// page_link_fan_periods (migration 0260).
//
// The journal is the only input. The sweep journals every page it buys
// (ofapi-fan-identities.ts) and then calls `projectLinkFanJournal`, which
// applies the page's journal rows after the page's cursor — normally just the
// page it bought — each in its own transaction that also moves the cursor. So
// the projection is always a prefix of the journal in journal order: a page
// whose projection failed, or every page journaled while an older image ran,
// is applied by the next call, and the rebuild command (link-fans:reproject)
// replays the same rows through the same functions from the start.
//
// The period rule, ofapi_subscription_period_equal_split.v1, is documented on
// LINK_ATTRIBUTION_RULE (packages/shared/src/link-fans.ts) and in 0260.

import {
  advanceLinkFanJournalCursor,
  applyLinkFansPage,
  type Database,
  type LinkFanJournalRow,
  type LinkFansPageInput,
  type LinkFansPageNext,
  type LinkFanSpenderItem,
  type LinkFanSubscriberItem,
  listLinkFanJournalRowsAfter,
  lockLinkFanJournalCursor,
  readLinkFanJournalCursor,
  tryLockLinkFanProjection,
} from "@agency_hub_core/db";
import {
  dollarsToMills,
  LINK_ATTRIBUTION_RULE,
  linkFanJournalEndpointShape,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { idToString } from "./ofapi-payloads.ts";
import { isCapturePayloadUnavailable, resolveCapturePayloadRow } from "./payload-reader.ts";

type ProjectionContext = Pick<AppContext, "db" | "logger">;

export type ParsedLinkFansPage = Omit<LinkFansPageInput, "pageId" | "rawPayloadId" | "capturedAt">;

export type LinkFansPageParse =
  | { ok: true; page: ParsedLinkFansPage }
  | { ok: false; reason: string };

const LINK_ID_PATTERN = /^[0-9]{1,20}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseInstant(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseDollarMills(value: unknown): bigint | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const normalized = typeof value === "string" ? value.trim().replace(/^\$/, "").replace(/,/g, "") : value;
  try {
    return dollarsToMills(normalized);
  } catch {
    return null;
  }
}

/** The page after this one, as the walk itself decides it
 *  (resolveOfapiListNextOffset): a next-page link names its offset, else
 *  `hasNextPage` means offset + limit, else this is the last page. Only the
 *  offset is read from the link — the walk validated the rest when it
 *  followed it, and a link it refused leaves the walk unfinished anyway. */
function parseNext(body: Record<string, unknown>, offset: number, limit: number): LinkFansPageNext {
  const url = body.nextPageUrl;
  if (typeof url === "string" && url.length > 0) {
    let next: URL;
    try {
      next = new URL(url, "https://journal.invalid/");
    } catch {
      return { kind: "invalid" };
    }
    const offsets = next.searchParams.getAll("offset");
    if (offsets.length !== 1 || !/^\d+$/.test(offsets[0]!)) return { kind: "invalid" };
    const value = Number(offsets[0]);
    return Number.isSafeInteger(value) ? { kind: "offset", offset: value } : { kind: "invalid" };
  }
  return body.hasNextPage === true ? { kind: "offset", offset: offset + limit } : { kind: "last" };
}

function parseSubscriber(item: unknown): LinkFanSubscriberItem | null {
  if (!isRecord(item)) return null;
  const platformUserId = idToString(item.id);
  if (!platformUserId) return null;
  const flag = item.subscribedOnExpiredNow;
  const relation = isRecord(item.subscribedOnData) ? item.subscribedOnData : null;
  return {
    platformUserId,
    // Only an explicit "not expired" is active. A missing flag comes with no
    // subscription at all (subscribedOn null on the free page's lists).
    active: flag === false,
    vendorStatus: flag === false ? "active" : flag === true ? "expired" : null,
    vendorSubscribedAt: parseInstant(relation?.subscribeAt),
    vendorExpiresAt: parseInstant(relation?.expiredAt),
  };
}

function parseSpender(item: unknown): LinkFanSpenderItem | null {
  if (!isRecord(item)) return null;
  const platformUserId = idToString(item.onlyfans_id);
  if (!platformUserId) return null;
  const revenue = isRecord(item.revenue) ? item.revenue : null;
  return {
    platformUserId,
    revenueNetMills: parseDollarMills(revenue?.total),
    chargebacksMills: parseDollarMills(revenue?.chargebacks),
    calculatedAt: parseInstant(revenue?.calculated_at),
  };
}

/** One journaled page of the sweep (the body ofapi-fan-identities.ts writes:
 *  `{ link: {kind, id}, list, offset, limit, requestSeq, ofapiAccountId,
 *  items, hasNextPage, nextPageUrl }`). A body that does not hold together is
 *  refused with a reason; the projector skips it and says so. */
export function parseLinkFansJournalPage(endpoint: string, body: unknown): LinkFansPageParse {
  const shape = linkFanJournalEndpointShape(endpoint);
  if (!shape) return { ok: false, reason: `not a link-fans journal kind: ${endpoint}` };
  if (!isRecord(body)) return { ok: false, reason: "body is not an object" };
  const link = isRecord(body.link) ? body.link : null;
  const linkId = idToString(link?.id);
  if (!link || link.kind !== shape.linkKind || !linkId || !LINK_ID_PATTERN.test(linkId)) {
    return { ok: false, reason: "link does not match the journal kind" };
  }
  if (body.list !== shape.listKind) return { ok: false, reason: "list does not match the journal kind" };
  const offset = nonNegativeInteger(body.offset);
  const limit = nonNegativeInteger(body.limit);
  const requestSeq = nonNegativeInteger(body.requestSeq);
  if (offset === null || limit === null || limit === 0 || requestSeq === null) {
    return { ok: false, reason: "offset, limit or requestSeq missing" };
  }
  if (!Array.isArray(body.items)) return { ok: false, reason: "items is not a list" };
  const ofapiAccountId = typeof body.ofapiAccountId === "string" && body.ofapiAccountId.length > 0
    ? body.ofapiAccountId
    : null;
  const subscribers = shape.listKind === "subscribers"
    ? body.items.map(parseSubscriber).filter((item): item is LinkFanSubscriberItem => item !== null)
    : [];
  const spenders = shape.listKind === "spenders"
    ? body.items.map(parseSpender).filter((item): item is LinkFanSpenderItem => item !== null)
    : [];
  return {
    ok: true,
    page: {
      linkKind: shape.linkKind,
      linkId,
      listKind: shape.listKind,
      requestSeq,
      ofapiAccountId,
      offset,
      itemCount: body.items.length,
      next: parseNext(body, offset, limit),
      subscribers,
      spenders,
    },
  };
}

/** A journal row's body through the payload seam; a pointer-only row whose
 *  single copy is gone reads as unavailable (the row is skipped, not stuck). */
export async function readLinkFanJournalBody(
  ctx: ProjectionContext,
  db: Database,
  row: LinkFanJournalRow,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  try {
    const resolved = await resolveCapturePayloadRow({ db, logger: ctx.logger }, "raw_payload", row.id, row);
    return { ok: true, body: resolved.payload };
  } catch (error) {
    if (isCapturePayloadUnavailable(error)) return { ok: false, reason: "journal body unavailable" };
    throw error;
  }
}

/** Apply one journal row (or skip it as unreadable) and move the cursor past
 *  it. Call in a transaction holding the page's projection lock, with the
 *  cursor right before the row. */
export async function applyLinkFanJournalRow(
  ctx: ProjectionContext,
  tx: Database,
  pageId: number,
  row: LinkFanJournalRow,
  body: { ok: true; body: unknown } | { ok: false; reason: string },
): Promise<boolean> {
  const parsed = body.ok ? parseLinkFansJournalPage(row.endpoint, body.body) : body;
  if (parsed.ok) {
    await applyLinkFansPage(tx, { ...parsed.page, pageId, rawPayloadId: row.id, capturedAt: row.capturedAt });
  } else {
    ctx.logger.warn({ pageId, rawPayloadId: row.id, endpoint: row.endpoint, reason: parsed.reason },
      "link-fans projection skipped an unreadable journal page");
  }
  await advanceLinkFanJournalCursor(tx, { pageId, rawPayloadId: row.id, applied: parsed.ok });
  return parsed.ok;
}

export interface LinkFanProjectionStats {
  applied: number;
  skipped: number;
  /** Journal rows were left for a later call (the page cap, or the lock was
   *  held by a rebuild). */
  pending: boolean;
  /** The page's projection was built under another rule; nothing applied
   *  until link-fans:reproject rebuilds it. */
  ruleMismatch: boolean;
}

/**
 * Apply the page's journal rows after its cursor, oldest first, up to
 * `maxPages`, each in its own transaction. Never waits for the lock: while a
 * rebuild holds it the call returns at once and the rows wait for the next
 * call.
 */
export async function projectLinkFanJournal(
  ctx: ProjectionContext,
  input: { pageId: number; maxPages: number },
): Promise<LinkFanProjectionStats> {
  const stats: LinkFanProjectionStats = { applied: 0, skipped: 0, pending: false, ruleMismatch: false };
  for (let step = 0; step < input.maxPages; step += 1) {
    const cursor = await readLinkFanJournalCursor(ctx.db, input.pageId);
    if (cursor !== null && cursor.rule !== LINK_ATTRIBUTION_RULE) {
      stats.ruleMismatch = true;
      return stats;
    }
    const afterId = cursor?.lastRawPayloadId ?? 0;
    const [row] = await listLinkFanJournalRowsAfter(ctx.db, { pageId: input.pageId, afterId, limit: 1 });
    if (!row) return stats;
    const body = await readLinkFanJournalBody(ctx, ctx.db, row);
    const outcome = await ctx.db.transaction(async (tx) => {
      if (!(await tryLockLinkFanProjection(tx, input.pageId))) return "busy" as const;
      const locked = await lockLinkFanJournalCursor(tx, input.pageId, LINK_ATTRIBUTION_RULE);
      if (locked.rule !== LINK_ATTRIBUTION_RULE) return "rule" as const;
      // Another writer moved the cursor since it was read: read it again.
      if (locked.lastRawPayloadId !== afterId) return "moved" as const;
      return (await applyLinkFanJournalRow(ctx, tx, input.pageId, row, body)) ? "applied" as const : "skipped" as const;
    });
    if (outcome === "busy") {
      stats.pending = true;
      return stats;
    }
    if (outcome === "rule") {
      stats.ruleMismatch = true;
      return stats;
    }
    if (outcome === "applied") stats.applied += 1;
    if (outcome === "skipped") stats.skipped += 1;
  }
  const cursor = await readLinkFanJournalCursor(ctx.db, input.pageId);
  const rest = await listLinkFanJournalRowsAfter(ctx.db, {
    pageId: input.pageId, afterId: cursor?.lastRawPayloadId ?? 0, limit: 1,
  });
  stats.pending = rest.length > 0;
  return stats;
}
