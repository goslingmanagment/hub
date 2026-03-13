interface PaginationProps {
  offset: number;
  limit: number;
  total: number;
  onPageChange: (offset: number) => void;
  emptyLabel?: string;
}

export function Pagination({ offset, limit, total, onPageChange, emptyLabel = "0 items" }: PaginationProps) {
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  return (
    <div className="flex items-center justify-between border-t border-border-light px-[22px] py-[14px]">
      <span className="text-[13px] text-text-muted tabular-nums">
        {total === 0 ? emptyLabel : `${start}–${end} of ${total}`}
      </span>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!hasPrev}
          onClick={() => onPageChange(Math.max(0, offset - limit))}
          className="rounded-button border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!hasNext}
          onClick={() => onPageChange(offset + limit)}
          className="rounded-button border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
