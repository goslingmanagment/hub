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
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: options?.includeYear ? "numeric" : undefined,
  });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
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
