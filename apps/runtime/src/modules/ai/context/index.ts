import { sql } from "drizzle-orm";

import {
  listAiTranscriptUnionMessages,
  listArchiveConversationMessagesForAi,
  type AiTranscriptUnionRow,
} from "@agency_hub_core/db";
import { millsToDollarsNumber } from "@agency_hub_core/shared";

import type { AppContext } from "../../../bootstrap.ts";
import {
  formatFanSpendingData,
  formatFanSubscriptionData,
  formatTranscript,
  normalizeTranscriptMessages,
  type FanSpendingData,
  type FanSubscriptionInput,
  type FanTransactionRow,
  type OfapiChatMessage,
  type SpendingSums,
  type TranscriptMessage,
} from "../prompts/index.ts";

// Kernel Stage 30 — context loaders. Pure over kernel data; their outputs
// are the exact strings the desktop's assembly produces today, built by the
// SAME migrated formatters. Where the kernel lacks a vendor field the gap
// is NAMED here (assumption 1: escalate, never approximate silently):
//  - PPV purchased-state: message_archive keeps price/tip but not
//    isOpened/isFree → PPV labels render the 'unknown' state until the
//    archive learns purchase state (parity harness will surface it).
//  - Spending `sums`: the desktop passes the vendor's own summary object;
//    the kernel derives the same sums from its transactions ledger.

type Db = Pick<AppContext, "db">;

/** Rebuild the OFAPI chat-message shape the migrated normalizer consumes —
 * archive rows were projected from those same vendor payloads. */
function archiveRowToOfapiShape(row: {
  messageRef: string;
  textPlain: string;
  isSentByMe: boolean;
  occurredAt: Date | null;
  priceMills: bigint | number | string | null;
  isTip: boolean;
  tipAmountMills: bigint | number | string;
  /** Not surfaced by the archive read today — labels degrade gracefully. */
  mediaMetadata?: Array<Record<string, unknown>> | null;
  /** PPV purchase state — the union read supplies it (dm arm + hot-table
   * purchased_at upgrade); the archive read leaves it null → 'unknown'. */
  isOpened?: boolean | null;
}): OfapiChatMessage | null {
  const id = Number(row.messageRef);
  if (!Number.isFinite(id) || row.occurredAt === null) {
    return null;
  }
  const priceDollars = row.priceMills === null ? null : millsToDollarsNumber(row.priceMills);
  const tipDollars = millsToDollarsNumber(row.tipAmountMills);
  const media = row.mediaMetadata ?? [];
  return {
    id,
    text: row.textPlain,
    isSentByMe: row.isSentByMe,
    createdAt: row.occurredAt.toISOString(),
    price: priceDollars,
    isOpened: row.isOpened ?? null,
    isTip: row.isTip,
    tipAmount: row.isTip && tipDollars > 0 ? tipDollars : null,
    mediaCount: media.length,
    media: media.map((media) => ({
      id: (media.id as string | number | null) ?? null,
      type: (media.type as string | null) ?? null,
      canView: (media.canView as boolean | null) ?? null,
    })),
  } as OfapiChatMessage;
}

/** PR3: the effective union-read mode for one generation. "unknown" = the
 * mode read failed or the stored value was invalid — NOT a silent archive
 * fallback: it is recorded in the manifest as unknown-freshness. */
export type AiTranscriptUnionMode = "off" | "shadow" | "serve" | "unknown";

export const TRANSCRIPT_LOADER_VERSION = "transcript-union-v1";

export interface TranscriptContext {
  transcript: string;
  messages: TranscriptMessage[];
  /** PR3: per-generation context manifest — counts/heads/timings only, no
   * message text. Lands as the ADDITIVE params.contextManifest key on the
   * restricted generation record. */
  contextManifest: Record<string, unknown>;
}

