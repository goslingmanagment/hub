import { usePageSyncBlocks, useSyncHistoryRequests } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { syncSettingsTab } from "@/lib/navigation";
import { SyncBlockDetailCard } from "../sync/SyncBlockDetailCard.js";
import { SyncDiagnosisNotice } from "../sync/SyncDiagnosisNotice.js";
import { SyncBackButton, SyncPageOnOtherTab, SyncPageTitle } from "../sync/SyncPageParts.js";
import { getBlockOrder } from "../sync/syncBlockDisplay.js";
import { EnginePageMode, EnginePageStatusBody } from "./EnginePageCard.js";
import { EngineSendsByResource } from "./EngineStatus.js";
import { HistoryRequestsBlock } from "./HistoryRequests.js";
import { useEngineStatusOf } from "./useEngineStatusOf.js";

const BACK = "К списку страниц";
/** Requests that ended lately, shown under the open ones. */
const RECENT_CLOSED = 5;

/** A Fansly page in detail: the engine's status with the hour's requests by
 *  resource, every open history request and the ones that ended lately, and
 *  the five blocks with the buttons that act on the engine. */
export function EnginePageDetail({ pageLabel, onBack }: { pageLabel: string; onBack: () => void }) {
  const { data, isLoading, isError, error } = usePageSyncBlocks(pageLabel);
  const statusOf = useEngineStatusOf();
  const own = data !== undefined && syncSettingsTab(data.page.platform) === "engine";
  const open = useSyncHistoryRequests({ pageLabel, state: "open", limit: 200 }, { enabled: own });
  const recent = useSyncHistoryRequests({ pageLabel, limit: 20 }, { enabled: own });

  if (isLoading && !data) {
    return (
      <div>
        <SyncBackButton onBack={onBack} label={BACK} />
        <p className="text-sm text-text-muted">Загружаем страницу…</p>
      </div>
    );
  }

  if (!data) {
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

  const page = data.page;
  if (!own) {
    return (
      <div>
        <SyncBackButton onBack={onBack} label={BACK} />
        <SyncPageOnOtherTab pageLabel={pageLabel} tab={syncSettingsTab(page.platform)} />
      </div>
    );
  }

  const state = statusOf(pageLabel);
  const closed = (recent.data?.requests ?? []).filter((request) => request.state !== "open").slice(0, RECENT_CLOSED);

  return (
    <div>
      <div className="mb-5">
        <SyncBackButton onBack={onBack} label={BACK} />
        <div className="flex flex-wrap items-center gap-2">
          <SyncPageTitle page={page} />
          <EnginePageMode state={state} />
        </div>
      </div>
      <div className="space-y-3">
        {isError && <StaleDataNotice title="Показаны сохранённые данные" error={error} />}
        {page.diagnosis && <SyncDiagnosisNotice diagnosis={page.diagnosis} />}
        <section className="rounded-xl border border-border bg-card px-5 py-4" aria-label="Состояние движка">
          <EnginePageStatusBody state={state} pageLabel={pageLabel}>
            {state.kind === "ready" && (
              <div className="mt-3">
                <EngineSendsByResource status={state.status} />
              </div>
            )}
          </EnginePageStatusBody>
        </section>
        <div className="rounded-xl border border-border bg-card px-5 py-4">
          <HistoryRequestsBlock
            state={{ requests: open.data?.requests, isLoading: open.isLoading, isError: open.isError }}
            closed={closed}
          />
        </div>
        {getBlockOrder().map((key) => (
          <SyncBlockDetailCard key={key} block={page.blocks[key]} pageLabel={pageLabel} />
        ))}
      </div>
    </div>
  );
}
