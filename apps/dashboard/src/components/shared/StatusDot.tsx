import { CONNECTION_STATUS_COLORS } from "@/lib/constants";

interface StatusDotProps {
  status: string;
}

export function StatusDot({ status }: StatusDotProps) {
  const config = CONNECTION_STATUS_COLORS[status] ?? { dot: "#a8a29e", label: status };

  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-block shrink-0 rounded-full"
        style={{ width: 7, height: 7, backgroundColor: config.dot }}
      />
      <span className="text-[13px] text-text-secondary">{config.label}</span>
    </div>
  );
}
