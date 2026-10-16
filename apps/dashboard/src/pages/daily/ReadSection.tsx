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

/** What the section looks like while its read is in flight. */
export type SectionSkeleton = "table" | "stats" | "text";

// Each page panel owns a separate read. An absent response cannot authorize
// zero money, an empty audience, or an empty transaction history.
export function ReadSection({ title, query, skeleton = "table", children }: {
  title: string;
  query: SectionQuery;
  skeleton?: SectionSkeleton | undefined;
  children: ReactNode;
}) {
  if (query.data == null) {
    if (query.isError) {
      return (
        <StatusPanel
          title={`${title}: не удалось загрузить`}
          description="Данные не пришли — это не значит, что записей нет."
          tone="error"
          action={<button type="button" onClick={() => void query.refetch()}>Повторить</button>}
        />
      );
    }
    return (
      <div aria-label={`Загружаем: ${title}`} aria-busy="true">
        <SectionPlaceholder kind={skeleton} />
      </div>
    );
  }
  return <><QueryNotice error={query.isError} stale retry={query.refetch} />{children}</>;
}

function SectionPlaceholder({ kind }: { kind: SectionSkeleton }) {
  if (kind === "stats") {
    return (
      <div className="stat-grid">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="stat">
            <div className="h-3 w-20 rounded bg-hover animate-pulse" />
            <div className="mt-3 h-7 w-24 rounded bg-hover animate-pulse" style={{ animationDelay: `${i * 100}ms` }} />
          </div>
        ))}
      </div>
    );
  }
  if (kind === "text") {
    return (
      <div className="space-y-2.5 py-1">
        {[92, 78, 85, 60].map((width, i) => (
          <div key={i} className="h-3.5 rounded bg-hover animate-pulse" style={{ width: `${width}%`, animationDelay: `${i * 80}ms` }} />
        ))}
      </div>
    );
  }
  return <TableSkeleton rows={3} columns={4} />;
}
