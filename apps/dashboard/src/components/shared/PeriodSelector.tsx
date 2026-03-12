import { cn } from "@/lib/utils";

const PERIODS = [
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "all", label: "All" },
];

export function PeriodSelector({
  value,
  onChange,
  options,
  showCustom,
  from,
  to,
  onDateRangeChange,
}: {
  value: string;
  onChange: (v: string) => void;
  options?: Array<{ value: string; label: string }>;
  showCustom?: boolean;
  from?: string;
  to?: string;
  onDateRangeChange?: (from: string, to: string) => void;
}) {
  const items = options ?? PERIODS;
  return (
    <div className="flex items-center gap-3">
      <div className="inline-flex rounded-md border border-zinc-700">
        {items.map((p) => (
          <button
            type="button"
            key={p.value}
            onClick={() => onChange(p.value)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors",
              value === p.value
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200",
            )}
          >
            {p.label}
          </button>
        ))}
        {showCustom && (
          <button
            type="button"
            onClick={() => onChange("custom")}
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors",
              value === "custom"
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200",
            )}
          >
            Custom
          </button>
        )}
      </div>
      {showCustom && value === "custom" && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={from ?? ""}
            onChange={(e) => onDateRangeChange?.(e.target.value, to ?? "")}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
          />
          <span className="text-xs text-zinc-500">to</span>
          <input
            type="date"
            value={to ?? ""}
            onChange={(e) => onDateRangeChange?.(from ?? "", e.target.value)}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
          />
        </div>
      )}
    </div>
  );
}
