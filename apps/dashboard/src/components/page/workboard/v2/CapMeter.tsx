/** Old-mass residual daily budget — makes a capped queue feel like a finite batch. */
export function CapMeter({ used, total }: { used: number; total: number; resetsAt?: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const remaining = Math.max(0, total - used);
  const fill = pct >= 100 ? "bg-text-muted" : pct >= 80 ? "bg-warning-dark" : "bg-accent";

  return (
    <div className="mb-4 rounded-card border border-border bg-card px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between text-[12px]">
        <span className="font-semibold text-text-primary">Старая база — остаточный лимит на сегодня</span>
        <span className="tabular-nums text-text-muted">
          {used} / {total} касаний · осталось {remaining}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-hover-alt">
        <div className={`h-full ${fill} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 text-[11px] text-text-muted">
        Не мешает приоритетным вкладкам. Бери сверху — лучшие шансы первыми. Сброс в 00:00 UTC.
      </div>
    </div>
  );
}
