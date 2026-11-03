import { useCallback, useEffect } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import type { Platform } from "@agency_hub_core/shared";
import { matchScreen, pageFilterOf, type OnePageWay, type PageFilterMode, type Screen } from "@/lib/sections";
import { usePageFilterStore } from "@/stores/pageFilterStore";
import { useDashboardShell } from "./DashboardShellContext.js";

/** Address parameters a change of the page makes meaningless: a list position,
 *  an expanded row, an opened record. The period stays. */
const RESET_WITH_PAGE = ["offset", "row", "chart", "txOffset", "spendersOffset", "publication"] as const;

export interface PageFilterView {
  screen: Screen | null;
  mode: PageFilterMode;
  onePageWay: OnePageWay | null;
  /** The page this screen narrows to, known to the catalog; null is every page. */
  page: string | null;
  /** That page's identity. */
  item: { label: string; platform: Platform; modelName: string; username: string | null } | null;
  /** What was picked by hand; the screen may show another one through a link. */
  remembered: string | null;
  /** The chosen page has no data of this screen's kind: the screen says so. */
  outOfScope: boolean;
  /** A label from the address the catalog does not have, on this address. */
  rejected: string | null;
  /** The choice by hand, from the chip or a table of pages. */
  select: (label: string | null) => void;
}

/**
 * The page filter as a screen reads it. It only narrows what is shown: a write
 * never takes its page from here (design/ia.md §0). The address wins over the
 * memory, the memory over «Все страницы»; only a choice by hand is remembered.
 */
export function usePageFilter(): PageFilterView {
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const { pages, pageCatalogState } = useDashboardShell();
  const remembered = usePageFilterStore((state) => state.page);
  const rejectedState = usePageFilterStore((state) => state.rejected);
  const setPage = usePageFilterStore((state) => state.setPage);
  const setLastOnePage = usePageFilterStore((state) => state.setLastOnePage);

  const screen = matchScreen(location.pathname)?.screen ?? null;
  const { mode, onePageWay } = screen ? pageFilterOf(screen) : { mode: "none" as const, onePageWay: null };
  const ready = pageCatalogState === "ready";
  const known = (label: string) => !ready || pages.some((page) => page.label === label);

  const raw = search.get("page");
  const applies = mode === "any" || mode === "one";
  const page = !applies ? null
    : raw !== null && raw !== "" ? (known(raw) ? raw : null)
      : remembered !== null && known(remembered) ? remembered : null;
  const item = page === null ? null : pages.find((candidate) => candidate.label === page) ?? null;
  const outOfScope = item !== null && screen?.platforms !== undefined && !screen.platforms.includes(item.platform);

  const select = useCallback((label: string | null) => {
    setPage(label);
    if (label !== null && mode === "one") {
      const picked = pages.find((candidate) => candidate.label === label);
      if (picked?.platform === "fansly") setLastOnePage(label);
    }
    // From the address the browser shows now: the router hands a new address to
    // React in a transition, and a change on top of this render's would undo it.
    const next = new URLSearchParams(window.location.search);
    if (label === null) next.delete("page");
    else next.set("page", label);
    for (const name of RESET_WITH_PAGE) next.delete(name);
    setSearch(next, { state: location.state });
  }, [location.state, mode, pages, setLastOnePage, setPage, setSearch]);

  return {
    screen,
    mode,
    onePageWay,
    page,
    item,
    remembered,
    outOfScope,
    rejected: rejectedState?.pathname === location.pathname ? rejectedState.label : null,
    select,
  };
}

/**
 * Keeps the address and the memory honest, once per screen (the frame runs it):
 * - a remembered label that is gone is forgotten;
 * - a screen that takes a page gets it in its address, so a link says what it shows;
 * - a label the catalog does not have leaves the address, and the screen says so;
 * - a screen that takes no page carries none;
 * - «Статистика» shows one page when the filter says all, without remembering it.
 * Only `replace`: it adds nothing to the history and never writes anything.
 */
export function usePageFilterSync(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const { pages, pageCatalogState } = useDashboardShell();
  const remembered = usePageFilterStore((state) => state.page);
  const lastOnePage = usePageFilterStore((state) => state.lastOnePage);
  const setPage = usePageFilterStore((state) => state.setPage);
  const setRejected = usePageFilterStore((state) => state.setRejected);

  useEffect(() => {
    if (pageCatalogState === "loading") return;
    const screen = matchScreen(location.pathname)?.screen ?? null;
    if (!screen) return;
    const { mode, onePageWay } = pageFilterOf(screen);
    // Without a catalog nothing can be called gone: the server checks anyway.
    const known = (label: string) => pageCatalogState !== "ready" || pages.some((page) => page.label === label);
    if (remembered !== null && !known(remembered)) setPage(null);

    const query = new URLSearchParams(location.search);
    const raw = query.get("page");
    let changed = false;
    if (mode === "all" || mode === "none") {
      if (raw !== null) {
        query.delete("page");
        changed = true;
      }
    } else if (raw !== null && raw !== "" && !known(raw)) {
      setRejected({ label: raw, pathname: location.pathname });
      query.delete("page");
      changed = true;
    } else if (raw === null || raw === "") {
      const scoped = (label: string) => {
        const platform = pages.find((page) => page.label === label)?.platform;
        return platform !== undefined && (!screen.platforms || screen.platforms.includes(platform));
      };
      if (remembered !== null && known(remembered)) {
        query.set("page", remembered);
        changed = true;
      } else if (mode === "one" && onePageWay === "substitute") {
        const substitute = lastOnePage !== null && known(lastOnePage) && scoped(lastOnePage)
          ? lastOnePage
          : pages.find((page) => scoped(page.label))?.label ?? null;
        if (substitute !== null) {
          query.set("page", substitute);
          changed = true;
        }
      }
    }
    if (changed) {
      const text = query.toString();
      navigate({ pathname: location.pathname, search: text ? `?${text}` : "", hash: location.hash }, { replace: true, state: location.state });
    }
  }, [lastOnePage, location.hash, location.pathname, location.search, location.state, navigate, pageCatalogState, pages, remembered, setPage, setRejected]);
}

/**
 * The page of a one-page screen: from the path where it is there, else from the
 * filter (`?page=`). The old one-page screens read it instead of `useParams()`,
 * so they work under both kinds of address.
 */
export function useRoutePageLabel(): string | undefined {
  const { pageLabel } = useParams<{ pageLabel?: string }>();
  const [search] = useSearchParams();
  return pageLabel ?? search.get("page") ?? undefined;
}
