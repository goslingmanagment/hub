import { Link } from "react-router";

import { usePageSyncBlocks, useSyncHistoryRequests } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { buildPageSectionRoute, buildSettingsRoute, syncSettingsTab } from "@/lib/navigation";
import { PageStatusLine, SyncBackButton, SyncPageOnOtherTab, SyncPageTitle } from "../sync/SyncPageParts.js";
import { EngineBlockCard, EnginePageAttention } from "./EngineBlocks.js";
import { EngineBrowserBlock } from "./EngineBrowser.js";
import { EngineDevCommands } from "./EngineDevCommands.js";
import { EnginePageStatusBody } from "./EnginePageCard.js";
import { EngineSendsByResource } from "./EngineStatus.js";
import { HistoryRequestsBlock } from "./HistoryRequests.js";
import { engineBlockOrder } from "./engineBlockDisplay.js";
import { engineDevCommands, engineHasBrowser, enginePageStatus } from "./enginePageSummary.js";
import { useEngineStatusOf } from "./useEngineStatusOf.js";

const BACK = "К списку страниц";
/** The last requests that ended, shown under the open ones. */
const RECENT_CLOSED = 5;

/** A Fansly page in detail: its status line and the way to a new login;
 *  the five blocks with the buttons that act on the engine; then the
 *  engine's own figures — its status with the hour's requests by resource,
 *  the browser, every open history request and the last ones that ended. */
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
  const status = enginePageStatus(page, state);
  const loginNeeded = status.kind === "login";
  const closed = (recent.data?.requests ?? []).filter((request) => request.state !== "open").slice(0, RECENT_CLOSED);
  const browserLogin = buildPageSectionRoute(pageLabel, "browser-login");

  return (
    <div>
      <SyncBackButton onBack={onBack} label={BACK} />
      <div className="mb-5 space-y-2">
        <SyncPageTitle
          page={page}
          actions={(
            <>
              {loginNeeded && !engineHasBrowser(state) && (
                <Link to={buildSettingsRoute("credentials")} className="btn btn-primary btn-sm">
                  Обновить данные входа
                </Link>
              )}
              {/* Project Browser PR 15: the page's server browser and its login. */}
              <Link
                to={browserLogin}
                className={loginNeeded && engineHasBrowser(state) ? "btn btn-primary btn-sm" : "btn btn-sm"}
                data-browser-login-entry="true"
              >
                Вход в браузер
              </Link>
            </>
          )}
        />
        <PageStatusLine status={status} />
      </div>
      <div className="space-y-4">
        {isError && <StaleDataNotice title="Показаны сохранённые данные" error={error} />}
        <EnginePageAttention page={page} />
        {engineBlockOrder().map((key) => (
          <EngineBlockCard key={key} block={page.blocks[key]} pageLabel={pageLabel} />
        ))}
        <section className="card" aria-label="Состояние сбора">
          <div className="card-header">
            <div>
              <h4 className="card-title">Состояние сбора</h4>
              <p className="card-description">Обработчик, удержания, канал событий и очередь страницы.</p>
            </div>
          </div>
          <div className="card-body">
            <EnginePageStatusBody state={state}>
              {state.kind === "ready" && <EngineSendsByResource status={state.status} />}
            </EnginePageStatusBody>
          </div>
        </section>
        {/* Only a page with a browser (Project Browser PR 17), PR 15's
            login beside its «Вход» line. */}
        {state.kind === "ready" && state.status.browser !== undefined && (
          <EngineBrowserBlock
            browser={state.status.browser}
            pageLabel={pageLabel}
            loginAction={
              <Link to={browserLogin} className="link whitespace-nowrap" data-browser-login-link="true">
                Войти в браузер&nbsp;&rarr;
              </Link>
            }
          />
        )}
        <section className="card card-body">
          <HistoryRequestsBlock
            state={{ requests: open.data?.requests, isLoading: open.isLoading, isError: open.isError }}
            closed={closed}
          />
        </section>
        <EngineDevCommands groups={[{ title: null, commands: engineDevCommands(page, state) }]} />
      </div>
    </div>
  );
}