export async function loadTranscriptContext(
  app: Db,
  input: {
    pageId: number;
    conversationRef: string;
    limit?: number;
    unionMode?: AiTranscriptUnionMode;
  },
): Promise<TranscriptContext> {
  const limit = input.limit ?? 100;
  const mode = input.unionMode ?? "off";

  // The AI reader filters tombstones + content-pending stubs in the repo
  // layer and accepts the deeper 1500 cap (fastreply-freshness PR2). It is
  // read in EVERY mode: it serves off/shadow/unknown, it is the serve-mode
  // fallback, and it anchors the manifest comparison.
  const archiveRows = await listArchiveConversationMessagesForAi(app.db, {
    accountId: input.pageId,
    conversationRef: input.conversationRef,
    limit,
  });

  // shadow EXECUTES the union query too (that is the point of shadow — and
  // why `off` is the PERF rollback while `shadow` is the correctness one).
  let unionRows: AiTranscriptUnionRow[] | null = null;
  let unionError = false;
  let queryDurationMs: number | null = null;
  if (mode === "shadow" || mode === "serve") {
    const startedAt = performance.now();
    try {
      unionRows = await listAiTranscriptUnionMessages(app.db, {
        pageId: input.pageId,
        conversationRef: input.conversationRef,
        limit,
      });
    } catch {
      // Union failure is NEVER a hard failure: archive serves, and the
      // manifest carries the stale-context bit.
      unionError = true;
    }
    queryDurationMs = Math.round(performance.now() - startedAt);
  }

  const serveUnion = mode === "serve" && unionRows !== null;
  const servedRows = serveUnion ? unionRows! : archiveRows;
  const shaped = servedRows
    .map((row) => archiveRowToOfapiShape(row as never))
    .filter((row): row is OfapiChatMessage => row !== null);
  const messages = normalizeTranscriptMessages(shaped).slice(-limit);

  // Both readers return newest-first, so index 0 is the head.
  const archiveHead = archiveRows[0] ?? null;
  const unionHead = unionRows?.[0] ?? null;
  const archiveRefs = new Set(archiveRows.map((row) => row.messageRef));
  const unionRefs = unionRows === null ? null : new Set(unionRows.map((row) => row.messageRef));
  const contextManifest: Record<string, unknown> = {
    loaderVersion: TRANSCRIPT_LOADER_VERSION,
    mode,
    source: serveUnion ? "union" : "archive",
    archiveCount: archiveRows.length,
    unionCount: unionRows === null ? null : unionRows.length,
    archiveHeadRef: archiveHead?.messageRef ?? null,
    archiveHeadAt: archiveHead?.occurredAt?.toISOString() ?? null,
    unionHeadRef: unionHead?.messageRef ?? null,
    unionHeadAt: unionHead?.occurredAt?.toISOString() ?? null,
    headsEqual: unionRows === null
      ? null
      : (archiveHead?.messageRef ?? null) === (unionHead?.messageRef ?? null),
    additions: unionRows === null
      ? null
      : unionRows.filter((row) => !archiveRefs.has(row.messageRef)).length,
    tombstones: unionRefs === null
      ? null
      : archiveRows.filter((row) => !unionRefs.has(row.messageRef)).length,
    // Signed: positive = the union head is newer than the archive head.
    gapMs: archiveHead?.occurredAt != null && unionHead?.occurredAt != null
      ? unionHead.occurredAt.getTime() - archiveHead.occurredAt.getTime()
      : null,
    queryDurationMs,
    unionError,
    staleContext: mode === "serve" && unionError,
  };

  return { transcript: formatTranscript(messages), messages, contextManifest };
}

const SPENDING_TYPE_BY_CANONICAL: Record<string, string> = {
  subscription: "subscribe",
  tip: "tip",
  message_purchase: "message",
  post_purchase: "post",
  stream: "stream",
};

