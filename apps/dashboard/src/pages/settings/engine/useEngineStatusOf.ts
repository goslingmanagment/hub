import { useSyncEnginePages } from "@/api/queries";
import { engineStatusState, type EngineStatusState } from "./engineDisplay.js";

/** The engine status of each page by its label (`/api/v1/sync/pages`). */
export function useEngineStatusOf(): (pageLabel: string) => EngineStatusState {
  const { data, isLoading, isError } = useSyncEnginePages();
  return (pageLabel) => {
    if (data === undefined && isLoading) return { kind: "loading" };
    if (data === undefined && isError) return { kind: "error" };
    return engineStatusState(data?.pages.find((page) => page.pageLabel === pageLabel));
  };
}
