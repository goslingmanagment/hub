const config = {
  fansly: { bg: "#e8f0fe", text: "#3b6fc4", label: "Fansly" },
  onlyfans: { bg: "#fef3e2", text: "#c27a1a", label: "OF" },
} as const;

interface PlatformBadgeProps {
  platform: "fansly" | "onlyfans";
}

export function PlatformBadge({ platform }: PlatformBadgeProps) {
  const c = config[platform];

  return (
    <span
      className="inline-block rounded-md px-2 py-0.5 font-semibold"
      style={{ fontSize: 11, backgroundColor: c.bg, color: c.text }}
    >
      {c.label}
    </span>
  );
}
