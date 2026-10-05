import { useSearchParams } from "react-router";

/** The page a sync tab shows in detail: `?page=<label>`, shared by «Синк» and
 *  «Синхронизация» (the section links carry it from one to the other). */
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
