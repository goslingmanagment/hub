import { Link } from "react-router";
import { useSyncHistoryRequests, useSyncOverview } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { buildSettingsRoute, syncSettingsTab } from "@/lib/navigation";
import { EngineDevCommands } from "./EngineDevCommands.js";
import { EnginePageCard } from "./EnginePageCard.js";
import { engineDevCommands } from "./enginePageSummary.js";
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
        description={error instanceof Error ? error.message : "Состояние сбора получить не удалось."}
        tone="error"
      />
    );
  }

  const visible = data?.pages ?? [];
  const pages = visible.filter((page) => syncSettingsTab(page.platform) === "engine");
  const otherPages = visible.length - pages.length;
  const openRequests = history.data?.requests;

  return (
    <div className="space-y-4">
      {isError && data && <StaleDataNotice title="Показаны сохранённые данные" error={error} />}
      {pages.length === 0 && (
        <StatusPanel
          title="Страниц Fansly нет"
          description={otherPages > 0
            ? "Сбор страницы Fansly начинается с её подключения. Страницы OnlyFans — в разделе «OnlyFans»."
            : "Сбор страницы Fansly начинается с её подключения."}
          action={otherPages > 0
            ? <Link to={buildSettingsRoute("sync")} className="link">Открыть раздел «OnlyFans»</Link>
            : undefined}
        />
      )}
      {openRequests?.length === OPEN_REQUESTS_LIMIT && (
        <p className="text-sm text-text-muted">
          Открытых заявок на историю больше {OPEN_REQUESTS_LIMIT}: показаны самые новые.
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
      <EngineDevCommands
        groups={pages.map((page) => ({ title: page.pageLabel, commands: engineDevCommands(page, statusOf(page.pageLabel)) }))}
      />
    </div>
  );
}
