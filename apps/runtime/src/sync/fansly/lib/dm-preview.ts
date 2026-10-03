import { normalizeDmMessageText } from "@agency_hub_core/shared";

/**
 * The conversation list's preview of its head message: the normalized text,
 * cut to 280 characters with an ellipsis. Shared by the legacy conversation
 * sweep and the Fansly Sync Engine's list resource (design §5.3), so both
 * write the same `page_dm_threads.last_message_preview`.
 */
export function truncateDmPreview(content: string | null | undefined, maxLength = 280) {
  const normalized = normalizeDmMessageText(content);
  if (!normalized) {
    return null;
  }

  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}
