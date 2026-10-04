import { formatUsdFromMills as sharedFormatUsd, parseBusinessDate } from "@agency_hub_core/shared";

export function formatMills(mills: number): string {
  return sharedFormatUsd(mills);
}

export function formatUsdFromCents(cents: number): string {
  return sharedFormatUsd(cents * 10);
}

export function formatDelta(pct: number | null): { text: string; direction: "up" | "down" | "neutral" } {
  if (pct === null) return { text: "—", direction: "neutral" };
  const rounded = Math.abs(Math.round(pct * 10) / 10);
  if (pct > 0) return { text: `↑ ${rounded}%`, direction: "up" };
  if (pct < 0) return { text: `↓ ${rounded}%`, direction: "down" };
  return { text: "0%", direction: "neutral" };
}

export function formatDate(iso: string, options?: { includeYear?: boolean }): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: options?.includeYear ? "numeric" : undefined,
  });
}

/** "Oct 4, 12:01". `yearUnlessCurrent`: an instant of another year carries it
 *  ("Aug 30, 2025, 11:59") — a date without one reads as this year's. */
export function formatDateTime(iso: string, options?: { yearUnlessCurrent?: boolean }): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const withYear = options?.yearUnlessCurrent === true && d.getFullYear() !== new Date().getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: withYear ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatRelativeTimeCompact(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

const TYPE_LABELS: Record<string, string> = {
  subscription: "Subscription",
  tip: "Tip",
  message_purchase: "Message",
  post_purchase: "Post Purchase",
  stream_tip: "Stream Tip",
  chargeback: "Chargeback",
  refund: "Refund",
  payout_reversal: "Payout Reversal",
  other: "Other",
};

export function transactionTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

export function daysRemaining(expiresIso: string): number {
  const diff = new Date(expiresIso).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86_400_000));
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatBusinessDateShort(bd: string): string {
  const { month, day } = parseBusinessDate(bd);
  return `${MONTH_SHORT[month - 1]} ${day}`;
}

export function formatBusinessDateMonth(bd: string): string {
  const { year, month } = parseBusinessDate(bd);
  return `${MONTH_SHORT[month - 1]} ${String(year).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Usage date-nav helpers
// ---------------------------------------------------------------------------

export type UsagePeriod = "day" | "week" | "month";

/** Build a YYYY-MM-DD string from year/month/day. */
function bd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Get Monday of the ISO week containing the given business date. */
export function weekStart(date: string): string {
  const { year, month, day } = parseBusinessDate(date);
  const d = new Date(year, month - 1, day);
  const dow = d.getDay(); // 0=Sun
  const shift = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(year, month - 1, day + shift);
  return bd(mon.getFullYear(), mon.getMonth() + 1, mon.getDate());
}

/** Get Sunday of the ISO week containing the given business date. */
export function weekEnd(date: string): string {
  const ws = weekStart(date);
  const { year, month, day } = parseBusinessDate(ws);
  const sun = new Date(year, month - 1, day + 6);
  return bd(sun.getFullYear(), sun.getMonth() + 1, sun.getDate());
}

/** First day of the month containing the given business date. */
export function monthStart(date: string): string {
  const { year, month } = parseBusinessDate(date);
  return bd(year, month, 1);
}

/** Last day of the month containing the given business date. */
export function monthEnd(date: string): string {
  const { year, month } = parseBusinessDate(date);
  return bd(year, month, lastDayOfMonth(year, month));
}

/** Compute the {from, to} range for the given period around the anchor date. */
export function usageRange(anchor: string, mode: UsagePeriod): { from: string; to: string } {
  switch (mode) {
    case "day":
      return { from: anchor, to: anchor };
    case "week":
      return { from: weekStart(anchor), to: weekEnd(anchor) };
    case "month":
      return { from: monthStart(anchor), to: monthEnd(anchor) };
  }
}

/** Shift anchor date by one period step. */
export function shiftAnchor(anchor: string, mode: UsagePeriod, direction: -1 | 1): string {
  const { year, month, day } = parseBusinessDate(anchor);
  switch (mode) {
    case "day": {
      const d = new Date(year, month - 1, day + direction);
      return bd(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
    case "week": {
      const d = new Date(year, month - 1, day + direction * 7);
      return bd(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
    case "month": {
      const newMonth = month - 1 + direction;
      const d = new Date(year, newMonth, 1);
      const clamped = Math.min(day, lastDayOfMonth(d.getFullYear(), d.getMonth() + 1));
      return bd(d.getFullYear(), d.getMonth() + 1, clamped);
    }
  }
}

const MONTH_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Human-readable label for the current date/range based on period mode. */
export function usageDateLabel(anchor: string, mode: UsagePeriod): string {
  const { year, month, day } = parseBusinessDate(anchor);
  switch (mode) {
    case "day":
      return `${MONTH_SHORT[month - 1]} ${day}, ${year}`;
    case "week": {
      const ws = weekStart(anchor);
      const we = weekEnd(anchor);
      const f = parseBusinessDate(ws);
      const t = parseBusinessDate(we);
      if (f.year === t.year && f.month === t.month) {
        return `${MONTH_SHORT[f.month - 1]} ${f.day} – ${t.day}, ${f.year}`;
      }
      if (f.year === t.year) {
        return `${MONTH_SHORT[f.month - 1]} ${f.day} – ${MONTH_SHORT[t.month - 1]} ${t.day}, ${f.year}`;
      }
      return `${MONTH_SHORT[f.month - 1]} ${f.day}, ${f.year} – ${MONTH_SHORT[t.month - 1]} ${t.day}, ${t.year}`;
    }
    case "month":
      return `${MONTH_FULL[month - 1]} ${year}`;
  }
}
