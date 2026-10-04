import type { ReactNode } from "react";
import type { SyncBlocksPage } from "@agency_hub_core/contracts";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { SyncBlockRow } from "../sync/SyncBlockRow.js";
import { SyncPageAttention } from "../sync/SyncPageAttention.js";
import { getBlockOrder } from "../sync/syncBlockDisplay.js";
import { EngineModeChip, EngineQueueTable, EngineStatusGrid } from "./EngineStatus.js";
import { HistoryRequestsBlock, type HistoryRequestsState } from "./HistoryRequests.js";
import type { EngineStatusState } from "./engineDisplay.js";

const STATUS_MISSING: Record<Exclude<EngineStatusState["kind"], "ready">, string> = {
  loading: "Загружаем состояние движка…",
  error: "Состояние движка не загрузилось.",
  idle: "Fansly Sync Engine не читает эту страницу: её ничто не читает.",
};

/** The page's mode as the engine holds it (nothing while it is not known). */
export function EnginePageMode({ state }: { state: EngineStatusState }) {
  const mode = state.kind === "ready" ? state.status.mode : state.kind === "idle" ? state.mode : null;
  return mode === null ? null : <EngineModeChip mode={mode} />;
}

/** What the engine says about a page: the grid and the queue, or why there is
 *  nothing to show. `children` go under the queue (the page's detail adds the
 *  hour's requests by resource). */
export function EnginePageStatusBody({
  state,
  pageLabel,
  aside,
  children,
  now = Date.now(),
}: {
  state: EngineStatusState;
  pageLabel: string;
  aside?: ReactNode;
  children?: ReactNode;
  now?: number;
}) {
  if (state.kind !== "ready") {
    return (
      <>
        <p className={`text-xs ${state.kind === "idle" ? "font-medium text-warning-dark" : "text-text-muted"}`}>
          {STATUS_MISSING[state.kind]}
        </p>
        {aside && <div className="mt-3">{aside}</div>}
      </>
    );
  }
  const { status } = state;
  return (
    <>
      <div className={aside ? "grid gap-x-8 gap-y-3 @2xl:grid-cols-2" : undefined}>
        <EngineStatusGrid status={status} pageLabel={pageLabel} now={now} />
        {aside}
      </div>
      <div className="mt-3">
        <EngineQueueTable status={status} />
      </div>
      {children}
    </>
  );
}

/** A Fansly page on the «Синк» tab: who reads it and how, its five blocks at a
 *  glance, and its open history requests. */
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
  return (
    <article className="@container rounded-xl border border-border bg-card px-5 py-4" data-engine-page={page.pageLabel}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">{page.pageLabel}</span>
          <PlatformBadge platform={page.platform} />
          {page.username && <span className="text-xs text-text-muted">@{page.username}</span>}
          <EnginePageMode state={state} />
        </div>
        <button
          type="button"
          onClick={onSelect}
          className="text-xs font-medium text-accent hover:underline shrink-0"
        >
          Блоки и кнопки &rarr;
        </button>
      </div>

      <SyncPageAttention page={page} />

      <div className="mt-3 border-t border-border pt-3">
        <EnginePageStatusBody
          state={state}
          pageLabel={page.pageLabel}
          now={now}
          aside={(
            <div>
              {getBlockOrder().map((key) => <SyncBlockRow key={key} block={page.blocks[key]} />)}
            </div>
          )}
        />
      </div>

      <div className="mt-3">
        <HistoryRequestsBlock
          state={history}
          limit={2}
          more={(
            <button type="button" onClick={onSelect} className="font-medium text-accent hover:underline">
              все заявки страницы
            </button>
          )}
          now={now}
        />
      </div>
    </article>
  );
}
