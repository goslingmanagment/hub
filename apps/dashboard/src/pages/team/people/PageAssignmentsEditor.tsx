import { useId } from "react";
import { Link } from "react-router";
import type { Platform } from "@agency_hub_core/shared";

interface AssignedPageLike {
  id: number;
  label: string;
  platform: Platform;
  modelName: string;
}

interface AvailablePageLike {
  id: number;
  label: string;
  platform: Platform;
  modelName: string;
}

export interface PageAssignmentsLabels {
  assigned: string;
  empty: string;
  unassign: string;
  assignHeading: string;
  select: string;
  assign: string;
}

const PLATFORM_NAME: Readonly<Record<Platform, string>> = { fansly: "Fansly", onlyfans: "OnlyFans", telegram: "Telegram" };

const DEFAULT_LABELS: PageAssignmentsLabels = {
  assigned: "Страницы",
  empty: "Страниц пока нет.",
  unassign: "Снять",
  assignHeading: "Назначить страницу",
  select: "Выберите страницу…",
  assign: "Назначить",
};

export function PageAssignmentsEditor({
  assignedPages,
  availablePages,
  selectedLabel,
  onSelectedLabelChange,
  onAssign,
  onUnassign,
  assignPending,
  unassignPending,
  pagesLoading = false,
  pagesError = false,
  onRetryPages,
  labels = DEFAULT_LABELS,
}: {
  assignedPages: AssignedPageLike[];
  availablePages: AvailablePageLike[];
  selectedLabel: string;
  onSelectedLabelChange: (value: string) => void;
  onAssign: () => void;
  onUnassign: (pageLabel: string) => void;
  assignPending: boolean;
  unassignPending: boolean;
  pagesLoading?: boolean | undefined;
  pagesError?: boolean | undefined;
  onRetryPages?: (() => void) | undefined;
  labels?: PageAssignmentsLabels | undefined;
}) {
  const selectId = useId();
  return (
    <div>
      {assignedPages.length === 0 ? (
        <p className="team-muted">{labels.empty}</p>
      ) : (
        <ul className="team-list team-list-flush">
          {assignedPages.map((page) => (
            <li key={page.id} className="team-list-row">
              <div className="team-list-what">
                <Link to={`/pages/${encodeURIComponent(page.label)}`} className="team-link font-medium">{page.label}</Link>
                <span className="platform-tag">{PLATFORM_NAME[page.platform]}</span>
                <span className="team-muted">{page.modelName}</span>
              </div>
              <button
                type="button"
                disabled={unassignPending || assignPending}
                onClick={() => onUnassign(page.label)}
                className="btn btn-sm"
              >
                {labels.unassign}
              </button>
            </li>
          ))}
        </ul>
      )}

      {pagesLoading && <p role="status" className="team-muted mt-3">Загружаем страницы…</p>}
      {pagesError && (
        <div role="alert" className="notice notice-warning mt-3">
          <div className="notice-body">Список страниц не обновился. Выбор сохранён — обновите список перед назначением.</div>
          {onRetryPages && <div className="notice-action"><button type="button" onClick={onRetryPages} className="btn btn-sm">Повторить</button></div>}
        </div>
      )}

      {availablePages.length > 0 && (
        <div className="mt-4">
          <label htmlFor={selectId} className="field-label">{labels.assignHeading}</label>
          <div className="team-assign">
            <select
              id={selectId}
              value={selectedLabel}
              disabled={pagesLoading || pagesError || assignPending || unassignPending}
              onChange={(event) => onSelectedLabelChange(event.target.value)}
              className="select min-w-0 flex-1"
            >
              <option value="">{labels.select}</option>
              {availablePages.map((page) => (
                <option key={page.id} value={page.label}>
                  {page.label} · {PLATFORM_NAME[page.platform]} · {page.modelName}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!selectedLabel || !availablePages.some((page) => page.label === selectedLabel) || assignPending || unassignPending || pagesLoading || pagesError}
              onClick={onAssign}
              className="btn"
            >
              {labels.assign}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
