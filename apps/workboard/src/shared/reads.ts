import { queryOptions } from "@tanstack/react-query";
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

/** `adminListUsers` (the owner's only): Люди, Доступ and a person's «Доступ». */
export const usersQuery = queryOptions({
  queryKey: ["team", "users"] as const,
  queryFn: () => kernel.adminListUsers(),
});
