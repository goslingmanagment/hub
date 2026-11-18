import { queryOptions } from "@tanstack/react-query";
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { addDays, moscowDayEnd } from "@agency_hub_core/ui/moscow";
import type { ResolvedPeriod } from "@agency_hub_core/ui/period";
import { kernel } from "./hub";

/**
 * Reads several screens ask for: ONE cache entry each, so a drill-down from one
 * screen to another does not repeat a read it has just made, and a write that
 * refreshes the entry refreshes every screen showing it. The key is the
 * request's parameters themselves: two screens share an entry only when they
 * send exactly the same request. Each screen keeps its own `enabled`,
 * `staleTime`, `refetchInterval` and `placeholderData` (TanStack Query applies
 * them per observer).
 */

export interface ShiftSalesParams {
  days: number;
  until?: string;
  pageLabel?: string;
}

/** Every `teamShiftSales` entry of `shiftSalesQuery`: for a refresh of all of them. */
export const SHIFT_SALES_KEY = ["team", "shift-sales"] as const;

/** `teamShiftSales`: the parameters in one order, so equal requests are the same URL. */
export function shiftSalesQuery(params: ShiftSalesParams) {
  const query = {
    days: params.days,
    ...(params.until === undefined ? {} : { until: params.until }),
    ...(params.pageLabel === undefined ? {} : { pageLabel: params.pageLabel }),
  };
  return queryOptions({
    queryKey: [...SHIFT_SALES_KEY, query] as const,
    queryFn: () => kernel.teamShiftSales({ query }),
  });
}

/** The longest window of every team read Hub has today. */
export const READ_MAX_DAYS = 31;

/** The period as `teamChatterNumbers` takes it: `[from, to)` instants. A week ends on its Sunday even while it goes on. */
export function numbersWindow(period: ResolvedPeriod): { from: string; to: string } | null {
  if (period.days > READ_MAX_DAYS) return null;
  const last = period.spec.kind === "week" ? addDays(period.spec.monday, 6) : period.to;
  return { from: period.startsAt, to: moscowDayEnd(last) };
}

export interface ChatterNumbersParams {
  from: string;
  to: string;
  userId?: number | undefined;
}

/** Every `teamChatterNumbers` entry of `chatterNumbersQuery`: for a refresh of all of them. */
export const CHATTER_NUMBERS_KEY = ["team", "chatter-numbers"] as const;

type ChatterNumbers = KernelOperationResponse<"teamChatterNumbers">;

/**
 * `teamChatterNumbers` over `[from, to)`: the parameters in one order, so equal requests are the same URL. The key is
 * typed as any key, so a screen can choose between this entry and a request of its own in one `useQuery`.
 */
export function chatterNumbersQuery(params: ChatterNumbersParams) {
  const query = {
    from: params.from,
    to: params.to,
    ...(params.userId === undefined ? {} : { userId: params.userId }),
  };
  return queryOptions<ChatterNumbers, Error, ChatterNumbers, readonly unknown[]>({
    queryKey: [...CHATTER_NUMBERS_KEY, query],
    queryFn: () => kernel.teamChatterNumbers({ query }),
  });
}
