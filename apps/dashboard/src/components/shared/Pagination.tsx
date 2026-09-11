interface PaginationProps {
  offset: number;
  limit: number;
  total: number;
  onPageChange: (offset: number) => void;
  emptyLabel?: string;
  // Optional label overrides so a caller can localize the controls.
  previousLabel?: string;
  nextLabel?: string;
  formatRange?: (start: number, end: number, total: number) => string;
}

export function Pagination({
  offset,
  limit,
  total,
  onPageChange,
  emptyLabel = "0 items",
  previousLabel = "Previous",
  nextLabel = "Next",
  formatRange,
}: PaginationProps) {
  const start = total === 0 ? 0 : Math.min(offset + 1, total);
  const end = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  return (
    <div aria-label="Страницы списка" role="navigation" className="flex flex-wrap gap-3 items-center justify-between border-t border-border-light px-[22px] py-[14px]">
      <span className="text-[13px] text-text-muted tabular-nums">
        {total === 0
          ? emptyLabel
          : offset >= total
            ? `На этой странице нет записей · всего ${total}`
          : formatRange
            ? formatRange(start, end, total)
            : `${start}–${end} of ${total}`}
      </span>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!hasPrev}
          onClick={() => onPageChange(Math.max(0, offset - limit))}
          className="rounded-button border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {previousLabel}
        </button>
        <button
          type="button"
          disabled={!hasNext}
          onClick={() => onPageChange(offset + limit)}
          className="rounded-button border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {nextLabel}
        </button>
      </div>
    </div>
  );
}
