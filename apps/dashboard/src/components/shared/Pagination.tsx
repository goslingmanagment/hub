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
  emptyLabel = "Нет записей",
  previousLabel = "Назад",
  nextLabel = "Далее",
  formatRange,
}: PaginationProps) {
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border-light px-4 py-3">
      <span className="text-[13px] text-text-secondary tabular-nums">
        {total === 0
          ? emptyLabel
          : formatRange
            ? formatRange(start, end, total)
            : `${start}–${end} из ${total}`}
      </span>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!hasPrev}
          onClick={() => onPageChange(Math.max(0, offset - limit))}
          className="btn btn-sm"
        >
          {previousLabel}
        </button>
        <button
          type="button"
          disabled={!hasNext}
          onClick={() => onPageChange(offset + limit)}
          className="btn btn-sm"
        >
          {nextLabel}
        </button>
      </div>
    </div>
  );
}
