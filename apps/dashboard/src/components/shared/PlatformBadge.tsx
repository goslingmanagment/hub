const LABELS = {
  fansly: { short: "Fansly", long: "Fansly" },
  onlyfans: { short: "OF", long: "OnlyFans" },
} as const;

interface PlatformBadgeProps {
  platform: "fansly" | "onlyfans";
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
