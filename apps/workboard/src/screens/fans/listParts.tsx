import { type ReactNode } from "react";
export { useViewerOfapi } from "@/screens/fans/frame";
import { NoAnswerPanel } from "@agency_hub_core/ui/console/StatusPanel";
import { QueryNotice } from "@agency_hub_core/ui/console/QueryNotice";
import { TableSkeleton } from "@agency_hub_core/ui/console/TableSkeleton";
export { useListParams } from "@agency_hub_core/ui/console/listParams";
import { OFAPI_FEED_NOTE } from "@agency_hub_core/ui/console/statusWords";



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
