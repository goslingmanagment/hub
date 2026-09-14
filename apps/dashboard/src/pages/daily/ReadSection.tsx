import type { ReactNode } from "react";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";

export type SectionQuery = {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  refetch: () => unknown;
};

// Each page panel owns a separate read. An absent response cannot authorize
// zero money, an empty audience, or an empty transaction history.
export function ReadSection({ title, query, children }: {
  title: string;
  query: SectionQuery;
  children: ReactNode;
}) {
  if (query.data == null) {
    if (query.isError) {
      return (
        <div className="mb-4">
          <StatusPanel
            title={`${title}: не удалось загрузить`}
            description="Отсутствие ответа не означает отсутствие записей."
            tone="error"
            action={<button type="button" className="text-accent" onClick={() => void query.refetch()}>Повторить</button>}
          />
        </div>
      );
    }
    return <div className="mb-4" aria-label={`Загрузка: ${title}`}><TableSkeleton rows={3} columns={4} /></div>;
  }
  return <><QueryNotice error={query.isError} stale retry={query.refetch} />{children}</>;
}
