import { queryOptions } from "@tanstack/react-query";
import { kernel } from "./hub";

/** `adminListUsers` (the owner's only): Люди, Доступ and a person's «Доступ». */
export const usersQuery = queryOptions({
  queryKey: ["team", "users"] as const,
  queryFn: () => kernel.adminListUsers(),
});
