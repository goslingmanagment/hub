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
}: {
  value: string;
  onChange: (v: string) => void;
  options?: Array<{ value: string; label: string }>;
}) {
  const items = options ?? PERIODS;
  return (
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
    </div>
  );
}
