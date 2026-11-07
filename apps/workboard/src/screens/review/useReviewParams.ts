import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { REVIEW_FILTERS, type ReviewFilter } from "./data.js";

/**
 * Everything chosen on «Разбор смены» lives in the address, so a link opens the
 * same place (spec §4.2):
 *   `chat`  the open chat (its key);
 *   `show`  the list: look (default, absent) · unanswered · waited · paid · all;
 *   `q`     the search words;
 *   `span`  minutes picked on the pulse, from the shift's start: `95-135`;
 *   `msg`   the message whose evidence is open;
 *   `page`  the app's page filter (usePageFilter's `?page=`), carried from the screen the shift was opened on.
 * Changes replace the address: stepping through chats does not fill the history.
 */
export interface ReviewParams {
  chat: string | null;
  show: ReviewFilter;
  q: string;
  /** Minutes from the shift's start. */
  span: { from: number; to: number } | null;
  msg: string | null;
  page: string | null;
}

export type ReviewChange = Partial<{
  chat: string | null;
  show: ReviewFilter;
  q: string;
  span: { from: number; to: number } | null;
  msg: string | null;
  page: string | null;
}>;

export function useReviewParams(): [ReviewParams, (change: ReviewChange) => void] {
  const [search, setSearch] = useSearchParams();
  const params = useMemo<ReviewParams>(() => {
    const show = search.get("show");
    const span = /^(\d+)-(\d+)$/.exec(search.get("span") ?? "");
    const page = search.get("page");
    return {
      chat: search.get("chat"),
      show: show !== null && (REVIEW_FILTERS as readonly string[]).includes(show) ? show as ReviewFilter : "look",
      q: search.get("q") ?? "",
      span: span === null || Number(span[1]) >= Number(span[2]) ? null : { from: Number(span[1]), to: Number(span[2]) },
      msg: search.get("msg"),
      page: page && page !== "all" ? page : null,
    };
  }, [search]);

  const update = useCallback((change: ReviewChange) => {
    setSearch((before) => {
      const next = new URLSearchParams(before);
      const put = (key: string, value: string | null | undefined) => {
        if (value === undefined) return;
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      };
      if ("chat" in change) put("chat", change.chat);
      if ("show" in change) put("show", change.show === "look" ? null : change.show);
      if ("q" in change) put("q", change.q);
      if ("span" in change) put("span", change.span ? `${change.span.from}-${change.span.to}` : null);
      if ("msg" in change) put("msg", change.msg);
      if ("page" in change) put("page", change.page);
      return next;
    }, { replace: true });
  }, [setSearch]);

  return [params, update];
}
