const TOUCHPOINT_COLORS: Record<string, string> = {
  "1d": "bg-red-500/15 text-red-400",
  "3d": "bg-orange-500/15 text-orange-400",
  "5d": "bg-yellow-500/15 text-yellow-400",
  "7d": "bg-blue-500/15 text-blue-400",
  "14d": "bg-zinc-500/15 text-zinc-400",
  "21d": "bg-zinc-500/15 text-zinc-400",
};

interface TouchpointBadgeProps {
  touchpointCode: string;
  touchpointLabel: string;
}

export function TouchpointBadge({ touchpointCode, touchpointLabel }: TouchpointBadgeProps) {
  const color = TOUCHPOINT_COLORS[touchpointCode] ?? "bg-zinc-500/15 text-zinc-400";
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-bold ${color}`}>
      {touchpointLabel}
    </span>
  );
}
