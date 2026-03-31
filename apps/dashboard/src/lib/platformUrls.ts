function normalizeFanslyUsername(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildFanslyProfileUrl(username: string | null | undefined) {
  const normalized = normalizeFanslyUsername(username);
  return normalized ? `https://fansly.com/${encodeURIComponent(normalized)}` : null;
}

export function buildFanslyMessagesUrl(platformConversationId: string | null | undefined) {
  if (typeof platformConversationId !== "string") {
    return null;
  }

  const trimmed = platformConversationId.trim();
  return trimmed.length > 0 ? `https://fansly.com/messages/${encodeURIComponent(trimmed)}` : null;
}

export type FanslyExternalLinkKind = "chat" | "profile";

export function resolveFanslyExternalLink(input: {
  platformConversationId?: string | null;
  username?: string | null;
}): { url: string; kind: FanslyExternalLinkKind } | null {
  const chatUrl = buildFanslyMessagesUrl(input.platformConversationId);
  if (chatUrl) {
    return { url: chatUrl, kind: "chat" };
  }

  const profileUrl = buildFanslyProfileUrl(input.username);
  if (profileUrl) {
    return { url: profileUrl, kind: "profile" };
  }

  return null;
}
