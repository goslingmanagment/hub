import type { ReactNode } from "react";
import type { SyncBlocksPage } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { buildPageSectionRoute, buildSettingsRoute } from "@/lib/navigation";
import { PageStatusLine, type PageStatus } from "../sync/SyncPageParts.js";
import { EngineBlockRow, EnginePageAttention } from "./EngineBlocks.js";
import { EngineBrowserBlock } from "./EngineBrowser.js";
import { EngineModeChip, EngineQueueTable, EngineStatusGrid } from "./EngineStatus.js";
import { engineBlockOrder } from "./engineBlockDisplay.js";
import { HistoryRequestsBlock, type HistoryRequestsState } from "./HistoryRequests.js";
import type { EngineStatusState } from "./engineDisplay.js";
import { engineHasBrowser, enginePageStatus } from "./enginePageSummary.js";

const STATUS_MISSING: Record<Exclude<EngineStatusState["kind"], "ready">, string> = {
  loading: "Загружаем состояние сбора…",
  error: "Состояние сбора не загрузилось.",
  idle: "Сбор Fansly эту страницу не читает: её ничто не читает.",
};

/** The page's mode as the engine holds it, with whether a processing host
 *  runs it (nothing while it is not known). */
export function EnginePageMode({ state }: { state: EngineStatusState }) {
  if (state.kind === "ready") return <EngineModeChip mode={state.status.mode} ownerRunning={state.status.owner.running} />;
  return state.kind === "idle" && state.mode !== null ? <EngineModeChip mode={state.mode} ownerRunning={false} /> : null;
}

/** What the engine says about a page: the grid and the queue, or why there is
 *  nothing to show. `children` go under the queue (the page's detail adds the
 *  hour's requests by resource). */
export function EnginePageStatusBody({
  state,
  children,
  now = Date.now(),
}: {
  state: EngineStatusState;
  children?: ReactNode;
  now?: number;
}) {
  if (state.kind !== "ready") {
    return (
      <div className="space-y-2">
        <p className={`text-sm ${state.kind === "idle" ? "font-medium text-warning-dark" : "text-text-muted"}`}>
          {STATUS_MISSING[state.kind]}
        </p>
        {state.kind === "idle" && <EnginePageMode state={state} />}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <EngineStatusGrid status={state.status} now={now} />
      <EngineQueueTable status={state.status} />
      {children}
    </div>
  );
}

/** The page's main action: its browser login when Fansly wants a new one on
 *  a page with a browser, the credentials form when Fansly refuses the ones
 *  saved, else nothing (the card's own «Открыть» is enough). */
export function EnginePageMainAction({ pageLabel, status, state }: {
  pageLabel: string;
  status: PageStatus;
  state: EngineStatusState;
}) {
  if (status.kind !== "login") return null;
  return engineHasBrowser(state)
    ? (
      <Link to={buildPageSectionRoute(pageLabel, "browser-login")} className="btn btn-primary btn-sm" data-browser-login-entry="true">
        Вход в браузер
      </Link>
    )
    : (
      <Link to={buildSettingsRoute("credentials")} className="btn btn-primary btn-sm">
        Обновить данные входа
      </Link>
    );
}

/** A Fansly page in the list: one status line and its main action first;
 *  then what needs the owner, its five blocks at a glance and its browser;
 *  the engine's own figures — the host, holds, channel, queue and history
 *  requests — under «Подробнее». */
export function EnginePageCard({
  page,
  state,
  history,
  onSelect,
  now = Date.now(),
}: {
  page: SyncBlocksPage;
  state: EngineStatusState;
  history: HistoryRequestsState;
  onSelect: () => void;
  now?: number;
}) {
  const status = enginePageStatus(page, state, now);
  const open = history.requests?.filter((request) => request.state === "open").length ?? 0;
  return (
    <article className="@container card" data-engine-page={page.pageLabel}>
      <div className="card-header">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="card-title">{page.pageLabel}</h3>
          <PlatformBadge platform={page.platform} />
          {page.username && <span className="text-sm text-text-muted">@{page.username}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <EnginePageMainAction pageLabel={page.pageLabel} status={status} state={state} />
          <button type="button" onClick={onSelect} className="btn btn-sm">
            Открыть
          </button>
        </div>
      </div>

      <div className="card-body space-y-3">
        <PageStatusLine status={status} />
        <EnginePageAttention page={page} now={now} />

        <div className="border-t border-border-light pt-2">
          {engineBlockOrder().map((key) => <EngineBlockRow key={key} block={page.blocks[key]} now={now} />)}
        </div>

        {/* Only a page with a browser (Project Browser PR 17). */}
        {state.kind === "ready" && state.status.browser !== undefined && (
          <EngineBrowserBlock browser={state.status.browser} pageLabel={page.pageLabel} compact now={now} />
        )}

        <details className="help">
          <summary>
            Подробнее{open > 0 ? ` · заявок на историю: ${open}` : ""}
          </summary>
          <div className="mt-3 space-y-4">
            <EnginePageStatusBody state={state} now={now} />
            <HistoryRequestsBlock
              state={history}
              limit={2}
              more={(
                <button type="button" onClick={onSelect} className="link">
                  все заявки страницы
                </button>
              )}
              now={now}
            />
          </div>
        </details>
      </div>
    </article>
  );
}
