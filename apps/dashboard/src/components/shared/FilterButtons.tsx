interface Filter {
  key: string;
  label: string;
  // `| undefined` so callers can pass a still-loading query's count directly
  // under exactOptionalPropertyTypes; the render already guards with != null.
  count?: number | undefined;
}

interface FilterButtonsProps {
  filters: Filter[];
  active: string;
  onChange: (key: string) => void;
}

export function FilterButtons({ filters, active, onChange }: FilterButtonsProps) {
  return (
    <div className="segmented max-w-full flex-wrap">
      {filters.map((f) => {
        const isActive = active === f.key;
        return (
          <button
            key={f.key}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(f.key)}
            className="segment"
          >
            {f.label}
            {f.count != null && (
              <span className="segment-count">
                {f.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
