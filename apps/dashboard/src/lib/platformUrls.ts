import type { Platform } from "@agency_hub_core/shared";

export type ExternalLinkPlatform = Platform;
export type ExternalLinkKind = "chat" | "profile";

/** A platform's name, plain text: the one dictionary of the console. */
export const PLATFORM_DISPLAY_NAME: Readonly<Record<ExternalLinkPlatform, string>> = {
  fansly: "Fansly",
  onlyfans: "OnlyFans",
  telegram: "Telegram",
};

/** A platform's name; a platform the console does not know stays as it came. */
export function platformName(platform: string): string {
  return (PLATFORM_DISPLAY_NAME as Readonly<Record<string, string>>)[platform] ?? platform;
}

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

  switch (platform) {
    case "onlyfans":
      return `https://onlyfans.com/${encodeURIComponent(normalized)}`;
    case "fansly":
      return `https://fansly.com/${encodeURIComponent(normalized)}`;
    case "telegram":
      return `https://t.me/${encodeURIComponent(normalized)}`;
  }
}

/**
 * A post on the platform by its number: Fansly `https://fansly.com/post/<id>`,
 * OnlyFans `https://onlyfans.com/<id>/<username>`. No number, no link.
 */
export function buildPostUrl(
  platform: ExternalLinkPlatform,
  username: string | null | undefined,
  postRef: string | null | undefined,
) {
  const ref = typeof postRef === "string" ? postRef.trim() : "";
  if (ref === "") return null;
  switch (platform) {
    case "fansly":
      return `https://fansly.com/post/${encodeURIComponent(ref)}`;
    case "onlyfans": {
      const normalized = normalizeUsername(username);
      return normalized ? `https://onlyfans.com/${encodeURIComponent(ref)}/${encodeURIComponent(normalized)}` : null;
    }
    case "telegram":
      return null;
  }
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

  switch (platform) {
    case "onlyfans":
      return `https://onlyfans.com/my/chats/chat/${encodeURIComponent(trimmed)}/`;
    case "fansly":
      return `https://fansly.com/messages/${encodeURIComponent(trimmed)}`;
    case "telegram":
      // The persona's own Telegram is opened by the person who works it, never by a link here.
      return null;
  }
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
