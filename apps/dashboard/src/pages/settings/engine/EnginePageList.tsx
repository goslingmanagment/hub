import { Link } from "react-router";
import { useSyncHistoryRequests, useSyncOverview } from "@/api/queries";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { buildSettingsRoute, syncSettingsTab } from "@/lib/navigation";
import { EnginePageCard } from "./EnginePageCard.js";
import { useEngineStatusOf } from "./useEngineStatusOf.js";

/** The server's cap of one history-request read (`limit` ≤ 200). */
const OPEN_REQUESTS_LIMIT = 200;

/** Every Fansly page as the Fansly Sync Engine reads it. */
export function EnginePageList({ onSelectPage }: { onSelectPage: (pageLabel: string) => void }) {
  const { data, isLoading, isError, error } = useSyncOverview();
  const statusOf = useEngineStatusOf();
  const history = useSyncHistoryRequests({ state: "open", limit: OPEN_REQUESTS_LIMIT });

  if (isLoading && !data) {
    return <p className="text-sm text-text-muted">Загружаем страницы…</p>;
  }

  if (isError && !data) {
    return (
      <StatusPanel
        title="Страницы не загрузились"
        description={error instanceof Error ? error.message : "Состояние синхронизации получить не удалось."}
        tone="error"
      />
    );
  }

  const visible = data?.pages ?? [];
  const pages = visible.filter((page) => syncSettingsTab(page.platform) === "engine");
  const openRequests = history.data?.requests;

  return (
    <div className="space-y-3">
      {isError && data && <StaleDataNotice title="Показаны сохранённые данные" error={error} />}
      {pages.length === 0 && (
        <EmptyState
          title="Страниц Fansly нет"
          description="Fansly Sync Engine читает страницу Fansly с момента её подключения."
        />
      )}
      {openRequests?.length === OPEN_REQUESTS_LIMIT && (
        <p className="text-xs text-warning-dark">
          Открытых заявок больше {OPEN_REQUESTS_LIMIT}: показаны самые новые.
        </p>
      )}
      {pages.map((page) => (
        <EnginePageCard
          key={page.pageId}
          page={page}
          state={statusOf(page.pageLabel)}
          history={{
            requests: openRequests?.filter((request) => request.pageLabel === page.pageLabel),
            isLoading: history.isLoading,
            isError: history.isError,
          }}
          onSelect={() => onSelectPage(page.pageLabel)}
        />
      ))}
      {visible.length > pages.length && (
        <p className="text-xs text-text-secondary">
          Остальные страницы ({visible.length - pages.length}) — на вкладке{" "}
          <Link to={buildSettingsRoute("sync")} className="font-semibold text-accent hover:underline">
            «Синхронизация»
          </Link>
          .
        </p>
      )}
    </div>
  );
}
