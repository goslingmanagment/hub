export type ExternalLinkPlatform = "fansly" | "onlyfans";
export type ExternalLinkKind = "chat" | "profile";

export const PLATFORM_DISPLAY_NAME: Record<ExternalLinkPlatform, string> = {
  fansly: "Fansly",
  onlyfans: "OnlyFans",
};

function normalizeUsername(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildProfileUrl(
  platform: ExternalLinkPlatform,
  username: string | null | undefined,
) {
  const normalized = normalizeUsername(username);
  if (!normalized) {
    return null;
  }

  return platform === "onlyfans"
    ? `https://onlyfans.com/${encodeURIComponent(normalized)}`
    : `https://fansly.com/${encodeURIComponent(normalized)}`;
}

export function buildMessagesUrl(
  platform: ExternalLinkPlatform,
  platformConversationId: string | null | undefined,
) {
  if (typeof platformConversationId !== "string") {
    return null;
  }

  const trimmed = platformConversationId.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return platform === "onlyfans"
    ? `https://onlyfans.com/my/chats/chat/${encodeURIComponent(trimmed)}/`
    : `https://fansly.com/messages/${encodeURIComponent(trimmed)}`;
}

export function resolveExternalLink(
  platform: ExternalLinkPlatform,
  input: {
    platformConversationId?: string | null;
    username?: string | null;
  },
): { url: string; kind: ExternalLinkKind } | null {
  const chatUrl = buildMessagesUrl(platform, input.platformConversationId);
  if (chatUrl) {
    return { url: chatUrl, kind: "chat" };
  }

  const profileUrl = buildProfileUrl(platform, input.username);
  if (profileUrl) {
    return { url: profileUrl, kind: "profile" };
  }

  return null;
}
