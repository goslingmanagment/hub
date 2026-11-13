import { queryOptions } from "@tanstack/react-query";
import { kernel } from "./hub.js";

/**
 * The person's open matters, the longest waiting first (the owner's every one): the strip «Ждут вас» above «Мои
 * смены» and the team's list read it. Apart from shared/matters.ts, whose count by groups is the team's read: the
 * chatter's screens import only this (tests/narrow-session-screens.test.ts walks what they call).
 */
export const mattersListQuery = queryOptions({
  queryKey: ["matters", "list", "open"] as const,
  queryFn: () => kernel.mattersList({ query: { state: "open", limit: 500 } }),
  staleTime: 30_000,
});
