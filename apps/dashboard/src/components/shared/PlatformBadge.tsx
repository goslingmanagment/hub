import type { Platform } from "@agency_hub_core/shared";

const LABELS: Readonly<Record<Platform, { short: string; long: string }>> = {
  fansly: { short: "Fansly", long: "Fansly" },
  onlyfans: { short: "OF", long: "OnlyFans" },
  telegram: { short: "TG", long: "Telegram" },
};

interface PlatformBadgeProps {
  platform: Platform;
}

/** The platform of a page, in its brand tint. One look on every screen. */
export function PlatformBadge({ platform }: PlatformBadgeProps) {
  return <span className={`platform-tag platform-${platform}`}>{LABELS[platform].long}</span>;
}

/** The compact form for dense lists (the sidebar's page tree). */
export function PlatformTag({ platform }: PlatformBadgeProps) {
  return (
    <span className={`platform-tag platform-${platform}`} title={LABELS[platform].long}>
      {LABELS[platform].short}
    </span>
  );
}
