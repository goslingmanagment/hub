import { formatUsdFromMills, millsToNumber } from "@fansly-connect/shared";

export { formatUsdFromMills, millsToNumber };

export function formatCompactUsd(mills: number | bigint): string {
  const num = typeof mills === "bigint" ? Number(mills) / 1000 : mills / 1000;
  if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (Math.abs(num) >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

export function formatPercentChange(current: number, previous: number): string | null {
  if (previous === 0) return null;
  const change = ((current - previous) / Math.abs(previous)) * 100;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(1)}%`;
}
