import type { Platform } from "@agency_hub_core/shared";

export const PLATFORM_WORD: Readonly<Record<Platform, string>> = {
  fansly: "Fansly",
  onlyfans: "OnlyFans",
  telegram: "Telegram",
};

interface PlatformBadgeProps {
  platform: Platform;
}

/** The platform of a page: plain text, one look on every screen. */
export function PlatformBadge({ platform }: PlatformBadgeProps) {
  return <span className="platform-tag">{PLATFORM_WORD[platform]}</span>;
}

/** The same word in a dense list. */
export function PlatformTag({ platform }: PlatformBadgeProps) {
  return <span className="platform-tag">{PLATFORM_WORD[platform]}</span>;
}
