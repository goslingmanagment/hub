import { sql } from "drizzle-orm";

import { listArchiveConversationMessages } from "@agency_hub_core/db";

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
}): OfapiChatMessage | null {
  const id = Number(row.messageRef);
  if (!Number.isFinite(id) || row.occurredAt === null) {
    return null;
  }
  const priceDollars = row.priceMills === null ? null : Number(row.priceMills) / 1000;
  const tipDollars = Number(row.tipAmountMills) / 1000;
  const media = row.mediaMetadata ?? [];
  return {
    id,
    text: row.textPlain,
    isSentByMe: row.isSentByMe,
    createdAt: row.occurredAt.toISOString(),
    price: priceDollars,
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

export interface TranscriptContext {
  transcript: string;
  messages: TranscriptMessage[];
}

export async function loadTranscriptContext(
  app: Db,
  input: { pageId: number; conversationRef: string; limit?: number },
): Promise<TranscriptContext> {
  const limit = input.limit ?? 100;
  const rows = await listArchiveConversationMessages(app.db, {
    accountIds: [input.pageId],
    conversationRef: input.conversationRef,
    limit,
  });
  const shaped = rows
    .map((row) => archiveRowToOfapiShape(row as never))
    .filter((row): row is OfapiChatMessage => row !== null);
  const messages = normalizeTranscriptMessages(shaped).slice(-limit);
  return { transcript: formatTranscript(messages), messages };
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
    amount: Number(row.gross) / 1000,
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
  input: { pageId: number; fanRef: string },
): Promise<string> {
  const result = await app.db.execute<{ name: string | null }>(sql`
    select coalesce(pf.page_alias, f.display_name, f.username) as name
    from fans f
    left join page_fans pf on pf.fan_id = f.id and pf.platform_account_id = ${input.pageId}
    where f.platform_user_id = ${input.fanRef}
    limit 1
  `);
  return result.rows[0]?.name ?? input.fanRef;
}

/** hi-greeting only. The desktop reads the fan's profile "about"; the
 * kernel's nearest source is the audience-synced fans.metadata — a NAMED
 * parity checkpoint (Task 5) if the field proves absent in practice. */
export async function loadFanBio(
  app: Db,
  input: { fanRef: string },
): Promise<string | undefined> {
  const result = await app.db.execute<{ metadata: Record<string, unknown> | null }>(sql`
    select metadata from fans where platform_user_id = ${input.fanRef} limit 1
  `);
  const metadata = result.rows[0]?.metadata;
  const bio = metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>).about ?? (metadata as Record<string, unknown>).bio
    : undefined;
  return typeof bio === "string" && bio.trim().length > 0 ? bio : undefined;
}
