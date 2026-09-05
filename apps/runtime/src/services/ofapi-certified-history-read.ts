import {
  OFAPI_CAPTURE_PROOF_POLICY_VERSION,
  readCertifiedOfapiChatHistoryPage,
  type CertifiedOfapiHistoryMessage,
  type CertifiedOfapiHistoryMissReason,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { OfapiReadGatewayResponse } from "./ofapi-read-gateway.ts";

export const OFAPI_DEEP_HISTORY_READ_INTENT = "deep-history-v1";

export type OfapiHistoryReadMode = "vendor" | "shadow" | "db_fallback";

export type OfapiHistoryFallbackReason =
  | "surface_not_cutover"
  | "no_certificate"
  | "stale_head"
  | "gap"
  | "projection_lag"
  | "shadow_probe";

export interface OfapiHistoryReadCandidate {
  pageId: number;
  chatId: string;
  accountId: string;
  pathname: string;
  query: Record<string, string>;
}

function millsToDollars(value: string | null) {
  if (value === null) return null;
  const mills = Number(value);
  return Number.isFinite(mills) ? mills / 1_000 : null;
}

function replyToVendorShape(value: Record<string, unknown> | null) {
  if (!value) return null;
  const rawId = value.messageId;
  const numericId = typeof rawId === "string" && /^\d+$/.test(rawId)
    ? Number(rawId)
    : null;
  return {
    ...(numericId !== null && Number.isSafeInteger(numericId) ? { id: numericId } : {}),
    text: typeof value.textHtml === "string" ? value.textHtml : null,
    isSentByMe: typeof value.isSentByMe === "boolean" ? value.isSentByMe : null,
  };
}

function toVendorMessage(message: CertifiedOfapiHistoryMessage) {
  const fanId = message.fanNativeId !== null && /^\d+$/.test(message.fanNativeId)
    ? Number(message.fanNativeId)
    : null;
  return {
    id: Number(message.nativeMessageId),
    text: message.textHtml,
    price: millsToDollars(message.priceMills),
    isOpened: message.isOpened,
    isNew: message.isNew,
    isTip: message.isTip,
    tipAmount: millsToDollars(message.tipAmountMills),
    tipText: message.tipTextPlain,
    replyToMessage: replyToVendorShape(message.replyMetadata),
    media: message.mediaMetadata,
    mediaCount: message.mediaMetadata.length,
    isSentByMe: message.isSentByMe,
    createdAt: message.occurredAt.toISOString(),
    changedAt: message.vendorChangedAt?.toISOString() ?? null,
    ...(!message.isSentByMe && fanId !== null && Number.isSafeInteger(fanId)
      ? { fromUser: { id: fanId } }
      : {}),
  };
}

function nextPage(candidate: OfapiHistoryReadCandidate, nextFirstId: string | null) {
  if (nextFirstId === null) return null;
  const query = new URLSearchParams(
    Object.entries(candidate.query).filter(([name]) => name !== "last_id"),
  );
  query.set("first_id", nextFirstId);
  query.set("order", "desc");
  return `${candidate.pathname}?${query.toString()}`;
}

export function isExplicitOfapiDeepHistoryRead(
  candidate: Omit<OfapiHistoryReadCandidate, "pageId">,
  intent: string | null,
) {
  return intent === OFAPI_DEEP_HISTORY_READ_INTENT
    && candidate.query.filter === undefined
    && candidate.query.first_id !== undefined
    && candidate.query.last_id === undefined
    && (candidate.query.order ?? "desc") === "desc"
    && (candidate.query.skip_users ?? "all") === "all";
}

export function mapOfapiHistoryMissToFallback(
  reason: CertifiedOfapiHistoryMissReason,
): OfapiHistoryFallbackReason {
  if (reason === "projection_lag") return "projection_lag";
  if (reason === "stale_head" || reason === "head_missing") return "stale_head";
  if (reason === "no_certificate" || reason === "proof_policy_rejected") {
    return "no_certificate";
  }
  return "gap";
}

export async function readCertifiedOfapiHistoryResponse(
  app: AppContext,
  candidate: OfapiHistoryReadCandidate,
): Promise<
  | { kind: "hit"; response: OfapiReadGatewayResponse; messageIds: string[] }
  | { kind: "miss"; reason: CertifiedOfapiHistoryMissReason }
> {
  const firstId = candidate.query.first_id!;
  const page = await readCertifiedOfapiChatHistoryPage(app.db, {
    pageId: candidate.pageId,
    chatId: candidate.chatId,
    firstId,
    limit: Number(candidate.query.limit ?? "100"),
    acceptedProofPolicyVersions: [OFAPI_CAPTURE_PROOF_POLICY_VERSION],
  });
  if (page.kind === "miss") return page;
  return {
    kind: "hit",
    messageIds: page.messages.map((message) => message.nativeMessageId),
    response: {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-agency-hub-read-source": "db",
        "x-ofapi-credits-used": "0",
      },
      body: {
        data: page.messages.map(toVendorMessage),
        _meta: { _credits: { used: 0 } },
        _pagination: { next_page: nextPage(candidate, page.nextFirstId) },
      },
    },
  };
}

export function compareOfapiHistoryShadow(
  candidateIds: readonly string[],
  vendorBody: unknown,
) {
  const body = vendorBody !== null && typeof vendorBody === "object" && !Array.isArray(vendorBody)
    ? vendorBody as Record<string, unknown>
    : null;
  const data = Array.isArray(body?.data) ? body.data : null;
  if (!data) return { matches: false, vendorIds: [] as string[] };
  const vendorIds = data.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
    const id = (item as Record<string, unknown>).id;
    return typeof id === "number" || typeof id === "string" ? [String(id)] : [];
  });
  return {
    matches: vendorIds.length === data.length
      && candidateIds.length === vendorIds.length
      && candidateIds.every((id, index) => id === vendorIds[index]),
    vendorIds,
  };
}
