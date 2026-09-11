import { crossPageTransactionListQuerySchema } from "@agency_hub_core/contracts";
import type { PeriodOption } from "@/stores/periodStore";

/** Use the window returned with the amount. A missing window is never all-time. */
export function pageTransactionQuery(
  pageLabel: string,
  period: PeriodOption,
  revenue: { from?: string | null; to?: string | null } | undefined,
  type: string,
  offset: number,
) {
  if (!pageLabel || !revenue) return undefined;
  if (period !== "all" && (!revenue.from || !revenue.to)) return undefined;
  const parsed = crossPageTransactionListQuerySchema.safeParse({
    pageLabel,
    limit: 50,
    offset,
    reportableOnly: true,
    ...(period === "all" ? {} : { from: revenue.from, to: revenue.to }),
    ...(type ? { type } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}
