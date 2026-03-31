export type OverdueSeverity = "normal" | "yellow" | "red";

export function resolveOverdueSeverity(days: number): OverdueSeverity {
  if (days >= 7) return "red";
  if (days >= 3) return "yellow";
  return "normal";
}

export const OVERDUE_BG: Record<OverdueSeverity, string> = {
  normal: "bg-card",
  yellow: "bg-yellow-500/5",
  red: "bg-red-500/5",
};

export const OVERDUE_BADGE: Record<OverdueSeverity, string> = {
  normal: "bg-zinc-500/10 text-text-secondary",
  yellow: "bg-yellow-500/15 text-yellow-600",
  red: "bg-red-500/15 text-red-500",
};

const TOUCHPOINT_COLORS: Record<string, string> = {
  "1d": "bg-red-500/15 text-red-400",
  "3d": "bg-orange-500/15 text-orange-400",
  "5d": "bg-yellow-500/15 text-yellow-400",
  "7d": "bg-blue-500/15 text-blue-400",
  "14d": "bg-zinc-500/15 text-zinc-400",
  "21d": "bg-zinc-500/15 text-zinc-400",
};

export function resolveTouchpointBadgeClass(touchpointCode: string) {
  return TOUCHPOINT_COLORS[touchpointCode] ?? "bg-zinc-500/15 text-zinc-400";
}

