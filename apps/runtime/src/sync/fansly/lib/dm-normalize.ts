import type { upsertPageDmMessages } from "@agency_hub_core/db";
import type { FanslyMessage } from "@agency_hub_core/fansly";

import type { ResolvedPageContext } from "../../../services/page-context.ts";
import { normalizeFanslyTimestamp } from "./timestamp.ts";

// A served `/message` page as hot-table rows, without I/O: the Fansly Sync
// Engine's DM apply (the legacy DM lanes that shared it are gone since step 4,
// S4-15).

export type FanslyDmMessageUpsertInput = Parameters<typeof upsertPageDmMessages>[1];

export function normalizeDmTipAmountCents(
  platform: ResolvedPageContext["platform"],
  totalTipAmount: number | null | undefined,
) {
  if (typeof totalTipAmount !== "number" || !Number.isFinite(totalTipAmount) || totalTipAmount <= 0) {
    return 0;
  }

  // Fansly live DM payloads emit tip totals in mills; the stored field and API contract are cents.
  const normalizedAmount = platform === "fansly"
    ? totalTipAmount / 10
    : totalTipAmount;

  return Math.max(0, Math.round(normalizedAmount));
}

/** Before 2010, or more than a day after `now`: a DM timestamp no message can
 *  carry (the engine's apply counts it as `timestamps_implausible`). */
export function isClearlyImplausibleDmTimestamp(timestamp: Date, now = new Date()) {
  return timestamp.getTime() < Date.UTC(2010, 0, 1) ||
    timestamp.getTime() > now.getTime() + (24 * 60 * 60 * 1000);
}

export function resolveDmSenderRole(
  senderId: string | null | undefined,
  pageAccountId: string,
  partnerPlatformUserId: string | null | undefined,
) {
  if (!senderId) {
    return "unknown" as const;
  }
  if (senderId === pageAccountId) {
    return "model" as const;
  }
  if (partnerPlatformUserId && senderId === partnerPlatformUserId) {
    return "fan" as const;
  }
  return "unknown" as const;
}

export interface FanslyDmMessageNormalizeContext {
  conversationId: number;
  platformAccountId: number;
  platform: ResolvedPageContext["platform"];
  /** The page's own platform account id — sender-role classification. */
  pageAccountId: string;
  partnerPlatformUserId: string | null;
  /** What an implausibly future timestamp is judged against (default: now). */
  now?: Date;
}

export interface NormalizedFanslyDmMessages {
  /** One hot-table row per message with a parseable `createdAt`, in response order. */
  rows: FanslyDmMessageUpsertInput;
  /** Messages left unstored: no parseable `createdAt` (still journaled). */
  unparseable: Array<{ id: string; valueType: string }>;
  /** Stored messages whose timestamp normalized to an implausible instant
   *  (the engine's apply counts them as `timestamps_implausible`). */
  implausible: Array<{ id: string; rawValue: number; normalizedAt: Date }>;
  /** Every message id as served (newest first by contract). */
  idsInResponseOrder: string[];
}

/**
 * The pure part of a `/message` page's normalization (design §5.4 step 2):
 * hot-table rows (timestamps via `normalizeFanslyTimestamp`, tips mills →
 * cents, the sender role against the page and the thread's partner), the
 * messages without a parseable `createdAt`, and the served id order. No
 * database read, no overlap lookup, no exhaustion verdict, no telemetry: the
 * legacy page normalization (`normalizeFanslyDmMessagePage`) and the Fansly
 * Sync Engine's DM apply both call it.
 */
export function normalizeFanslyDmMessages(
  items: readonly FanslyMessage[],
  context: FanslyDmMessageNormalizeContext,
): NormalizedFanslyDmMessages {
  const now = context.now ?? new Date();
  const rows: FanslyDmMessageUpsertInput = [];
  const unparseable: NormalizedFanslyDmMessages["unparseable"] = [];
  const implausible: NormalizedFanslyDmMessages["implausible"] = [];
  for (const message of items) {
    const raw = message.createdAt as unknown;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      // The row stays in the verbatim journal; the hot table cannot hold it
      // without a date. Overlap, cursor and exhaustion still count it.
      unparseable.push({ id: message.id, valueType: raw === null ? "null" : typeof raw });
      continue;
    }
    const createdAt = normalizeFanslyTimestamp(raw);
    if (isClearlyImplausibleDmTimestamp(createdAt, now)) {
      implausible.push({ id: message.id, rawValue: raw, normalizedAt: createdAt });
    }
    rows.push({
      conversationId: context.conversationId,
      platformAccountId: context.platformAccountId,
      platformMessageId: message.id,
      senderPlatformUserId: message.senderId ?? null,
      senderRole: resolveDmSenderRole(message.senderId ?? null, context.pageAccountId, context.partnerPlatformUserId),
      createdAt,
      content: message.content ?? "",
      totalTipAmountCents: normalizeDmTipAmountCents(context.platform, message.totalTipAmount),
      inReplyToMessageId: message.inReplyTo ?? null,
      inReplyToRootMessageId: message.inReplyToRoot ?? null,
    });
  }
  return { rows, unparseable, implausible, idsInResponseOrder: items.map((message) => message.id) };
}
