import { Notice } from "@/components/ui/Notice";
import { staleDataText } from "./QueryNotice.js";

interface StaleDataNoticeProps {
  title?: string;
  error?: unknown;
  className?: string;
  /** When the data on screen were read. */
  at?: string | number | Date | undefined;
}

/** The hub did not answer the refresh: the data on screen stay, and it says so.
 *  The server's own words stay out: they are in English. */
export function StaleDataNotice({ title, className = "", at }: StaleDataNoticeProps) {
  return (
    <Notice tone="warning" role="status" className={className}>
      {title ?? staleDataText(at)}
    </Notice>
  );
}
