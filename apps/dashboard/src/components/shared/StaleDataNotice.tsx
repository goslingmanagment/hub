import { Notice } from "@/components/ui/Notice";

interface StaleDataNoticeProps {
  title?: string;
  error?: unknown;
  className?: string;
}

/** The hub did not answer the refresh: the data on screen stay, and it says so.
 *  The server's own words stay out: they are in English. */
export function StaleDataNotice({
  title = "Не удалось обновить. Показаны прежние данные.",
  className = "",
}: StaleDataNoticeProps) {
  return (
    <Notice tone="warning" role="status" className={className}>
      {title}
    </Notice>
  );
}
