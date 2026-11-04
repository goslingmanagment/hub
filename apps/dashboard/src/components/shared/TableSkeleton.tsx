import { Skeleton } from "@/components/ui/Skeleton";

interface TableSkeletonProps {
  rows?: number;
  columns?: number;
}

/** A table on its way: the same columns and row height, no shine. */
export function TableSkeleton({ rows = 5, columns = 4 }: TableSkeletonProps) {
  return (
    <div className="table-wrap" aria-hidden="true">
      <table className="data-table">
        <thead>
          <tr>
            {Array.from({ length: columns }, (_, i) => (
              <th key={i}><Skeleton width={60 + (i % 3) * 20} /></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, rowIdx) => (
            <tr key={rowIdx}>
              {Array.from({ length: columns }, (_, colIdx) => (
                <td key={colIdx}><Skeleton width={80 + ((rowIdx + colIdx) % 4) * 25} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatCardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="stat-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="stat">
          <Skeleton width={64} />
          <div className="mt-3"><Skeleton width={96} className="!h-7" /></div>
        </div>
      ))}
    </div>
  );
}
