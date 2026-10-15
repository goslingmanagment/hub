import { Link } from "react-router";
import { usePageSyncBlocks } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { buildSettingsRoute, syncSettingsTab } from "@/lib/navigation";
import { SyncBlockDetailCard } from "./SyncBlockDetailCard.js";
import { SyncDiagnosisNotice } from "./SyncDiagnosisNotice.js";
import { PageStatusLine, SyncBackButton, SyncPageOnOtherTab, SyncPageTitle } from "./SyncPageParts.js";
import { getBlockOrder, syncPageStatus } from "./syncBlockDisplay.js";

const BACK = "К списку страниц";

/** An OnlyFans page in detail: its status line, then its five blocks with
 *  their buttons. */
export function SyncPageDetail({
  pageLabel,
  onBack,
}: {
  pageLabel: string;
  onBack: () => void;
}) {
  const { data, isLoading, isError, error } = usePageSyncBlocks(pageLabel);

  if (isLoading && !data) {
    return (
      <div>
        <SyncBackButton onBack={onBack} label={BACK} />
        <p className="text-sm text-text-muted">Загружаем страницу…</p>
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div>
        <SyncBackButton onBack={onBack} label={BACK} />
        <StatusPanel
          title="Страница не загрузилась"
          description={error instanceof Error ? error.message : "Состояние страницы получить не удалось."}
          tone="error"
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <SyncBackButton onBack={onBack} label={BACK} />
        <StatusPanel title="Страница не найдена" description={`Страницы ${pageLabel} нет в списке сбора.`} />
      </div>
    );
  }

  const page = data.page;
  const ownTab = syncSettingsTab(page.platform);
  if (ownTab !== "sync") {
    return (
      <div>
        <SyncBackButton onBack={onBack} label={BACK} />
        <SyncPageOnOtherTab pageLabel={pageLabel} tab={ownTab} />
      </div>
    );
  }

  const status = syncPageStatus(page);

  return (
    <div>
      <SyncBackButton onBack={onBack} label={BACK} />
      <div className="mb-5 space-y-2">
        <SyncPageTitle
          page={page}
          actions={status.kind === "login" && (
            <Link to={buildSettingsRoute("credentials")} className="btn btn-primary btn-sm">
              Обновить данные входа
            </Link>
          )}
        />
        <PageStatusLine status={status} />
      </div>
      <div className="space-y-4">
        {isError && data && <StaleDataNotice error={error} />}
        {page.diagnosis && <SyncDiagnosisNotice diagnosis={page.diagnosis} />}
        {getBlockOrder().map((key) => (
          <SyncBlockDetailCard
            key={key}
            block={page.blocks[key]}
            pageLabel={pageLabel}
          />
        ))}
      </div>
    </div>
  );
}
