import { EyeOff } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { Tooltip } from "@/components/shared/Tooltip";

/** The tooltip copy of the mark; `missAt` is the page's answer time. */
export function describeFanNotVisible(missAt: string): string {
  return `This page can't see the fan's account — the fan probably blocked the page or deleted the account. Checked ${formatDateTime(missAt, { yearUnlessCurrent: true })}.`;
}

/**
 * The page's own "can't see this fan" mark on its spender lists
 * (`accountLookupMissAt`): the page's latest Fansly account answer did not
 * return the fan. Every page answers for itself, so the same fan shows
 * normally on a page that sees him. Renders nothing without a miss.
 */
export function FanNotVisibleMark({ missAt, className = "" }: { missAt: string | null | undefined; className?: string }) {
  if (!missAt) return null;
  return (
    <Tooltip content={describeFanNotVisible(missAt)} focusable className={`shrink-0 rounded-md ${className}`}>
      <span
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-text-muted/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-text-muted"
      >
        <EyeOff size={10} aria-hidden="true" />
        Not visible
      </span>
    </Tooltip>
  );
}
