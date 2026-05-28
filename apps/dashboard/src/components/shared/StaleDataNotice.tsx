interface StaleDataNoticeProps {
  title?: string;
  error?: unknown;
  className?: string;
}

export function StaleDataNotice({
  title = "Showing cached data",
  error,
  className = "",
}: StaleDataNoticeProps) {
  const detail = error instanceof Error ? error.message : null;

  return (
    <div className={`rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm ${className}`}>
      <span className="font-semibold text-warning-dark">{title}</span>
      {detail && <span className="ml-2 text-text-muted">{detail}</span>}
    </div>
  );
}
