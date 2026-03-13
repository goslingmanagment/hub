import { formatUsdFromMills as sharedFormatUsd } from "@fansly-connect/shared";

export function formatMills(mills: number): string {
  return sharedFormatUsd(mills);
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
