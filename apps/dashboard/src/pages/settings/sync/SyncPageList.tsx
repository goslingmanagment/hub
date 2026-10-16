import type { SyncBlocksPage } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { useSyncOverview } from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { buildSettingsRoute, syncSettingsTab } from "@/lib/navigation";
import { SyncBlockRow } from "./SyncBlockRow.js";
import { SyncPageAttention } from "./SyncPageAttention.js";
import { PageStatusLine } from "./SyncPageParts.js";
import { getBlockOrder, syncPageStatus } from "./syncBlockDisplay.js";

/** An OnlyFans page in the list: one status line and its main action first,
 *  then what needs the owner and its five blocks at a glance. */
function PageCard({
  page,
  onSelect,
}: {
  page: SyncBlocksPage;
  onSelect: () => void;
}) {
  const status = syncPageStatus(page);
  return (
    <article className="card" data-sync-page={page.pageLabel}>
      <div className="card-header">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="card-title">{page.pageLabel}</h3>
          <PlatformBadge platform={page.platform} />
          {page.username && <span className="text-sm text-text-muted">@{page.username}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status.kind === "login" && (
            <Link to={buildSettingsRoute("credentials")} className="btn btn-primary btn-sm">
              Обновить данные входа
            </Link>
          )}
          <button type="button" onClick={onSelect} className="btn btn-sm">
            Открыть
          </button>
        </div>
      </div>

      <div className="card-body space-y-3">
        <PageStatusLine status={status} />
        <SyncPageAttention page={page} />
        <div className="border-t border-border-light pt-2">
          {getBlockOrder().map((key) => (
            <SyncBlockRow key={key} block={page.blocks[key]} />
          ))}
        </div>
      </div>
    </article>
  );
}

/** The OnlyFans pages (those of the legacy page-sync executor) with their five blocks. */
export function SyncPageList({
  onSelectPage,
}: {
  onSelectPage: (pageLabel: string) => void;
}) {
  const { data, isLoading, isError, error } = useSyncOverview();

  if (isLoading && !data) {
    return <p className="text-sm text-text-muted">Загружаем страницы…</p>;
  }

  if (isError && !data) {
    return (
      <StatusPanel
        title="Состояние сбора не загрузилось"
        description={error instanceof Error ? error.message : "Список страниц получить не удалось."}
        tone="error"
      />
    );
  }

  const visible = data?.pages ?? [];
  const pages = visible.filter((page) => syncSettingsTab(page.platform) === "sync");
  // A page's diagnosis is said on its own card: the overview's own one is
  // that of its first page in trouble, of either platform.
  const otherPages = visible.length - pages.length;

  return (
    <div className="space-y-4">
      {isError && data && <StaleDataNotice error={error} />}
      {pages.length === 0 && (
        <StatusPanel
          title="Страниц OnlyFans нет"
          description={otherPages > 0
            ? "Здесь показан сбор страниц OnlyFans. Страницы Fansly — в разделе «Fansly»."
            : "Добавьте страницу, и здесь появится её сбор данных."}
          action={otherPages > 0
            ? <Link to={buildSettingsRoute("engine")} className="link">Открыть раздел «Fansly»</Link>
            : undefined}
        />
      )}
      {pages.map((page) => (
        <PageCard
          key={page.pageId}
          page={page}
          onSelect={() => onSelectPage(page.pageLabel)}
        />
      ))}
    </div>
  );
}
