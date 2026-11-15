import { queryOptions, useQuery } from "@tanstack/react-query";
import { kernel } from "./hub.js";

/** «Обучение»'s pages the viewer reads (`learnPages`): the owner every published one, anyone else the approved ones. */
export function learnPagesQuery() {
  return queryOptions({
    queryKey: ["learn", "pages"] as const,
    queryFn: () => kernel.learnPages(),
    staleTime: 5 * 60_000,
    meta: { suppressGlobalError: true },
  });
}

/** Whether the menu lists «Обучение»: the viewer has a page there to read (screens.ts `when: "learn"`). */
export function useHasLearn(): boolean {
  const read = useQuery(learnPagesQuery());
  return (read.data?.pages.length ?? 0) > 0;
}
