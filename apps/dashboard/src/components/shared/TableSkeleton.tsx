interface TableSkeletonProps {
  rows?: number;
  columns?: number;
}

export function TableSkeleton({ rows = 5, columns = 4 }: TableSkeletonProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="bg-hover-alt px-4 py-3">
        <div className="flex gap-4">
          {Array.from({ length: columns }, (_, i) => (
            <div key={i} className="h-3 rounded bg-border animate-pulse" style={{ width: `${60 + (i % 3) * 20}px` }} />
          ))}
        </div>
      </div>
      {Array.from({ length: rows }, (_, rowIdx) => (
        <div key={rowIdx} className="flex gap-4 border-t border-border px-4 py-3.5">
          {Array.from({ length: columns }, (_, colIdx) => (
            <div
              key={colIdx}
              className="h-4 rounded bg-hover-alt animate-pulse"
              style={{
                width: `${80 + ((rowIdx + colIdx) % 4) * 25}px`,
                animationDelay: `${(rowIdx * columns + colIdx) * 50}ms`,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function StatCardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className={`grid gap-3.5`} style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-[10px] border border-border bg-card p-4">
          <div className="h-3 w-16 rounded bg-hover-alt animate-pulse" />
          <div className="mt-3 h-7 w-24 rounded bg-hover-alt animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
        </div>
      ))}
    </div>
  );
}
