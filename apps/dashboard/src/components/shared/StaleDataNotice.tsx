interface StaleDataNoticeProps {
  title?: string;
  error?: unknown;
  className?: string;
}

export function StaleDataNotice({
  title = "Не удалось обновить — показаны прежние данные",
  error,
  className = "",
}: StaleDataNoticeProps) {
  const detail = error instanceof Error ? error.message : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`notice notice-warning ${className}`}
    >
      <span>
        <span className="font-semibold">{title}</span>
        {detail && <span className="ml-2 opacity-80">{detail}</span>}
      </span>
    </div>
  );
}
