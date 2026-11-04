import {
  crossPageTransactionListQuerySchema,
  type CrossPageTransactionListQuery,
  type CrossPageTransactionListResponse,
} from "@agency_hub_core/contracts";
import { resolveRevenuePeriodBoundsForPlatform, type Platform } from "@agency_hub_core/shared";
import type { PeriodOption } from "@/stores/periodStore";

/** The parameters of the address a request may take as they are. */
const PASSED = ["type", "state", "sortBy", "sortDir", "from", "to", "offset"] as const;

/**
 * The one piece of «Операции» a sum depends on: the address and the screen's
 * period and page make the request. An exact window from a clicked sum (`from`,
 * `to`) wins over the period; otherwise the period becomes the window of the
 * platform, by the server's own function, so the sum equals Главная's row. All
 * time has no window. `reportableOnly` is on unless the address says otherwise.
 */
export function parseTransactionUrl(
  search: URLSearchParams,
  ctx: { pageLabel: string | null; platform: Platform; period: PeriodOption; now?: Date },
) {
  const raw = Object.fromEntries(PASSED.flatMap((key) => (search.has(key) ? [[key, search.get(key)!]] : [])));
  const exact = "from" in raw || "to" in raw;
  const bounds = exact || ctx.period === "all" ? null : resolveRevenuePeriodBoundsForPlatform(ctx.platform, ctx.period, ctx.now ?? new Date());
  return crossPageTransactionListQuerySchema.safeParse({
    ...raw,
    ...(bounds?.from && bounds.to ? { from: bounds.from.toISOString(), to: bounds.to.toISOString() } : {}),
    ...(ctx.pageLabel ? { pageLabel: ctx.pageLabel } : {}),
    reportableOnly: search.get("reportableOnly") ?? "true",
    limit: 50,
  });
}

/** An older server can ignore additive query parameters. Never display its
 * unfiltered items as proof of the number the user clicked. */
export function matchesTransactionScope(
  response: CrossPageTransactionListResponse,
  query: CrossPageTransactionListQuery,
): boolean {
  const scope = response.scope;
  return Boolean(
    scope &&
      response.summary &&
      scope.pageLabel === (query.pageLabel ?? null) &&
      scope.from === (query.from ? new Date(query.from).toISOString() : null) &&
      scope.to === (query.to ? new Date(query.to).toISOString() : null) &&
      scope.type === (query.type ?? null) &&
      scope.state === (query.state ?? null) &&
      scope.reportableOnly === query.reportableOnly,
  );
}
