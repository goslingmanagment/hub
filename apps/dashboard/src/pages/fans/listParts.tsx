import { useCallback, useRef, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { useAuthMe } from "@/api/queries";
import { useOfapiStatus } from "@/api/waiting";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { usePageFilter } from "@/components/layout/usePageFilter";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { OFAPI_FEED_NOTE, type OfapiStatus } from "@/lib/statusWords";
import { keepAllPages } from "@/lib/pageParam";

/** The viewer's flag of the OnlyFans API: a team lead's is unknown, and nothing is claimed then. */
export function useViewerOfapi(): { role: "owner" | "team_lead"; ofapi: OfapiStatus } {
  const { data } = useAuthMe();
  const role = data?.user.role === "owner" ? "owner" : "team_lead";
  return { role, ofapi: useOfapiStatus(role) };
}

/** A change of the list's own parameters; the position resets unless asked. Stable across renders. */
export function useListParams() {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const latest = useRef({ setSearch, state: location.state as unknown });
  latest.current = { setSearch, state: location.state as unknown };
  const update = useCallback((changes: Readonly<Record<string, string | null>>, options: { keepPosition?: boolean } = {}) => {
    latest.current.setSearch((previous) => {
      const next = keepAllPages(previous, new URLSearchParams(previous));
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      if (!options.keepPosition && !("offset" in changes)) next.delete("offset");
      return next;
    }, { replace: true, state: latest.current.state });
  }, []);
  return { search, update };
}

/** The page of the list, whatever the filter says, by the catalog. */
export function usePlatformOfPage(pageLabel: string | null | undefined) {
  const { findPageByLabel } = useDashboardShell();
  return pageLabel ? findPageByLabel(pageLabel)?.platform ?? null : null;
}

/** A chosen Telegram page: said, never another page in its place. */
export function TelegramPanel() {
  const filter = usePageFilter();
  return (
    <StatusPanel
      title="Hub не собирает данные Telegram"
      action={<button type="button" className="btn btn-sm" onClick={() => filter.select(null)}>Все страницы</button>}
    />
  );
}

/** First load, no answer, or the list. If rows were there they stay, under a notice. */
export function ListGate({ query, columns, children }: {
  query: { data: unknown; isLoading: boolean; isError: boolean; refetch: () => unknown; dataUpdatedAt?: number };
  columns: number;
  children: ReactNode;
}) {
  if (query.data === undefined || query.data === null) {
    if (query.isError) return <NoAnswerPanel retry={query.refetch} />;
    return <TableSkeleton rows={8} columns={columns} />;
  }
  return (
    <>
      <QueryNotice error={query.isError} stale retry={query.refetch} at={query.dataUpdatedAt} />
      {children}
    </>
  );
}

/** Rows that were asked for past the end of the list. */
export function PastTheEnd({ colSpan, onBack }: { colSpan: number; onBack: () => void }) {
  return (
    <tr>
      <td colSpan={colSpan} className="fan-empty-row">
        <EmptyInside title="На этой странице списка записей нет." action={<button type="button" className="btn btn-sm" onClick={onBack}>К началу списка</button>} />
      </td>
    </tr>
  );
}

/** The one row of an empty table. */
export function EmptyRow({ colSpan, title, description, action }: { colSpan: number; title: string; description?: string; action?: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="fan-empty-row">
        <EmptyInside title={title} description={description} action={action} />
      </td>
    </tr>
  );
}

function EmptyInside({ title, description, action }: { title: string; description?: string | undefined; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {description && <p className="empty-text">{description}</p>}
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}

/** A switched-off API: what is frozen is grey, the feed goes on. */
export function FeedNote() {
  return <p className="fan-footnote">{OFAPI_FEED_NOTE}</p>;
}
