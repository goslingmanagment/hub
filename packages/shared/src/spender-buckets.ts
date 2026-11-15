// Spender auto-list buckets — lifetime gross-spend bands that mirror the page's
// Fansly "[FB] $X-$Y Spenders" lists. Single source of truth, consumed by the
// spender analytics service (auto-lists).
// Amounts are mills (1 mill = $0.001). Each band is [minAmountMills,
// maxAmountMillsExclusive); the last band is open-ended (null upper bound).

export interface SpenderAutoListBucket {
  key: string;
  label: string;
  minAmountMills: bigint;
  maxAmountMillsExclusive: bigint | null;
}

export const SPENDER_AUTO_LIST_BUCKETS = [
  {
    key: "0-25",
    label: "[FB] $0-$25 Spenders",
    minAmountMills: 10n,
    maxAmountMillsExclusive: 25_000n,
  },
  {
    key: "25-50",
    label: "[FB] $25-$50 Spenders",
    minAmountMills: 25_000n,
    maxAmountMillsExclusive: 50_000n,
  },
  {
    key: "50-150",
    label: "[FB] $50-$150 Spenders",
    minAmountMills: 50_000n,
    maxAmountMillsExclusive: 150_000n,
  },
  {
    key: "150-350",
    label: "[FB] $150-$350 Spenders",
    minAmountMills: 150_000n,
    maxAmountMillsExclusive: 350_000n,
  },
  {
    key: "350-600",
    label: "[FB] $350-$600 Spenders",
    minAmountMills: 350_000n,
    maxAmountMillsExclusive: 600_000n,
  },
  {
    key: "600-plus",
    label: "[FB] $600+ Spenders",
    minAmountMills: 600_000n,
    maxAmountMillsExclusive: null,
  },
] as const satisfies readonly SpenderAutoListBucket[];

/**
 * A fan's tier on a page: ONE scale for the extension and Hub's screens (products package M) — the chatters' names for
 * the buckets above (the extension's Spenders, `chat-extension packages/ui/src/spenders/rows.ts`), by what the fan PAID
 * there over all time (gross, before the platform's cut). Lower bounds in mills.
 */
export const SPENDER_TIERS = [
  { name: "Whale", fromMills: 600_000 },
  { name: "Top", fromMills: 350_000 },
  { name: "Prime", fromMills: 150_000 },
  { name: "Base", fromMills: 50_000 },
  { name: "Low", fromMills: 25_000 },
  { name: "Micro", fromMills: 1 },
] as const;
export type SpenderTierName = (typeof SPENDER_TIERS)[number]["name"];

/** The tier of a lifetime gross spend in mills; null — nothing paid. */
export function spenderTierOf(lifetimeGrossMills: number): SpenderTierName | null {
  return SPENDER_TIERS.find((tier) => lifetimeGrossMills >= tier.fromMills)?.name ?? null;
}
