import { useSearchParams } from "react-router";

/** The page a sync screen shows in detail: `?page=<label>`, shared by the
 *  Fansly and OnlyFans screens (the side navigation carries it across). */
export function useSelectedSyncPage(): {
  selectedPage: string | null;
  selectPage: (pageLabel: string) => void;
  clearPage: () => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  return {
    selectedPage: searchParams.get("page"),
    selectPage: (pageLabel) => {
      const next = new URLSearchParams(searchParams);
      next.set("page", pageLabel);
      setSearchParams(next);
    },
    clearPage: () => {
      const next = new URLSearchParams(searchParams);
      next.delete("page");
      setSearchParams(next);
    },
  };
}
