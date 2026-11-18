import { queryOptions } from "@tanstack/react-query";
import { kernel } from "./hub";

/**
 * `adminListUsers` (the owner's only): Команда leaves out a login switched off without a shift in the period; a
 * person's card reads its role, access state and pages.
 */
export const usersQuery = queryOptions({
  queryKey: ["team", "users"] as const,
  queryFn: () => kernel.adminListUsers(),
});
