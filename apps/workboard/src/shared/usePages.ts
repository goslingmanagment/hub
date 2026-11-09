import { useQuery } from "@tanstack/react-query";
import { kernel } from "./hub.js";

/** The pages the viewer reaches (`pages`), in the catalog's order: for the page filter and page chips. */
export function usePages() {
  return useQuery({
    queryKey: ["pages"],
    queryFn: () => kernel.pages(),
    staleTime: 5 * 60_000,
  });
}

export type HubPage = NonNullable<ReturnType<typeof usePages>["data"]>[number];

/** Pages under their models, in the catalog's order. */
export function groupPagesByModel(pages: readonly HubPage[]): { modelName: string; pages: HubPage[] }[] {
  const groups = new Map<string, { modelName: string; pages: HubPage[] }>();
  for (const page of pages) {
    const group = groups.get(page.modelSlug);
    if (group) group.pages.push(page);
    else groups.set(page.modelSlug, { modelName: page.modelName, pages: [page] });
  }
  return [...groups.values()];
}
