interface Filter {
  key: string;
  label: string;
  count?: number;
}

interface FilterButtonsProps {
  filters: Filter[];
  active: string;
  onChange: (key: string) => void;
}

export function FilterButtons({ filters, active, onChange }: FilterButtonsProps) {
  return (
    <div className="flex items-center gap-1">
      {filters.map((f) => {
        const isActive = active === f.key;
        return (
          <button
            key={f.key}
            type="button"
            onClick={() => onChange(f.key)}
            className={`flex items-center gap-1.5 rounded-button px-3 py-1.5 text-[13px] font-medium transition-colors ${
              isActive
                ? "bg-[#1a1a1a] text-white"
                : "border border-border bg-card text-text-secondary hover:bg-hover"
            }`}
          >
            {f.label}
            {f.count != null && (
              <span className={isActive ? "text-white/60" : "text-text-muted"}>
                {f.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
