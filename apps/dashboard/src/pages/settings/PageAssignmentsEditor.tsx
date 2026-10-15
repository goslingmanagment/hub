import { useId } from "react";
import { PlatformBadge } from "@/components/shared/PlatformBadge";

interface AssignedPageLike {
  id: number;
  label: string;
  platform: "fansly" | "onlyfans";
  modelName: string;
}

interface AvailablePageLike {
  id: number;
  label: string;
  platform: "fansly" | "onlyfans";
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

const PLATFORM_NAME = { fansly: "Fansly", onlyfans: "OnlyFans" } as const;

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
      <h3 className="card-title mb-2">{labels.assigned}</h3>
      {assignedPages.length === 0 ? (
        <p className="text-sm text-text-secondary">{labels.empty}</p>
      ) : (
        <ul className="divide-y divide-border-light rounded-lg border border-border">
          {assignedPages.map((page) => (
            <li key={page.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-text-primary">
                <span className="font-medium">{page.label}</span>
                <PlatformBadge platform={page.platform} />
                <span className="text-text-secondary">{page.modelName}</span>
              </div>
              <button
                type="button"
                disabled={unassignPending || assignPending}
                onClick={() => onUnassign(page.label)}
                className="btn btn-ghost btn-sm"
              >
                {labels.unassign}
              </button>
            </li>
          ))}
        </ul>
      )}

      {pagesLoading && <p role="status" className="mt-3 text-sm text-text-secondary">Загружаем страницы…</p>}
      {pagesError && (
        <div role="alert" className="notice notice-danger mt-3 flex-wrap items-center">
          <span className="min-w-0 flex-1">Список страниц не обновился. Выбор сохранён — обновите список перед назначением.</span>
          {onRetryPages && <button type="button" onClick={onRetryPages} className="btn btn-sm">Повторить</button>}
        </div>
      )}

      {availablePages.length > 0 && (
        <div className="mt-4">
          <label htmlFor={selectId} className="field-label">{labels.assignHeading}</label>
          <div className="flex gap-2">
            <select
              id={selectId}
              value={selectedLabel}
              disabled={pagesLoading || pagesError || assignPending || unassignPending}
              onChange={(event) => onSelectedLabelChange(event.target.value)}
              className="select flex-1"
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
