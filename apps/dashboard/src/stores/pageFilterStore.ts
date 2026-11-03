import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The console's page filter: what a person picked by hand, kept across screens
 * and across a reload. It only narrows what is shown. No write ever takes its
 * page from here, from `?page=` or from the chip: a write's target comes from
 * the row, the path or a field the person filled in (design/ia.md §0).
 *
 * A link with `?page=` shows that page on its screen and leaves this alone. A
 * label that is gone is forgotten by the shell (usePageFilter).
 */
const LAST_ONE_PAGE_KEY = "hub-last-one-page";

function readLastOnePage(): string | null {
  try {
    return localStorage.getItem(LAST_ONE_PAGE_KEY);
  } catch {
    return null;
  }
}

function writeLastOnePage(label: string | null): void {
  try {
    if (label === null) localStorage.removeItem(LAST_ONE_PAGE_KEY);
    else localStorage.setItem(LAST_ONE_PAGE_KEY, label);
  } catch {
    /* Remembering the last page is a convenience only. */
  }
}

interface PageFilterState {
  /** The page picked by hand; null is «Все страницы». */
  page: string | null;
  /** The last Fansly page picked by hand on a one-page screen: what «Статистика»
   *  shows when the filter says every page. Never the filter itself. */
  lastOnePage: string | null;
  /** A label the address asked for and the catalog does not have, with the path
   *  it was asked on: the screen shows every page and says so. */
  rejected: { label: string; pathname: string } | null;
  setPage: (page: string | null) => void;
  setLastOnePage: (label: string | null) => void;
  setRejected: (rejected: { label: string; pathname: string } | null) => void;
  /** Sign-out: the next person starts from every page. */
  clear: () => void;
}

export const usePageFilterStore = create<PageFilterState>()(
  persist(
    (set) => ({
      page: null,
      lastOnePage: readLastOnePage(),
      rejected: null,
      setPage: (page) => set({ page, rejected: null }),
      setLastOnePage: (lastOnePage) => {
        writeLastOnePage(lastOnePage);
        set({ lastOnePage });
      },
      setRejected: (rejected) => set({ rejected }),
      clear: () => {
        writeLastOnePage(null);
        set({ page: null, lastOnePage: null, rejected: null });
      },
    }),
    {
      name: "hub-page-filter",
      version: 1,
      partialize: (state) => ({ page: state.page }),
    },
  ),
);