export async function loadSpendingContext(
  app: Db,
  input: { pageId: number; fanRef: string },
): Promise<{ block: string; data: FanSpendingData }> {
  const result = await app.db.execute<{
    canonical_type: string;
    gross: string;
    occurred_at: Date;
  }>(sql`
    select t.canonical_type, t.gross_amount_mills::text as gross, t.occurred_at
    from transactions t
    join fans f on f.id = t.fan_id
    where t.platform_account_id = ${input.pageId}
      and f.platform_user_id = ${input.fanRef}
      and t.is_active = true
    order by t.occurred_at desc
    limit 500
  `);
  const rows: FanTransactionRow[] = result.rows.map((row) => ({
    type: SPENDING_TYPE_BY_CANONICAL[row.canonical_type] ?? row.canonical_type,
    amount: millsToDollarsNumber(row.gross),
    date: new Date(row.occurred_at).toISOString(),
  }));

  const sums: SpendingSums = { totalSumm: 0, subscribesSumm: 0, tipsSumm: 0, messagesSumm: 0, postsSumm: 0, streamsSumm: 0 };
  for (const row of rows) {
    sums.totalSumm = (sums.totalSumm ?? 0) + row.amount;
    if (row.type === "subscribe") sums.subscribesSumm = (sums.subscribesSumm ?? 0) + row.amount;
    else if (row.type === "tip") sums.tipsSumm = (sums.tipsSumm ?? 0) + row.amount;
    else if (row.type === "message") sums.messagesSumm = (sums.messagesSumm ?? 0) + row.amount;
    else if (row.type === "post") sums.postsSumm = (sums.postsSumm ?? 0) + row.amount;
    else if (row.type === "stream") sums.streamsSumm = (sums.streamsSumm ?? 0) + row.amount;
  }

  const data: FanSpendingData = {
    fanId: input.fanRef,
    sums: rows.length > 0 ? sums : null,
  };
  return { block: formatFanSpendingData(data), data };
}

export async function loadSubscriptionContext(
  app: Db,
  input: { pageId: number; fanRef: string },
): Promise<{ block: string; data: FanSubscriptionInput }> {
  const result = await app.db.execute<{
    is_subscriber: boolean;
    subscriber_since: Date | null;
    subscription_expires_at: Date | null;
    auto_renew: boolean | null;
    auto_renew_off_detected_at: Date | null;
  }>(sql`
    select pf.is_subscriber, pf.subscriber_since, pf.subscription_expires_at,
           pf.auto_renew, pf.auto_renew_off_detected_at
    from page_fans pf
    join fans f on f.id = pf.fan_id
    where pf.platform_account_id = ${input.pageId}
      and f.platform_user_id = ${input.fanRef}
  `);
  const row = result.rows[0];
  const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);
  const data: FanSubscriptionInput = row
    ? {
      subscribedOn: row.is_subscriber,
      subscribedOnExpiredNow: !row.is_subscriber && row.subscription_expires_at !== null,
      subscribedOnData: {
        subscribeAt: iso(row.subscriber_since),
        expiredAt: iso(row.subscription_expires_at),
        subscribes: [{
          isCurrent: row.is_subscriber,
          startDate: iso(row.subscriber_since),
          expireDate: iso(row.subscription_expires_at),
          cancelDate: row.auto_renew === false ? iso(row.auto_renew_off_detected_at) : null,
        }],
      },
    }
    : { subscribedOn: null, subscribedOnData: null };
  return { block: formatFanSubscriptionData(data), data };
}

export async function loadFanDisplayName(
  app: Db,
  input: { pageId: number; fanRef: string; platform: "fansly" | "onlyfans" },
): Promise<string> {
  // fans are unique on (platform, platform_user_id) — the native id alone can
  // collide across platforms, and a LIMIT 1 without the platform filter could
  // serve the other platform's fan into the prompt (review R3-2). The LEFT
  // join is deliberate: a fan not yet linked to the page keeps their name.
  const result = await app.db.execute<{ name: string | null }>(sql`
    select coalesce(pf.page_alias, f.display_name, f.username) as name
    from fans f
    left join page_fans pf on pf.fan_id = f.id and pf.platform_account_id = ${input.pageId}
    where f.platform_user_id = ${input.fanRef} and f.platform = ${input.platform}
    limit 1
  `);
  return result.rows[0]?.name ?? input.fanRef;
}

/** hi-greeting only. The desktop reads the fan's profile "about"; the
 * kernel's nearest source is the audience-synced fans.metadata — a NAMED
 * parity checkpoint (Task 5) if the field proves absent in practice. */
export async function loadFanBio(
  app: Db,
  input: { fanRef: string; platform: "fansly" | "onlyfans" },
): Promise<string | undefined> {
  const result = await app.db.execute<{ metadata: Record<string, unknown> | null }>(sql`
    select metadata from fans
    where platform_user_id = ${input.fanRef} and platform = ${input.platform}
    limit 1
  `);
  const metadata = result.rows[0]?.metadata;
  const bio = metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>).about ?? (metadata as Record<string, unknown>).bio
    : undefined;
  return typeof bio === "string" && bio.trim().length > 0 ? bio : undefined;
}
